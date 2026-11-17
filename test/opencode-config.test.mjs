import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { configPaths, editConfig, parseConfig } from '../src/lib/opencode-config.mjs'

const sync = fileURLToPath(new URL('../src/sync.mjs', import.meta.url))

test('JSONC preserves strings, comments and unrelated nested settings', () => {
  const text = `{
  // keep this comment
  "providers": {
    "other": { "settings": { "baseURL": "https://example.test/a//b", "apiKey": "test-key" } },
  },
  "instructions": ["/* not a comment */", "comma,}",],
}`
  const updated = editConfig(text, ['providers', 'venice-web'], { name: 'Venice', models: { 'a/b': {} } })
  const config = parseConfig(updated)
  assert.equal(config.providers.other.settings.apiKey, 'test-key')
  assert.equal(config.providers.other.settings.baseURL, 'https://example.test/a//b')
  assert.deepEqual(config.instructions, ['/* not a comment */', 'comma,}'])
  assert.ok(updated.includes('// keep this comment'))
  assert.ok(updated.includes('"other": { "settings": { "baseURL": "https://example.test/a//b", "apiKey": "test-key" } }'))
  assert.deepEqual(config.providers['venice-web'].models, { 'a/b': {} })
})

for (const source of ['{}', '{"a":1}', '{"a":1,}', '{/*empty*/}', '{"a":{"b":2},"z":[1,2,],}']) {
  test(`JSONC inserts, replaces and deletes paths: ${source}`, () => {
    let text = editConfig(source, ['providers', 'venice-web'], { enabled: true })
    assert.equal(parseConfig(text).providers['venice-web'].enabled, true)
    text = editConfig(text, ['providers', 'venice-web'], { enabled: false })
    assert.equal(parseConfig(text).providers['venice-web'].enabled, false)
    text = editConfig(text, ['providers', 'venice-web'], undefined)
    assert.equal(parseConfig(text).providers['venice-web'], undefined)
    text = editConfig(text, ['providers'], undefined)
    assert.deepEqual(parseConfig(text), parseConfig(source))
    assert.equal(editConfig(text, ['missing', 'child'], undefined), text)
  })
}

test('JSONC deletes first, middle, last and only object members safely', () => {
  for (const text of ['{"a":1,"b":2,"c":3}', '{"a":1,"b":2,"c":3,}', '{"a":1}']) {
    for (const key of Object.keys(parseConfig(text))) {
      const expected = parseConfig(text)
      delete expected[key]
      assert.deepEqual(parseConfig(editConfig(text, [key], undefined)), expected)
    }
  }
  assert.throws(() => parseConfig('[]'), /must be an object/)
  assert.throws(() => parseConfig('{"broken":'), SyntaxError)
  assert.throws(() => editConfig('{"providers":false}', ['providers', 'venice'], {}), /must be an object/)
})

test('sync updates/removes every global JSON and JSONC entry without shadow conflicts', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-config-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'opencode')
  mkdirSync(root)
  const json = path.join(root, 'opencode.json')
  const jsonc = path.join(root, 'opencode.jsonc')
  writeFileSync(json, '{"providers":{"venice-web":{"settings":{"baseURL":"http://old"}}},"model":"other/model"}')
  writeFileSync(jsonc, '{// user comment\n"providers":{"other":{"models":{}},"venice-web":{"models":{}}},}')
  const env = { ...process.env, XDG_CONFIG_HOME: dir, VENICE_WEB_PROVIDER_ID: 'venice-web', VENICE_WEB_PORT: '4567' }
  delete env.OPENCODE_CONFIG
  assert.deepEqual(configPaths(undefined, env), [json, jsonc])
  for (const args of [[], ['--remove']]) {
    const result = spawnSync(process.execPath, [sync, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    for (const file of [json, jsonc]) {
      const provider = parseConfig(readFileSync(file, 'utf8')).providers['venice-web']
      if (args.length) assert.equal(provider, undefined)
      else {
        assert.equal(provider.settings.baseURL, 'http://127.0.0.1:4567/v1')
        assert.equal(Object.keys(provider.models).length, 30)
      }
    }
    assert.ok(readFileSync(jsonc, 'utf8').includes('// user comment'))
    assert.equal(parseConfig(readFileSync(json, 'utf8')).model, 'other/model')
  }
})

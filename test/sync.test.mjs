import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL, modelIds } from '../src/lib/models.mjs'

const sync = fileURLToPath(new URL('../src/sync.mjs', import.meta.url))

test('sync writes native V2 providers, preserves unrelated settings and removes only its legacy entry', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-sync-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'opencode.json')
  const other = { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://example.invalid/v1' } }
  writeFileSync(file, JSON.stringify({
    provider: { 'venice-web': { npm: 'legacy' }, other: { name: 'legacy other' } },
    providers: { other },
    model: 'other/model',
    agents: { title: { description: 'keep me' }, review: { model: 'other/review' } },
  }))
  const run = (...args) => {
    const result = spawnSync(process.execPath, [sync, '--config', file, ...args], {
      encoding: 'utf8', env: { ...process.env, VENICE_WEB_PORT: '4567', VENICE_WEB_PROVIDER_ID: 'venice-web' },
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const config = run()
  assert.equal(config.model, 'other/model')
  assert.deepEqual(config.providers.other, other)
  assert.deepEqual(config.provider.other, { name: 'legacy other' })
  assert.equal(config.provider['venice-web'], undefined)
  const provider = config.providers['venice-web']
  assert.equal(provider.package, '@opencode/ai/providers/openai-compatible')
  assert.equal(provider.settings.baseURL, 'http://127.0.0.1:4567/v1')
  assert.deepEqual(Object.keys(provider.models), modelIds)
  assert.equal(provider.models['qwen3-5-35b-a3b'].capabilities.tools, true)
  assert.deepEqual(provider.models['qwen3-5-35b-a3b'].capabilities.input, ['text', 'image'])
  assert.equal(provider.models['z-image-turbo'], undefined)
  assert.equal(provider.models[DEFAULT_MODEL].tool_call, undefined)
  const defaults = run('--default')
  assert.equal(defaults.model, `venice-web/${DEFAULT_MODEL}`)
  assert.equal(defaults.agents.title.model, `venice-web/${DEFAULT_SMALL_MODEL}`)
  assert.equal(defaults.agents.title.description, 'keep me')
  assert.equal(defaults.small_model, undefined)
  const removed = run('--remove')
  assert.equal(removed.providers['venice-web'], undefined)
  assert.deepEqual(removed.providers.other, other)
  assert.equal(removed.model, undefined)
  assert.equal(removed.agents.title.model, undefined)
  assert.equal(removed.agents.title.description, 'keep me')
  assert.equal(removed.agents.review.model, 'other/review')
})

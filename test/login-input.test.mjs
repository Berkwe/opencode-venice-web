import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const login = fileURLToPath(new URL('../src/login.mjs', import.meta.url))

for (const input of ['not JSON', '{}', '{"cookie":"private-test-value","userAgent":""}']) {
  test(`stdin login rejects malformed or incomplete input (${input.length} bytes) without leaking it`, () => {
    const result = spawnSync(process.execPath, [login, '--stdin'], { input, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /login input/)
    assert.doesNotMatch(result.stdout + result.stderr, /private-test-value/)
  })
}

test('Windows login explains manual sign-in instead of attempting Linux browser discovery', {
  skip: process.platform !== 'win32',
}, () => {
  const result = spawnSync(process.execPath, [login], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /DPAPI\/App-Bound/)
  assert.match(result.stderr, /login\.ps1/)
})

for (const mode of ['stdin', 'token', 'menu', 'token-override', 'cookie']) test(`${mode} login stores a verified session and syncs the provider (mock Clerk, no network)`, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-login-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const preload = `
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith('https://clerk.venice.ai/')) throw new Error('unexpected host');
      const body = String(url).includes('/tokens')
        ? { jwt: 'header.' + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url') + '.signature' }
        : { response: { sessions: [{ id: 'session-test', status: 'active', user: { id: 'user-test' } }] } };
      return Response.json(body);
    };
  `
  const input = JSON.stringify({ cookie: '__client=private-test-value', userAgent: 'Windows test UA' })
  if (mode !== 'stdin') {
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ userAgent: 'Stored browser UA' }))
  }
  const args = mode === 'token-override' ? ['--token', '--ua', 'Custom browser UA']
    : mode === 'cookie' ? ['--cookie', '__client=private-test-value']
    : [`--${mode}`]
  const piped = mode === 'stdin' ? input : mode === 'menu' ? '1\n__client=private-test-value\n' : '__client=private-test-value\n'
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, login, ...args,
  ], { input: piped, encoding: 'utf8', env: {
    ...process.env,
    VENICE_WEB_SESSION: path.join(dir, 'session.json'),
    OPENCODE_CONFIG: path.join(dir, 'opencode.json'),
  } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /private-test-value|header\./)
  const session = JSON.parse(readFileSync(path.join(dir, 'session.json'), 'utf8'))
  assert.equal(session.client, 'private-test-value')
  assert.equal(session.userAgent, mode === 'stdin' ? 'Windows test UA' : mode === 'token-override' ? 'Custom browser UA' : 'Stored browser UA')
  assert.equal(session.sessionId, 'session-test')
  const config = JSON.parse(readFileSync(path.join(dir, 'opencode.json'), 'utf8'))
  assert.equal(config.providers['venice-web'].package, '@opencode/ai/providers/openai-compatible')
  assert.ok(Object.keys(config.providers['venice-web'].models).length > 0)
})

test('token prompt handles EOF without hanging or contacting Clerk', () => {
  const result = spawnSync(process.execPath, [login, '--token'], { input: '', encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1, result.error?.message)
  assert.match(result.stderr, /input closed/)
})

test('menu rejects an unknown choice without contacting Clerk', () => {
  const result = spawnSync(process.execPath, [login, '--menu'], { input: '9\n', encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1, result.error?.message)
  assert.match(result.stderr, /invalid sign-in choice/)
})

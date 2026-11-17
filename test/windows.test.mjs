import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const root = fileURLToPath(new URL('../', import.meta.url))
const windows = { skip: process.platform !== 'win32', timeout: 30_000 }
const powershell = 'powershell.exe'

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice windows test '))
  const env = {
    ...process.env,
    OPENCODE_CONFIG: path.join(dir, 'opencode.json'),
    VENICE_WEB_CONFIG_DIR: path.join(dir, 'private'),
    VENICE_WEB_SESSION: path.join(dir, 'private', 'session.json'),
    VENICE_WEB_PROVIDER_ID: 'venice-web',
    VENICE_WEB_HOST: '127.0.0.1',
  }
  mkdirSync(env.VENICE_WEB_CONFIG_DIR)
  const scope = { dir, env, stop: async () => {} }
  t.after(async () => {
    await scope.stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return scope
}

test('Windows installer configures a checkout from a different directory without touching real settings', windows, (t) => {
  const { dir, env } = fixture(t)
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1'), '-Default', '-Port', '4567'], {
    cwd: dir, env, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8'))
  assert.equal(Object.keys(config.providers['venice-web'].models).length, 30)
  assert.equal(config.providers['venice-web'].settings.baseURL, 'http://127.0.0.1:4567/v1')
})

test('Windows hidden login accepts a bare cookie and blank User-Agent (mock Clerk)', windows, (t) => {
  const { dir, env } = fixture(t)
  const token = 'testheader.testpayload.testsignature'
  const mock = `
    globalThis.fetch = async (url) => Response.json(String(url).includes('/tokens')
      ? { jwt: 'header.' + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url') + '.signature' }
      : { response: { sessions: [{ id: 'mock-session', status: 'active', user: { id: 'mock-user' } }] } });
  `
  env.NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(mock)}`
  env.VENICE_TEST_LOGIN_SCRIPT = path.join(root, 'login.ps1')
  // Replace only this child's interactive host, not the login implementation.
  const script = `function Read-Host { param($Prompt, [switch]$AsSecureString)
    if ($AsSecureString) { return (ConvertTo-SecureString '${token}' -AsPlainText -Force) }
    return ''
  }; & $env:VENICE_TEST_LOGIN_SCRIPT`
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: dir, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token.replaceAll('.', '\\.')))
  const session = JSON.parse(readFileSync(env.VENICE_WEB_SESSION, 'utf8'))
  assert.equal(session.client, token)
  assert.match(session.userAgent, /Windows NT 10\.0.*Chrome\/157\.0\.0\.0/)
  assert.ok(JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8')).providers['venice-web'])
})

test('Windows launcher starts the real proxy with a custom port', windows, async (t) => {
  const scope = fixture(t)
  const { dir, env } = scope
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'start.ps1'), '-Port', String(port)], { cwd: dir, env, windowsHide: true })
  scope.stop = async () => {
    if (child.exitCode === null && child.pid) {
      const closed = once(child, 'close')
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
      await closed
    }
    child.stdout.destroy()
    child.stderr.destroy()
  }
  await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
      if (output.includes(`proxy on http://127.0.0.1:${port}/v1`)) resolve()
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`launcher exited early: ${code}`)))
  })
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(`${base}/health`).then((r) => r.json())
  assert.equal(health.ok, false)
  const models = await fetch(`${base}/v1/models`).then((r) => r.json())
  assert.ok(models.data.some((m) => m.id === 'deepseek-v4-1-flash-1017'))
  const invalid = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(invalid.status, 400)
})

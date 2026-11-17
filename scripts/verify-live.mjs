#!/usr/bin/env node
/** Isolated proxy + strict live smoke test. Requires an existing signed-in session. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionFile } from '../src/lib/config.mjs'

if (!existsSync(sessionFile)) throw new Error('No stored session. Run the login command before the live test.')
const root = fileURLToPath(new URL('../', import.meta.url))
const folder = mkdtempSync(path.join(tmpdir(), 'venice-live-test-'))
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const env = {
  ...process.env,
  VENICE_WEB_SESSION: sessionFile,
  VENICE_WEB_CONFIG_DIR: folder,
  VENICE_WEB_HOST: '127.0.0.1',
  VENICE_WEB_PORT: String(port),
  VENICE_WEB_DEBUG: '',
  VENICE_WEB_DUMP: '',
  SMOKE_REQUIRE: '1',
}
const proxy = spawn(process.execPath, [path.join(root, 'src/proxy.mjs')], { env, windowsHide: true })
let diagnostics = ''
proxy.stderr.on('data', (data) => { diagnostics += data })
try {
  await new Promise((resolve, reject) => {
    let output = ''
    proxy.stdout.on('data', (data) => {
      output += data
      if (output.includes(`proxy on http://127.0.0.1:${port}/v1`)) resolve()
    })
    proxy.once('error', reject)
    proxy.once('exit', (code) => reject(new Error(`test proxy exited (${code}): ${diagnostics}`)))
  })
  const smoke = spawn(process.execPath, [path.join(root, 'test/smoke.mjs')], { env, stdio: 'inherit' })
  smoke.once('error', (error) => console.error(error.message))
  const [code] = await once(smoke, 'exit')
  if (code !== 0) process.exitCode = 1
} finally {
  if (proxy.exitCode === null) {
    const exited = once(proxy, 'exit')
    proxy.kill()
    await exited
  }
  proxy.stdout.destroy()
  proxy.stderr.destroy()
  rmSync(folder, { recursive: true, force: true })
}

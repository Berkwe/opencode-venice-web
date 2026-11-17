import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertDisplay, findLauncher, isBrowserSupported, profileRoot } from '../src/lib/browser.mjs'

const withDisplay = (env, fn) => {
  const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
  process.env.DISPLAY = env.DISPLAY ?? ''
  process.env.WAYLAND_DISPLAY = env.WAYLAND ?? ''
  try {
    fn()
  } finally {
    if (saved.DISPLAY === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = saved.DISPLAY
    if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY
  }
}

test('isBrowserSupported only accepts the known browsers', () => {
  assert.equal(isBrowserSupported('brave'), true)
  assert.equal(isBrowserSupported('chrome'), true)
  assert.equal(isBrowserSupported('firefox'), false)
})

test('assertDisplay accepts a Wayland session', () => {
  withDisplay({ WAYLAND: 'wayland-0' }, () => assert.doesNotThrow(() => assertDisplay()))
})

test('assertDisplay accepts an X session', () => {
  withDisplay({ DISPLAY: ':0' }, () => assert.doesNotThrow(() => assertDisplay()))
})

test('assertDisplay explains the manual fallback when there is no display', () => {
  if (process.platform !== 'linux') return
  // ensureDisplay() probes the real X sockets, so the check is only meaningful
  // on a machine without one (a desktop box legitimately resolves :0).
  const noXSocket = ![0, 1].some((num) => existsSync(`/tmp/.X11-unix/X${num}`))
  withDisplay({}, () => {
    if (noXSocket) assert.throws(() => assertDisplay(), /no display .*--cookie/)
    else assert.doesNotThrow(() => assertDisplay())
  })
})

test('assertDisplay falls back to an existing X socket over SSH', () => {
  const socket = [0, 1].find((num) => existsSync(`/tmp/.X11-unix/X${num}`))
  if (socket === undefined) return
  withDisplay({}, () => {
    assert.doesNotThrow(() => assertDisplay())
    assert.equal(process.env.DISPLAY, `:${socket}`)
    delete process.env.DISPLAY
  })
})

test('findLauncher rejects an unknown browser name', () => {
  assert.throws(() => findLauncher('firefox'), /unknown browser: firefox/)
})

test('findLauncher reports a missing browser by label', () => {
  // Every launcher name is guaranteed absent by the empty PATH
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    assert.throws(() => findLauncher('brave'), process.platform === 'win32' ? /login.ps1.*--token/ : /Brave is not installed/)
  } finally {
    process.env.PATH = saved
  }
})

test('profileRoot points at the config dir', () => {
  assert.match(profileRoot(), /\.config$/)
})

test('guided sign-in API is available without starting a real browser', async () => {
  const { guidedSignIn } = await import('../src/lib/browser.mjs')
  assert.equal(typeof guidedSignIn, 'function')
})

const scratch = mkdtempSync(path.join(tmpdir(), 'venice-browser-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

test('a temp profile is a directory that can be created and removed', () => {
  const dir = path.join(scratch, 'profile')
  mkdirSync(dir, { recursive: true })
  assert.equal(existsSync(dir), true)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(existsSync(dir), false)
})

/**
 * Guided browser sign-in.
 *
 * `login.mjs` already knows how to pull the Clerk `__client` cookie out of a
 * Chromium profile - but only after the user has signed in, and only if a
 * profile already exists. This module closes the gap for a fresh machine:
 *
 *   1. launch a Chromium-family browser with a throwaway profile,
 *   2. wait for the user to sign in to venice.ai and close the window,
 *   3. read the cookie out of that profile and hand it to the caller.
 *
 * The window closing is the signal: while the browser runs we poll the cookie
 * store, and once the process is gone (or a valid cookie was seen and the
 * window closed) we stop. Nothing is written to the user's own profiles.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { BROWSERS, clientFromCookieDb } from './cookies.mjs'
import { log, warn } from './log.mjs'

/** Linux/macOS launchers, most preferred first, plus the flatpak/snap wrappers. */
const LAUNCHERS = {
  brave: ['brave-browser', 'brave', 'brave-browser-stable', 'com.brave.Browser'],
  chrome: ['google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
  chromium: ['chromium', 'chromium-browser'],
}

const MAC_PATHS = {
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
}

const SIGN_IN_URL = 'https://venice.ai/'

/** How often the profile is inspected while the browser is open. */
const POLL_MS = 1500
/** Give up after this long with no window at all. */
const MAX_WAIT_MS = 15 * 60 * 1000

export const isBrowserSupported = (name) => Object.hasOwn(BROWSERS, name)

/** Finds the executable for one browser, or for the first one available. */
export function findLauncher(name) {
  const names = name ? LAUNCHERS[name] : Object.keys(LAUNCHERS).flatMap((key) => LAUNCHERS[key])
  if (!names) throw new Error(`unknown browser: ${name} (expected ${Object.keys(LAUNCHERS).join(', ')})`)

  if (process.platform === 'darwin') {
    for (const candidate of Object.entries(MAC_PATHS)) {
      const [browser, bin] = candidate
      if (name && browser !== name) continue
      if (existsSync(bin)) return { browser, bin }
    }
    throw new Error('no Chromium based browser found in /Applications')
  }

  for (const candidate of Object.keys(LAUNCHERS)) {
    if (name && candidate !== name) continue
    for (const bin of LAUNCHERS[candidate]) {
      try {
        const found = execFileSync('command', ['-v', bin], { shell: '/bin/bash', encoding: 'utf8' }).trim()
        if (found) return { browser: candidate, bin: found }
      } catch {
        /* try the next one */
      }
    }
  }
  throw new Error(
    name
      ? `${BROWSERS[name].label} is not installed`
      : `no supported browser found (${Object.values(BROWSERS).map((b) => b.label).join(', ')}); install one or pass --cookie`,
  )
}

/** Throws with a readable reason when there is no display to draw the window on. */
export function assertDisplay() {
  if (process.platform === 'darwin') return
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return
  throw new Error(
    'no display (DISPLAY/WAYLAND_DISPLAY unset); run this from a desktop session, or pass --cookie/--ua manually',
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Opens `browser` on venice.ai and resolves with the `__client` cookie once the
 * user closed the window. `onTick` gets a heartbeat every poll.
 */
export async function guidedSignIn({ browser, timeoutMs = MAX_WAIT_MS, onTick } = {}) {
  assertDisplay()
  const { browser: name, bin } = findLauncher(browser)
  const label = BROWSERS[name].label

  // A dedicated profile in a temp dir keeps the user's own sessions untouched.
  const profileDir = path.join(tmpdir(), `venice-web-signin-${process.pid}-${Date.now()}`)
  mkdirSync(profileDir, { recursive: true })

  const args = [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', SIGN_IN_URL]
  if (process.platform !== 'darwin') args.unshift('--new-window')

  log(`opening ${label} - sign in to venice.ai, then close the window`)
  log(`profile: ${profileDir}`)

  const child = spawn(bin, args, { stdio: 'ignore', detached: false })
  let exitCode = null
  let spawnError = null
  child.on('exit', (code) => {
    exitCode = code ?? 0
  })
  child.on('error', (error) => {
    spawnError = error
  })

  const deadline = Date.now() + timeoutMs
  let seen = null
  let ticks = 0

  while (true) {
    await sleep(POLL_MS)
    ticks += 1
    if (spawnError) throw new Error(`could not start ${label}: ${spawnError.message}`)

    if (!seen) {
      try {
        seen = clientFromCookieDb(profileDir, name)
      } catch {
        /* the db may be locked or half written; keep polling */
      }
    }
    if (seen) onTick?.(`cookie found after ${Math.round((ticks * POLL_MS) / 1000)}s`)

    if (exitCode !== null) break
    if (Date.now() > deadline) {
      warn(`still waiting after ${Math.round(timeoutMs / 60_000)} min; close the window when done`)
      deadline = Infinity
    }
  }

  // One last read: the browser writes the cookie store right before exiting.
  if (!seen) {
    try {
      seen = clientFromCookieDb(profileDir, name)
    } catch {
      /* fall through to the error below */
    }
  }

  if (!seen) {
    throw new Error(`${label} closed before a venice.ai session was stored; run the sign-in again`)
  }

  const { client, userAgent } = seen
  return {
    client,
    userAgent,
    source: `${label} (guided sign-in)`,
    cleanup: () => rmSync(profileDir, { recursive: true, force: true }),
  }
}

/** Absolute path helper used by tests and messages. */
export const profileRoot = () => path.join(homedir(), '.config')

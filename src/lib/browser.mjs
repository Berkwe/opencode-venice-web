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

/**
 * Makes sure a display exists AND that we are allowed to draw on it.
 *
 * Over SSH the DISPLAY variable is usually missing even though a desktop
 * session is running, and X refuses the connection without the matching
 * Xauthority file. Both are recovered here: DISPLAY falls back to an existing
 * X socket, and the lightdm/gdm/user auth file is picked up when present.
 *
 * Only sockets that really exist count. A stale DISPLAY (`:0` while Xorg runs
 * on `:1`) is corrected the same way instead of being trusted blindly.
 */
function ensureDisplay() {
  if (process.platform === 'darwin') return
  if (process.env.WAYLAND_DISPLAY) return

  const liveSocket = [0, 1].find((num) => existsSync(`/tmp/.X11-unix/X${num}`))
  if (liveSocket === undefined) return

  const current = (process.env.DISPLAY ?? '').match(/^:(\d+)/)
  if (!current || !existsSync(`/tmp/.X11-unix/X${current[1]}`)) {
    process.env.DISPLAY = `:${liveSocket}`
  }
  const num = (process.env.DISPLAY.match(/:(\d+)/) ?? [])[1] ?? String(liveSocket)

  if (!process.env.XAUTHORITY) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const candidates = [
      `/var/run/lightdm/root/:${num}`,
      `/run/user/${uid}/gdm/Xauthority`,
      path.join(homedir(), '.Xauthority'),
      `/run/user/${uid}/.mutter-Xwaylandauth`,
    ]
    for (const file of candidates) {
      if (existsSync(file)) {
        process.env.XAUTHORITY = file
        break
      }
    }
  }
}

/** Throws with a readable reason when there is no display to draw the window on. */
export function assertDisplay() {
  ensureDisplay()
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
 *
 * `verify` (optional) is called with each candidate cookie and must resolve
 * `true` only when that cookie really carries a signed-in session. Without it the
 * first `__client` in the store wins, which may be the anonymous one.
 */
export async function guidedSignIn({ browser, timeoutMs = MAX_WAIT_MS, onTick, verify, closeOnConfirm = true } = {}) {
  assertDisplay()
  const { browser: name, bin } = findLauncher(browser)
  const label = BROWSERS[name].label

  // A dedicated profile in a temp dir keeps the user's own sessions untouched.
  const profileDir = path.join(tmpdir(), `venice-web-signin-${process.pid}-${Date.now()}`)
  mkdirSync(profileDir, { recursive: true })

  const args = [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check']
  // Chromium refuses to start as root (chroot, container, plain root shell)
  // without this; the exit code is 1 and the window never appears.
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
  // Keyring is often empty on a fresh box; basic keeps the cookie readable.
  if (process.platform === 'linux') args.push('--password-store=basic')
  if (process.platform !== 'darwin') args.push('--new-window')
  args.push(SIGN_IN_URL)

  log(`opening ${label} - sign in to venice.ai, then close the window`)
  log(`profile: ${profileDir}`)

  // detached + unref: the window has to outlive the ssh shell that started it,
  // otherwise the whole child tree dies and the sign-in never happens.
  const env = { ...process.env }
  const child = spawn(bin, args, { stdio: 'ignore', detached: true, env })
  child.unref()
  // Once the session is confirmed the window has done its job; close it.
  const stop = (proc) => {
    try {
      proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const hard = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 2500)
    hard.unref?.()
  }

  let exitCode = null
  let spawnError = null
  child.on('exit', (code) => {
    exitCode = code ?? 0
  })
  child.on('error', (error) => {
    spawnError = error
  })

  let deadline = Date.now() + timeoutMs
  let seen = null
  let confirmed = false
  let ticks = 0

  // Clerk writes an anonymous `__client` on the first page load and replaces it
  // once the sign-in completes, so the store is re-read on every tick; latching
  // on the first hit hands back a client that carries no session.
  const read = () => {
    try {
      return clientFromCookieDb(profileDir, name)
    } catch {
      return null
    }
  }

  const check = async (candidate) => {
    if (!candidate) return false
    if (!verify) return true
    try {
      return (await verify(candidate)) === true
    } catch {
      return false
    }
  }

  while (true) {
    await sleep(POLL_MS)
    ticks += 1
    const seconds = Math.round((ticks * POLL_MS) / 1000)
    if (spawnError) throw new Error(`could not start ${label}: ${spawnError.message}`)

    const fresh = read()
    if (fresh) {
      seen = fresh
      const was = confirmed
      if (!confirmed) confirmed = await check(fresh)
      if (confirmed !== was || seconds % 10 === 0) {
        onTick?.(
          confirmed
            ? `signed-in session found after ${seconds}s - close the window when done`
            : `cookie present after ${seconds}s, waiting for the sign-in to complete`,
        )
      }
    }

    if (confirmed && closeOnConfirm) {
      onTick?.(`signed in - closing the ${label} window`)
      stop(child)
      await sleep(1500)
      break
    }

    if (exitCode !== null) break
    if (Date.now() > deadline) {
      warn(`still waiting after ${Math.round(timeoutMs / 60_000)} min; close the window when done`)
      deadline = Infinity
    }
  }

  // One last read: the browser writes the cookie store right before exiting.
  const last = read()
  if (last) {
    seen = last
    confirmed = await check(last)
  }

  if (!seen) {
    throw new Error(`${label} closed before a venice.ai session was stored; run the sign-in again`)
  }
  if (verify && !confirmed) {
    throw new Error(
      'a venice.ai cookie was stored but no account is signed in on it; open the window again and finish the sign-in before closing it',
    )
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

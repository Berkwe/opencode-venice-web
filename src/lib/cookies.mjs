/**
 * Browser cookie extraction.
 *
 * Venice web auth is a long-lived Clerk `__client` cookie. Chromium based
 * browsers encrypt cookies with a key stored in the OS keychain, so we read the
 * key, decrypt the cookie, and stop there - nothing is written back to the
 * browser and no password is stored.
 *
 * Supported automatically: Brave, Chrome, Edge, Chromium on macOS (Keychain) and
 * Linux (secret-tool / gnome-keyring, falling back to the well-known "peanuts"
 * password used when no keyring is available). Anything else can be passed with
 * `--cookie` + `--ua`.
 *
 * The store itself is read either through the `sqlite3` binary or, when it is
 * missing, through the small built-in reader in `sqlite.mjs` - a fresh machine
 * often has the browser but not the sqlite3 CLI.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { readCookies } from './sqlite.mjs'

export const BROWSERS = {
  brave: { mac: 'BraveSoftware/Brave-Browser', linux: 'BraveSoftware/Brave-Browser', app: '/Applications/Brave Browser.app', keychain: 'Brave Safe Storage', secret: ['application', 'brave'], label: 'Brave' },
  chrome: { mac: 'Google/Chrome', linux: 'google-chrome', app: '/Applications/Google Chrome.app', keychain: 'Chrome Safe Storage', secret: ['application', 'chrome'], altSecrets: [['application', 'chromium']], label: 'Chrome' },
  edge: { mac: 'Microsoft Edge', linux: 'microsoft-edge', app: '/Applications/Microsoft Edge.app', keychain: 'Microsoft Edge Safe Storage', secret: ['application', 'chrome'], altSecrets: [['application', 'chromium']], label: 'Edge' },
  chromium: { mac: 'Chromium', linux: 'chromium', app: '/Applications/Chromium.app', keychain: 'Chromium Safe Storage', secret: ['application', 'chromium'], label: 'Chromium' },
}

const COOKIE_HOSTS = ['.clerk.venice.ai', 'clerk.venice.ai', '.venice.ai', 'venice.ai']

const profiles = (name) => (name ? [name] : ['Default', 'Profile 1', 'Profile 2', 'Profile 3'])

function candidatePaths(browser, profile) {
  const home = homedir()
  // An absolute path is a profile directory of its own (guided sign-in on a
  // throwaway profile, or any --profile outside the browser's config dir).
  if (profile && path.isAbsolute(profile)) {
    return [path.join(profile, 'Cookies'), `${profile}-Cookies`]
  }
  if (process.platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support', browser.mac)
    return profiles(profile).map((dir) => path.join(root, dir, 'Cookies'))
  }
  const roots = [path.join(home, '.config'), path.join(home, '.var', 'app')]
  const dirs = []
  for (const root of roots) {
    if (browser.linux.includes('/')) dirs.push(path.join(root, browser.linux))
    else dirs.push(path.join(root, browser.linux))
  }
  const out = []
  // `profiles` shadows the `profile` parameter inside the loop head, so the
  // requested name is resolved once, before the loop.
  const dirsForProfile = profiles(profile === 'Default' ? undefined : profile)
  for (const dir of dirs) for (const dirName of dirsForProfile) {
    out.push(path.join(dir, dirName, 'Cookies'))
    out.push(path.join(dir, `${dirName}-Cookies`))
  }
  return out
}

function passwordFor(browser) {
  if (process.platform === 'darwin') {
    return execFileSync('security', ['find-generic-password', '-s', browser.keychain, '-w'], { encoding: 'utf8' }).trim()
  }
  // Linux: secret-tool lookup, fall back to the no-keyring default.
  for (const attrs of [browser.secret, ...(browser.altSecrets ?? [])]) {
    try {
      const value = execFileSync('secret-tool', ['lookup', ...attrs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (value) return value
    } catch {
      /* try the next attribute set */
    }
  }
  return 'peanuts'
}

/**
 * Candidate passwords for a profile, most likely first.
 *
 * A guided sign-in runs with `--password-store=basic`, so its cookies are
 * encrypted with the well-known "peanuts" password even when the desktop
 * keyring holds an (unrelated) entry for the same browser. Reading a user's own
 * profile is the other way round, so the keyring value comes first there and
 * "peanuts" stays as the last resort.
 */
function passwordsFor(browser) {
  const keyring = passwordFor(browser)
  return keyring === 'peanuts' ? ['peanuts'] : [keyring, 'peanuts']
}

/** Decrypts one cookie value; `null` when none of the passwords fit. */
function decryptWith(value, passwords) {
  for (const password of passwords) {
    try {
      return decrypt(value, pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1'))
    } catch {
      /* wrong password for this profile - try the next one */
    }
  }
  return null
}

function decrypt(value, key) {
  let payload = value
  const prefix = payload.subarray(0, 3).toString()
  if (prefix === 'v10' || prefix === 'v11') payload = payload.subarray(3)
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const out = Buffer.concat([decipher.update(payload), decipher.final()])
  // Chromium >= 130 prefixes a SHA256 of the host key. Only a payload long
  // enough to hold it plus a non-empty value gets trimmed, so a short cookie
  // never loses its first characters.
  const body = out.length > 32 ? out.subarray(32) : out
  return body.toString('utf8')
}

function browserUserAgent(browser) {
  if (process.platform === 'darwin') {
    const plist = path.join(browser.app, 'Contents', 'Info.plist')
    if (existsSync(plist)) {
      const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
      const major = version.split('.')[0] || '131'
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    }
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

/**
 * Reads the `__client` cookie out of one cookie database file. Split out from
 * `readFromBrowser` so the guided sign-in can point it at a throwaway profile
 * directory instead of the user's own browser profile.
 */
export function clientFromCookieDb(dbPath, name) {
  const browser = BROWSERS[name]
  if (!browser) throw new Error(`unknown browser: ${name} (expected ${Object.keys(BROWSERS).join(', ')})`)
  // A profile directory is accepted as well, so callers do not have to know the
  // layout inside it.
  if (existsSync(dbPath) && statSync(dbPath).isDirectory()) dbPath = path.join(dbPath, 'Default', 'Cookies')
  if (!existsSync(dbPath)) return null

  const passwords = passwordsFor(browser)
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'venice-cookie-')), 'Cookies')
  copyFileSync(dbPath, copy)
  // Chromium keeps recent writes in the rollback journal / WAL until it commits.
  // Without those side files the copy can look older than it is and a fresh
  // cookie appears missing.
  for (const suffix of ['-journal', '-wal']) {
    const side = `${dbPath}${suffix}`
    if (existsSync(side)) copyFileSync(side, `${copy}${suffix}`)
  }

  const rows = readCookies(copy, COOKIE_HOSTS)
  let client = null
  for (const row of rows) {
    if (row.name !== '__client') continue
    client = decryptWith(Buffer.from(row.hex, 'hex'), passwords)
    if (client) break
  }
  if (!client) return null
  return { client, userAgent: browserUserAgent(browser), source: browser.label }
}

/**
 * True when the given cookie database belongs to a profile that is in use right
 * now: a live Chromium writes a `SingletonLock` next to it and appends a
 * `-journal`/`-wal` file while the DB is open. Copying the store while the
 * browser still holds it can yield an empty read.
 */
export function profileIsLive(dbPath) {
  const dir = path.dirname(dbPath)
  return ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].some((name) => existsSync(path.join(dir, name)))
}

function readFromBrowser(name, profile) {
  const db = candidatePaths(BROWSERS[name], profile).find(existsSync)
  if (!db) return null
  return clientFromCookieDb(db, name)
}

/** Tries the requested browsers (or all of them) in order. */
export function findCookies({ browser, profile } = {}) {
  const order = browser ? [browser] : ['brave', 'chrome', 'edge', 'chromium']
  const notes = []
  for (const name of order) {
    if (!BROWSERS[name]) throw new Error(`unknown browser: ${name} (expected ${Object.keys(BROWSERS).join(', ')})`)
    try {
      const found = readFromBrowser(name, profile)
      if (found) return found
      notes.push(`${BROWSERS[name].label}: no venice.ai cookie`)
    } catch (error) {
      notes.push(`${BROWSERS[name].label}: ${String(error.message).split('\n')[0]}`)
    }
  }
  throw new Error(
    `could not read browser cookies:\n  ${notes.join('\n  ')}\n` +
      'Sign in to venice.ai in a supported browser, or pass --cookie/--ua manually.',
  )
}

/** Parses a Cookie header or JSON export into a raw `__client` value. */
export function clientFromString(input) {
  const text = input.replace(/^cookie:\s*/i, '')
  const match = /(?:^|;\s*)__client=([^;]+)/.exec(text)
  if (match) return match[1]
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : parsed?.cookies
    const found = (list ?? []).find((cookie) => cookie?.name === '__client')
    if (found?.value) return found.value
  } catch {
    /* not JSON */
  }
  throw new Error('no __client cookie found in the given value (copy it from a clerk.venice.ai request)')
}

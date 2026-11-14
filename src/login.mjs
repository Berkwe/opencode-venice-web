#!/usr/bin/env node
/**
 * venice-web login - stores the venice.ai web session (Clerk `__client` cookie)
 * in a local session file. Nothing is sent anywhere except venice.ai/Clerk.
 *
 *   node src/login.mjs                                  # guided: opens a browser, waits for the sign-in
 *   node src/login.mjs --browser brave --profile Default # read the cookie out of an existing profile
 *   node src/login.mjs --cookie "__client=…" --ua "Mozilla/5.0 …"
 *   node src/login.mjs --print                          # also print the UA to copy
 *
 * Guided mode is the default when a display is available and no cookie was
 * passed: a throwaway browser profile opens venice.ai, the user signs in and
 * closes the window, and the cookie is read out of that profile. Nothing is
 * written to the user's own browser profiles.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { clerkBase, clerkVersion, sessionFile } from './lib/config.mjs'
import { findCookies, clientFromString } from './lib/cookies.mjs'
import { guidedSignIn, isBrowserSupported } from './lib/browser.mjs'
import { log, warn } from './lib/log.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const options = {
  browser: flag('browser'),
  profile: flag('profile'),
  cookie: flag('cookie'),
  userAgent: flag('ua'),
  timeoutMs: Number(flag('timeout', 15 * 60)) * 1000,
}

const guided = !options.cookie && !options.profile

const requestHeaders = (client, userAgent) => ({
  'user-agent': userAgent,
  origin: 'https://venice.ai',
  referer: 'https://venice.ai/',
  cookie: `__client=${client}`,
})

/** Verifies the cookie against Clerk and returns the active session + user. */
async function resolveAccount(client, userAgent) {
  const headers = requestHeaders(client, userAgent)
  const response = await fetch(`${clerkBase}/v1/client${clerkVersion}`, { headers, redirect: 'error' })
  if (!response.ok) throw new Error(`Clerk rejected the session (HTTP ${response.status}); sign in to venice.ai again`)
  const data = await response.json()
  const sessions = (data.response?.sessions ?? data.client?.sessions ?? []).filter((item) => item.status === 'active')
  const session = sessions[0]
  if (!session) throw new Error('no active Venice session found in those cookies')
  const user = session.user ?? {}
  const email =
    user.email_addresses?.find((item) => item.id === user.primary_email_address_id)?.email_address ?? user.id ?? 'unknown'
  return { session, email, uid: user.id }
}

async function mint(client, userAgent, sessionId) {
  const response = await fetch(`${clerkBase}/v1/client/sessions/${sessionId}/tokens${clerkVersion}`, {
    method: 'POST',
    headers: { ...requestHeaders(client, userAgent), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'organization_id=&tab_state=focused&force_origin=true',
  })
  if (!response.ok) throw new Error(`could not mint a session token (HTTP ${response.status})`)
  const { jwt } = await response.json()
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  return { jwt, expires: claims.exp * 1000 }
}

/** Reads the cookie either from a guided sign-in or from an existing profile. */
async function collectCookie() {
  if (options.cookie) return { client: clientFromString(options.cookie), userAgent: options.userAgent, source: 'manual' }

  if (guided) {
    const found = await guidedSignIn({
      browser: options.browser,
      timeoutMs: options.timeoutMs,
      onTick: (note) => log(note),
    })
    try {
      return { ...found, cleanup: found.cleanup }
    } finally {
      /* cleanup runs after the caller is done */
    }
  }

  if (options.browser && !isBrowserSupported(options.browser)) {
    throw new Error(`unknown browser: ${options.browser}`)
  }
  const found = findCookies({ browser: options.browser, profile: options.profile })
  return { client: found.client, userAgent: options.userAgent ?? found.userAgent, source: found.source }
}

async function main() {
  let collected
  try {
    collected = await collectCookie()
  } catch (error) {
    warn(`login failed: ${error.message}`)
    warn('fallback: sign in to venice.ai in a browser, then pass --cookie "__client=…" --ua "…"')
    process.exit(1)
  }

  const client = collected.client
  const userAgent =
    collected.userAgent ??
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const source = collected.source

  if (args.includes('--print')) log(`User-Agent: ${userAgent}`)

  try {
    const { session, email, uid } = await resolveAccount(client, userAgent)
    const { jwt, expires } = await mint(client, userAgent, session.id)

    const state = { version: 1, source, userAgent, client, uid, sessionId: session.id, email, access: jwt, expires }
    mkdirSync(path.dirname(sessionFile), { recursive: true })
    const tmp = `${sessionFile}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 })
    renameSync(tmp, sessionFile)
    chmodSync(sessionFile, 0o600)

    log(`signed in as ${email} (via ${source})`)
    log(`session file: ${sessionFile}`)
    warn('keep this file private: it contains a live session cookie.')
  } finally {
    collected.cleanup?.()
  }
}

main().catch((error) => {
  warn(`login failed: ${error.message}`)
  process.exit(1)
})

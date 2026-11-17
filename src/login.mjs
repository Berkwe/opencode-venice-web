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
 * Interactive terminals offer a token/browser menu. --token opens the hidden
 * token prompt directly; --menu forces the menu; --guided opens a browser on
 * macOS/Linux without a menu. Guided profiles never modify the user's profile.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { clerkBase, clerkVersion, sessionFile } from './lib/config.mjs'
import { findCookies, clientFromString } from './lib/cookies.mjs'
import { guidedSignIn, isBrowserSupported } from './lib/browser.mjs'
import { log, warn } from './lib/log.mjs'
import { atomicWritePrivateFile } from './lib/private-file.mjs'

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

const UA_FALLBACK = process.platform === 'win32'
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const guided = !options.cookie && !options.profile

function storedUserAgent() {
  try {
    const value = JSON.parse(readFileSync(sessionFile, 'utf8')).userAgent
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return undefined
  }
}

const requestHeaders = (client, userAgent) => ({
  'user-agent': userAgent,
  origin: 'https://venice.ai',
  referer: 'https://venice.ai/',
  cookie: `__client=${client}`,
})

/** Clerk can rotate the browser cookie on either identity or token requests. */
async function clerkRequest(url, credentials, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...requestHeaders(credentials.client, credentials.userAgent), ...init.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  const rotated = response.headers.getSetCookie().find((value) => value.startsWith('__client='))
  if (rotated) credentials.client = rotated.slice('__client='.length).split(';')[0] || credentials.client
  return response
}

/** Verifies the cookie against Clerk and returns the active session + user. */
async function resolveAccount(client, userAgent) {
  const credentials = { client, userAgent }
  const response = await clerkRequest(`${clerkBase}/v1/client${clerkVersion}`, credentials)
  if (!response.ok) throw new Error(`Clerk rejected the session (HTTP ${response.status}); sign in to venice.ai again`)
  const data = await response.json()
  const sessions = (data.response?.sessions ?? data.client?.sessions ?? []).filter((item) => item.status === 'active')
  const session = sessions[0]
  if (!session) throw new Error('no active Venice session found in those cookies')
  const user = session.user ?? {}
  const email =
    user.email_addresses?.find((item) => item.id === user.primary_email_address_id)?.email_address ?? user.id ?? 'unknown'
  return { session, email, uid: user.id, client: credentials.client }
}

async function mint(client, userAgent, sessionId) {
  const credentials = { client, userAgent }
  const response = await clerkRequest(`${clerkBase}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens${clerkVersion}`, credentials, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'organization_id=&tab_state=focused&force_origin=true',
  })
  if (!response.ok) throw new Error(`could not mint a session token (HTTP ${response.status})`)
  const { jwt } = await response.json()
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('Clerk returned an invalid or expired session token')
  return { jwt, expires: claims.exp * 1000, client: credentials.client }
}

/** Collects a manual token, piped credentials, guided sign-in or profile cookie. */
async function collectCookie({ skipMenu = false } = {}) {
  if (args.includes('--stdin')) {
    if (options.cookie) throw new Error('use either --stdin or --cookie, not both')
    if (process.stdin.isTTY) throw new Error('--stdin expects JSON piped to standard input; use login.ps1 on Windows')
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('login input is too large')
      chunks.push(chunk)
    }
    let input
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('login input must be JSON with cookie and userAgent strings')
    }
    if (typeof input?.cookie !== 'string' || typeof input?.userAgent !== 'string' || !input.userAgent.trim()) {
      throw new Error('login input requires cookie and userAgent strings')
    }
    return { client: clientFromString(input.cookie), userAgent: input.userAgent.trim(), source: 'manual (stdin)' }
  }
  if (options.cookie) return { client: clientFromString(options.cookie), userAgent: options.userAgent, source: 'manual' }
  const interactiveDefault = process.stdin.isTTY && !options.browser && !options.profile && !args.includes('--guided')
  if (!skipMenu && (args.includes('--token') || args.includes('--menu') || interactiveDefault)) {
    const { createPrompter } = await import('./lib/prompt.mjs')
    const prompt = createPrompter()
    try {
      let choice = '1'
      if (!args.includes('--token')) {
        log('How do you want to sign in?')
        log('  1) Paste a token (default)')
        if (process.platform !== 'win32') log('  2) Browser sign-in')
        choice = (await prompt.ask('> ')) || '1'
      }
      if (choice === '1') {
        log('Copy __client from a clerk.venice.ai cookie or request in browser DevTools.')
        const client = clientFromString(await prompt.ask('__client token (hidden): ', { echo: false }))
        return { client, userAgent: options.userAgent ?? storedUserAgent() ?? UA_FALLBACK, source: 'token' }
      }
      if (choice !== '2' || process.platform === 'win32') throw new Error('invalid sign-in choice')
    } finally {
      prompt.close()
    }
    return collectCookie({ skipMenu: true })
  }
  if (process.platform === 'win32') {
    throw new Error('automatic browser cookie extraction is not supported on Windows (DPAPI/App-Bound encryption); run .\\login.ps1 or pass --cookie and --ua')
  }

  if (guided) {
    const found = await guidedSignIn({
      browser: options.browser,
      timeoutMs: options.timeoutMs,
      onTick: (note) => log(note),
      // Clerk sets an anonymous cookie on page load and swaps it after the
      // sign-in; only a cookie that resolves a session is accepted.
      verify: async ({ client, userAgent }) => {
        try {
          await resolveAccount(client, userAgent ?? UA_FALLBACK)
          return true
        } catch {
          return false
        }
      },
    })
    return found
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
  const userAgent = collected.userAgent?.trim() || storedUserAgent() || UA_FALLBACK
  const source = collected.source

  if (args.includes('--print')) log(`User-Agent: ${userAgent}`)

  try {
    const { session, email, uid, client: refreshedClient } = await resolveAccount(client, userAgent)
    const { jwt, expires, client: finalClient } = await mint(refreshedClient, userAgent, session.id)

    const state = { version: 1, source, userAgent, client: finalClient, uid, sessionId: session.id, email, access: jwt, expires }
    atomicWritePrivateFile(sessionFile, JSON.stringify(state, null, 1))

    log(`signed in as ${email} (via ${source})`)
    log(`session file: ${sessionFile}`)
    warn('keep this file private: it contains a live session cookie.')
    const sync = spawnSync(process.execPath, [fileURLToPath(new URL('./sync.mjs', import.meta.url))], { stdio: 'inherit' })
    if (sync.error || sync.status !== 0) {
      warn('signed in, but OpenCode provider sync failed; run node src/sync.mjs to retry')
    }
  } finally {
    collected.cleanup?.()
  }
}

main().catch((error) => {
  warn(`login failed: ${error.message}`)
  process.exit(1)
})

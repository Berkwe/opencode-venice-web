import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clientFromCookieDb } from '../src/lib/cookies.mjs'

/** Builds a tiny cookie database with the Chromium schema and one cookie. */
function cookieDb(dir, { value = 'v10payload' } = {}) {
  mkdirSync(path.join(dir, 'Default'), { recursive: true })
  const db = path.join(dir, 'Default', 'Cookies')
  const hex = Buffer.from(value, 'latin1').toString('hex')
  const sql = [
    'create table cookies (host_key text, name text, encrypted_value blob)',
    "insert into cookies values ('.clerk.venice.ai', '__client', x'" + hex + "')",
  ].join('; ')
  execFileSync('sqlite3', [db, sql])
  return db
}

const scratch = mkdtempSync(path.join(tmpdir(), 'venice-cookies-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

test('an unknown browser name is rejected', () => {
  assert.throws(() => clientFromCookieDb('/nope/Cookies', 'firefox'), /unknown browser: firefox/)
})

test('a missing database returns null instead of throwing', () => {
  assert.equal(clientFromCookieDb(path.join(scratch, 'nope', 'Cookies'), 'chromium'), null)
})

test('a profile directory is accepted and resolved to Default/Cookies', () => {
  const dir = path.join(scratch, 'profile-dir')
  cookieDb(dir, { value: 'v10not-really-encrypted' })
  // The value is not decryptable, so the interesting part is that the file was
  // found at all (EISDIR before this fix).
  assert.equal(clientFromCookieDb(dir, 'chromium'), null)
  assert.doesNotThrow(() => clientFromCookieDb(dir, 'chromium'))
})

test('an absolute profile path is used as the profile itself', () => {
  const dir = path.join(scratch, 'absolute-profile')
  cookieDb(dir)
  const db = path.join(dir, 'Default', 'Cookies')
  // Same database through the explicit file path and through the directory.
  assert.equal(clientFromCookieDb(db, 'chromium'), clientFromCookieDb(dir, 'chromium'))
})

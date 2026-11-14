import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readCookies } from '../src/lib/sqlite.mjs'

const scratch = mkdtempSync(path.join(tmpdir(), 'venice-sqlite-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

/** The reader falls back to its own parser when the CLI is missing. */
const withoutCli = (fn) => {
  const saved = process.env.PATH
  process.env.PATH = path.join(scratch, 'empty-path')
  try {
    return fn()
  } finally {
    process.env.PATH = saved
  }
}

const makeDb = (file, sql) => {
  // SQL goes in as an argument, not on stdin: on this platform a child spawned
  // through execFileSync can get a closed stdin and then writes an empty file.
  execFileSync('sqlite3', [file, sql])
  return file
}

const cookiesDb = (file) =>
  makeDb(
    file,
    [
      'create table cookies (host_key text, name text, encrypted_value blob)',
      "insert into cookies values ('.clerk.venice.ai', '__client', x'763130414243')",
      "insert into cookies values ('.clerk.venice.ai', 'other', x'763130444546')",
      "insert into cookies values ('.example.com', '__client', x'763130474849')",
    ].join(';'),
  )

const hosts = ['.clerk.venice.ai']

const cliAvailable = (() => {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('readCookies returns only the requested host', { skip: !cliAvailable }, () => {
  const file = cookiesDb(path.join(scratch, 'a.db'))
  const rows = readCookies(file, hosts)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.name).sort(), ['__client', 'other'])
  assert.equal(rows[0].hex, '763130414243')
})

test('the built-in reader agrees with sqlite3', { skip: !cliAvailable }, () => {
  const file = cookiesDb(path.join(scratch, 'b.db'))
  const expected = readCookies(file, hosts)
  const actual = withoutCli(() => readCookies(file, hosts))
  assert.deepEqual(actual, expected)
})

test('the built-in reader rejects a file that is not SQLite', { skip: !cliAvailable }, () => {
  const file = path.join(scratch, 'not.db')
  writeFileSync(file, 'hello')
  withoutCli(() => assert.throws(() => readCookies(file, hosts), /not an SQLite database/))
})

test('a database without a cookies table is reported', { skip: !cliAvailable }, () => {
  const file = makeDb(path.join(scratch, 'empty.db'), 'create table t (a)')
  withoutCli(() => assert.throws(() => readCookies(file, hosts), /no such table: cookies/))
})

test('the reader never writes to the database', { skip: !cliAvailable }, () => {
  const file = cookiesDb(path.join(scratch, 'c.db'))
  const before = readFileSync(file)
  withoutCli(() => readCookies(file, hosts))
  assert.deepEqual(readFileSync(file), before)
})

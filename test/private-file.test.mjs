import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { atomicWritePrivateFile, writePrivateFile } from '../src/lib/private-file.mjs'

test('private files preserve content, restrict access and never overwrite an existing file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-private-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.json')
  writePrivateFile(file, 'secret')
  assert.equal(readFileSync(file, 'utf8'), 'secret')
  assert.throws(() => writePrivateFile(file, 'replacement'), /EEXIST/)
  assert.equal(readFileSync(file, 'utf8'), 'secret')
  if (process.platform === 'win32') {
    const script = '$acl = Get-Acl -LiteralPath $env:VENICE_TEST_PRIVATE_FILE; ConvertTo-Json -Compress @{ protected = $acl.AreAccessRulesProtected; count = @($acl.Access).Count; inherited = @($acl.Access | Where-Object IsInherited).Count }'
    const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', env: { ...process.env, VENICE_TEST_PRIVATE_FILE: file },
    })
    const acl = JSON.parse(result)
    assert.equal(acl.protected, true)
    assert.equal(acl.count, 1)
    assert.equal(acl.inherited, 0)
  } else {
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
})

test('atomic secret replacement cleans up temporary files on success and failure', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venice-private-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.json')
  atomicWritePrivateFile(file, 'first')
  atomicWritePrivateFile(file, 'second')
  assert.equal(readFileSync(file, 'utf8'), 'second')
  mkdirSync(path.join(dir, 'blocked'))
  assert.throws(() => atomicWritePrivateFile(path.join(dir, 'blocked'), 'must not linger'))
  assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'session.json'])
})

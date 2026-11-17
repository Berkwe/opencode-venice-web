/** Secret files: POSIX mode 600, or an explicit current-user-only Windows ACL. */
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

let userSid

export function writePrivateFile(file, contents) {
  // Create an empty file first. No secret is written before its ACL is set.
  closeSync(openSync(file, 'wx', 0o600))
  try {
    if (process.platform === 'win32') {
      if (!userSid) {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
        userSid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0]
        if (!userSid) throw new Error('could not determine the Windows user SID')
      }
      execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${userSid}:F`], { stdio: 'pipe', windowsHide: true })
    }
    writeFileSync(file, contents)
  } catch (error) {
    rmSync(file, { force: true })
    throw error
  }
}

/** Keep the old secret intact on failure, and never leave a temporary copy. */
export function atomicWritePrivateFile(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writePrivateFile(tmp, contents)
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Minimal SQLite reader, so cookie extraction works without the `sqlite3` CLI.
 *
 * Only what a Chromium `Cookies` file needs: the schema is parsed from
 * `sqlite_master`, the requested rows are located through a B-tree walk, and
 * varint / record decoding follows the file format (https://sqlite.org/fileformat2.html).
 * Read-only: it never opens the database for writing and works on a copy.
 *
 * When the `sqlite3` binary happens to be installed it is used instead, because
 * it also handles WAL journals and odd encodings for free.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const hasSqliteCli = () => {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const MAGIC = 'SQLite format 3\u0000'
const PAGE_HEADER = 100

/** Reads a varint, returning the value and the bytes consumed. */
function varint(buf, offset) {
  let value = 0
  let shift = 0
  let index = offset
  for (let i = 0; i < 9; i += 1) {
    const byte = buf[index]
    index += 1
    if (i === 8) {
      value = value * 256 + byte
      break
    }
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, next: index }
}

// SQLite stores integers as big-endian bytes, already two's complement for the
// width of the serial type, so the accumulated value is used as is.

/** Decodes one record body into column values. */
function decodeRecord(payload) {
  const header = varint(payload, 0)
  const types = []
  let cursor = header.next
  while (cursor < header.value) {
    const { value, next } = varint(payload, cursor)
    types.push(value)
    cursor = next
  }

  const values = []
  let body = header.value
  for (const type of types) {
    if (type === 0) values.push(null)
    else if (type >= 1 && type <= 6) {
      const size = [0, 1, 2, 3, 4, 6, 8][type]
      let number = 0
      for (let i = 0; i < size; i += 1) number = number * 256 + payload[body + i]
      values.push(number)
      body += size
    } else if (type === 7) {
      values.push(payload.subarray(body, body + 8).readDoubleBE(0))
      body += 8
    } else if (type === 8) values.push(0)
    else if (type === 9) values.push(1)
    else if (type >= 12) {
      // Serial types 12/13 are the 1 byte blob/text pair, 14/15 the 2 byte pair,
      // so an even type is a blob and an odd type is text of the same length.
      const size = (type - 12) >> 1
      values.push(payload.subarray(body, body + size))
      body += size
    } else values.push(null)
  }
  return values
}

/**
 * Walks a B-tree and collects the decoded rows.
 *
 * `start` is the byte offset of the page's cell-content area: 100 on page 1
 * (after the file header), 0 on every other page. Page 1 keeps its b-tree
 * header at byte 100, not at byte 0.
 */
function walk(db, page, out) {
  // A page size of 1 means 64 KiB; anything else is the literal size.
  const pageSize = db.readUInt16BE(16) === 1 ? 65536 : db.readUInt16BE(16)
  const base = (page - 1) * pageSize
  // On page 1 the file header sits first, so the b-tree header starts at 100.
  const start = base + (page === 1 ? PAGE_HEADER : 0)
  const type = db[start]
  const cells = db.readUInt16BE(start + 3)
  // Cell pointers are relative to the page, not to the b-tree header.
  const pointerBase = base + (page === 1 ? PAGE_HEADER : 0) + (type === 0x05 ? 12 : 8)

  if (type === 0x0d) {
    for (let i = 0; i < cells; i += 1) {
      const cell = base + db.readUInt16BE(pointerBase + i * 2)
      const size = varint(db, cell)
      const rowid = varint(db, size.next)
      out.push(decodeRecord(db.subarray(rowid.next, rowid.next + size.value)))
    }
    return
  }

  if (type === 0x05) {
    for (let i = 0; i < cells; i += 1) {
      const cell = base + db.readUInt16BE(pointerBase + i * 2)
      walk(db, db.readUInt32BE(cell), out)
    }
    return
  }

  throw new Error(`unexpected b-tree page type 0x${type.toString(16)}`)
}

/** Reads the whole file into memory and returns its pages. */
function load(file) {
  const db = readFileSync(file)
  if (db.subarray(0, 16).toString('latin1') !== MAGIC) throw new Error('not an SQLite database')
  return db
}

/** Column names of a table, read from sqlite_master. */
function schemaRow(db, table) {
  const statements = []
  walk(db, 1, statements)
  // sqlite_master columns: 0 type, 1 name, 2 tbl_name, 3 rootpage, 4 sql.
  const row = statements.find((entry) => String(entry[0]) === 'table' && String(entry[1]) === table)
  if (!row) throw new Error(`no such table: ${table}`)
  return row
}

function columns(db, table) {
  const sql = String(schemaRow(db, table)[4])
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'))
  return body
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0].replace(/["`'\[]/g, ''))
    .filter(Boolean)
}

/**
 * Reads `name` and `hex(encrypted_value)` for the given hosts out of a cookie
 * database, mirroring the query `findCookies` used to send to sqlite3.
 */
export function readCookies(file, hosts) {
  if (hasSqliteCli()) {
    const query = `select host_key,name,hex(encrypted_value) as hex from cookies where host_key in (${hosts
      .map((host) => `'${host}'`)
      .join(',')})`
    // spawnSync, not execFileSync: on this platform execFileSync can hand the
    // child a closed stdin, so a database that does not exist yet stays empty.
    const run = spawnSync('sqlite3', [file, '-json', query], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`sqlite3 failed: ${String(run.stderr).trim()}`)
    return run.stdout.trim() ? JSON.parse(run.stdout) : []
  }

  const db = load(file)
  const schema = schemaRow(db, 'cookies')
  const names = columns(db, 'cookies')
  const hostIndex = names.indexOf('host_key')
  const nameIndex = names.indexOf('name')
  const valueIndex = names.indexOf('encrypted_value')
  if (hostIndex < 0 || nameIndex < 0 || valueIndex < 0) throw new Error('cookies table has an unexpected schema')

  // The table has its own root page; page 1 holds sqlite_master, not the rows.
  const rootPage = Number(schema[3])

  const rows = []
  walk(db, rootPage, rows)
  return rows
    .filter((row) => hosts.includes(String(row[hostIndex])))
    .map((row) => ({
      host_key: String(row[hostIndex]),
      name: String(row[nameIndex]),
      hex: Buffer.from(row[valueIndex] ?? []).toString('hex'),
    }))
}

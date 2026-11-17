/** Dependency-free JSONC edits that preserve unrelated settings and comments. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function withoutComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '))
}

export function parseConfig(text) {
  const json = withoutComments(text.replace(/^\uFEFF/, ''))
    .replace(/"(?:\\.|[^"\\])*"|,\s*[}\]]/g, (token) => token.startsWith('"') ? token : token.slice(1))
  const value = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenCode config must be an object')
  return value
}

/** Both global documents are loaded by OpenCode; keep our entry consistent. */
export function configPaths(explicit, env = process.env, home = homedir()) {
  if (explicit || env.OPENCODE_CONFIG) return [path.resolve(explicit || env.OPENCODE_CONFIG)]
  const root = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
  const files = ['opencode.json', 'opencode.jsonc'].map((name) => path.join(root, name)).filter(existsSync)
  return files.length ? files : [path.join(root, 'opencode.json')]
}

function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i + 1
  }
  throw new Error('unterminated config string')
}

function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start)
  if ('{['.includes(text[start])) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '"') i = stringEnd(text, i) - 1
      else if ('{['.includes(text[i])) depth++
      else if ('}]'.includes(text[i]) && --depth === 0) return i + 1
    }
  }
  let i = start
  while (i < text.length && !/[\s,}]/.test(text[i])) i++
  return i
}

function members(text, start) {
  const result = []
  let i = start + 1
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++ }
  for (;;) {
    space()
    if (text[i] === '}') return { entries: result, end: i }
    const keyStart = i
    i = stringEnd(text, i)
    const key = JSON.parse(text.slice(keyStart, i))
    space()
    i++ // colon; parseConfig has already validated the document
    space()
    const start = i
    i = valueEnd(text, i)
    const end = i
    space()
    const comma = text[i] === ',' ? i++ : null
    result.push({ key, keyStart, start, end, comma })
  }
}

/** Set/delete one path; an undefined value deletes it without creating parents. */
export function editConfig(text, keys, value) {
  parseConfig(text)
  const clean = withoutComments(text)
  let objectStart = clean.indexOf('{')
  for (let depth = 0; depth < keys.length; depth++) {
    const object = members(clean, objectStart)
    const index = object.entries.findLastIndex((entry) => entry.key === keys[depth])
    const entry = object.entries[index]
    const last = depth === keys.length - 1
    if (entry && !last) {
      if (clean[entry.start] !== '{') throw new Error(`config ${keys.slice(0, depth + 1).join('.')} must be an object`)
      objectStart = entry.start
      continue
    }
    if (!entry && value === undefined) return text
    const indent = '  '.repeat(depth + 1)
    if (entry && value === undefined) {
      const previous = object.entries[index - 1]
      const start = entry.comma === null && previous ? previous.comma : entry.keyStart
      const end = entry.comma === null ? entry.end : entry.comma + 1
      return text.slice(0, start) + text.slice(end)
    }
    let replacement = value
    for (let j = keys.length - 1; j > depth; j--) replacement = { [keys[j]]: replacement }
    const rendered = JSON.stringify(replacement, null, 2).replace(/\n/g, `\n${indent}`)
    if (entry) return text.slice(0, entry.start) + rendered + text.slice(entry.end)
    const previous = object.entries.at(-1)
    const position = previous?.end ?? objectStart + 1
    const addition = `${previous ? ',' : ''}\n${indent}${JSON.stringify(keys[depth])}: ${rendered}${previous?.comma != null ? '' : '\n' + '  '.repeat(depth)}`
    return text.slice(0, position) + addition + text.slice(position)
  }
  throw new Error('a config key is required')
}

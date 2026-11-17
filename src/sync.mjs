#!/usr/bin/env node
/** Register the local proxy in OpenCode V2 without replacing other providers. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { port, providerID } from './lib/config.mjs'
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL, MODELS, modelIds } from './lib/models.mjs'
import { configPaths, editConfig, parseConfig } from './lib/opencode-config.mjs'
import { log, warn } from './lib/log.mjs'

const args = process.argv.slice(2)
const index = args.indexOf('--config')
if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) {
  throw new Error('--config requires a file path')
}
const provider = {
  name: 'Venice Web (unlimited)',
  package: '@opencode/ai/providers/openai-compatible',
  settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: providerID },
  models: Object.fromEntries(modelIds.map((id) => {
    const model = MODELS[id]
    return [id, {
      name: model.name,
      capabilities: {
        tools: true,
        input: model.vision ? ['text', 'image'] : ['text'],
        output: ['text'],
        reasoning: { supported: model.reasoning },
      },
      compatibility: { reasoningField: 'reasoning_content' },
      limit: { context: model.context, output: model.output },
    }]
  })),
}

// Validate all files before writing any, so a broken higher-priority JSONC
// document cannot leave a half-updated global provider configuration.
const updates = configPaths(index >= 0 ? args[index + 1] : undefined).map((file) => {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n'
  const config = parseConfig(text)
  const set = (keys, value) => { text = editConfig(text, keys, value) }
  set(['provider', providerID], undefined)
  if (config.provider && Object.keys(config.provider).every((id) => id === providerID)) set(['provider'], undefined)
  if (args.includes('--remove')) {
    set(['providers', providerID], undefined)
    if (String(config.model ?? '').startsWith(`${providerID}/`)) set(['model'], undefined)
    if (String(config.small_model ?? '').startsWith(`${providerID}/`)) set(['small_model'], undefined)
    if (String(config.agents?.title?.model ?? '').startsWith(`${providerID}/`)) set(['agents', 'title', 'model'], undefined)
  } else {
    if (!config.$schema) set(['$schema'], 'https://opencode.ai/config.json')
    set(['providers', providerID], provider)
    if (args.includes('--default')) {
      set(['model'], `${providerID}/${DEFAULT_MODEL}`)
      set(['agents', 'title', 'model'], `${providerID}/${DEFAULT_SMALL_MODEL}`)
    }
  }
  parseConfig(text)
  return { file, text }
})

for (const { file, text } of updates) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
  log(`updated ${file} - provider "${providerID}" ${args.includes('--remove') ? 'removed' : `with ${modelIds.length} chat models`}`)
}
if (args.includes('--default')) log(`default model: ${providerID}/${DEFAULT_MODEL}`)
if (!args.includes('--remove')) warn('OpenCode reloads config automatically. If a model is hidden, enable it in Settings > Models.')

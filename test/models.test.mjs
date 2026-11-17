/**
 * Guards the model catalogue itself: a refresh may drop ids, but never the
 * default one, and never silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL, MODELS, imageModelIds, modelIds } from '../src/lib/models.mjs'

test('DEFAULT_MODEL is a real catalogue id', () => {
  assert.equal(typeof DEFAULT_MODEL, 'string')
  assert.ok(MODELS[DEFAULT_MODEL], `DEFAULT_MODEL missing from MODELS: ${DEFAULT_MODEL}`)
  assert.ok(modelIds.includes(DEFAULT_MODEL))
})

test('the fork catalogue retains DeepSeek 1017 and its original limits', () => {
  assert.ok(modelIds.includes('deepseek-v4-1-flash-1017'))
  assert.equal(MODELS['deepseek-v4-1-flash-1017'].context, 1000000)
  assert.equal(MODELS['deepseek-v4-1-flash-1017'].output, 131072)
})

test('DEFAULT_SMALL_MODEL is a real catalogue id', () => {
  assert.ok(MODELS[DEFAULT_SMALL_MODEL], `DEFAULT_SMALL_MODEL missing from MODELS: ${DEFAULT_SMALL_MODEL}`)
})

test('every catalogue entry is well formed', () => {
  for (const [id, model] of Object.entries(MODELS)) {
    assert.equal(typeof model.name, 'string', `${id}: name`)
    assert.ok(model.name.length > 0, `${id}: empty name`)
    // image models carry no token limits; the chat shape would only lie
    if (model.kind === 'image') continue
    assert.ok(Number.isInteger(model.context) && model.context > 0, `${id}: context`)
    assert.ok(Number.isInteger(model.output) && model.output > 0, `${id}: output`)
    assert.ok(model.output <= model.context, `${id}: output exceeds context`)
    assert.equal(typeof model.reasoning, 'boolean', `${id}: reasoning`)
  }
})

test('modelIds is the chat models only', () => {
  assert.deepEqual(modelIds, Object.keys(MODELS).filter((id) => MODELS[id].kind !== 'image'))
  for (const id of imageModelIds) assert.equal(MODELS[id].kind, 'image', `${id}: not an image model`)
})

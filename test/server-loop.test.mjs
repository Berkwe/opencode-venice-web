import test from 'node:test'
import assert from 'node:assert/strict'
import { collectStream } from '../src/lib/server.mjs'
import { NATIVE_CALL_REMINDER, preferAnswer, serverLoopMessage, shouldRetry } from '../src/lib/emulate.mjs'

const sse = (events, { close = true } = {}) => {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      // an open stream is what a live upstream looks like; only then does cancel() reach it
      if (close) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return { body, wasCancelled: () => cancelled }
}

// one Venice agent step: a tool_call_generation item, with the native call it detected
const step = (n, name = 'bash') => [
  { type: 'response.output_item.added', output_index: n, item: { type: 'veniceai:tool_call_generation', id: `tcg_agent-node:llm:${n}` } },
  { type: 'veniceai:tool_call_generation.in_progress', item_id: `tcg_agent-node:llm:${n}`, detected_tools: [{ type: 'Unrecognized', name }] },
  { type: 'response.output_item.done', output_index: n, item: { type: 'veniceai:tool_call_generation', id: `tcg_agent-node:llm:${n}`, status: 'completed' } },
]
const message = (index, text) => [
  { type: 'response.output_item.added', output_index: index, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: index, delta: text },
  { type: 'response.completed' },
]

async function drain(generator) {
  for (;;) {
    const { value, done } = await generator.next()
    if (done) return value
  }
}

const mapping = { emulatedTools: true, request: { modelId: 'm' } }
const chunk = (delta) => ({ delta })

test('collectStream stops a Venice tool loop past three steps', async () => {
  const events = [...step(0), ...step(1), ...step(2), ...step(3), ...step(4), ...message(5, 'gave up')]
  const { body, wasCancelled } = sse(events, { close: false })
  const state = await drain(collectStream(body, mapping, chunk, { stopServerLoop: true }))
  assert.equal(state.serverLoop, true)
  // cut on the second stuck step: native call detected, no text yet
  assert.equal(state.steps.size, 2)
  assert.deepEqual([...state.nativeTools], ['bash'])
  assert.equal(state.text, '')
  assert.equal(wasCancelled(), true)
})

test('collectStream cuts a native call early, before Venice can loop on it', async () => {
  const events = [...step(0), ...step(1), ...step(2), ...message(3, 'gave up')]
  const state = await drain(collectStream(sse(events).body, mapping, chunk, { stopServerLoop: true }))
  assert.equal(state.serverLoop, true)
  assert.equal(state.steps.size, 2)
  assert.equal(state.text, '')
})

test('collectStream keeps a reply that arrived before the native call', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: '{"content":"x"' },
    ...step(1),
    ...step(2),
    ...step(3),
    ...message(4, 'gave up'),
  ]
  const state = await drain(collectStream(sse(events).body, mapping, chunk, { stopServerLoop: true }))
  // text is already there, so the early cut does not fire and only the 3-step
  // ceiling applies - which the recovery reply then completes
  assert.equal(state.serverLoop, false)
  assert.equal(state.steps.size, 3)
  assert.equal(state.text, '{"content":"x"gave up')
})

test('collectStream lets a short recovery through', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: '{"content":""' },
    ...step(1),
    ...step(2),
    ...message(3, '","status":"continue","tool_calls":[]}'),
  ]
  const state = await drain(collectStream(sse(events).body, mapping, chunk, { stopServerLoop: true }))
  assert.equal(state.serverLoop, false)
  assert.equal(state.terminal, true)
  assert.match(state.text, /status/)
})

test('collectStream reads a loop to the end when stopping is off (last retry)', async () => {
  const events = [...step(0), ...step(1), ...step(2), ...step(3), ...step(4), ...message(5, 'gave up')]
  const state = await drain(collectStream(sse(events).body, mapping, chunk, { stopServerLoop: false }))
  assert.equal(state.serverLoop, false)
  assert.equal(state.text, 'gave up')
})

test('shouldRetry: a stopped Venice loop is retried with the native-call reminder', () => {
  assert.deepEqual(shouldRetry({ message: serverLoopMessage(), lastRole: 'tool' }), {
    retry: true,
    reason: 'venice tool loop',
    reminder: NATIVE_CALL_REMINDER,
  })
})

test('preferAnswer: any real reply beats a stopped loop', () => {
  const answer = { content: 'Toplam 20', tool_calls: null, sawEnvelope: true }
  assert.equal(preferAnswer(answer, serverLoopMessage()), true)
  assert.equal(preferAnswer(serverLoopMessage(), answer), false)
})

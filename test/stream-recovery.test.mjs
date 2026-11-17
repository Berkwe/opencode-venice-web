import test from 'node:test'
import assert from 'node:assert/strict'
import { openaiChunks } from '../src/lib/server.mjs'
import { toVeniceRequest } from '../src/lib/emulate.mjs'
import { DEFAULT_MODEL } from '../src/lib/models.mjs'

const trace = { log() {}, warn() {} }
const encoder = new TextEncoder()
const stream = (events) => new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
    controller.close()
  },
})
const text = (value, end = 'response.completed') => [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, delta: value },
  ...(end ? [{ type: end }] : []),
]
const toolReply = JSON.stringify({ content: '', status: 'continue', tool_calls: [{ name: 'read', arguments: { path: 'a.txt' } }] })
const native = (name = 'read', type = 'Unrecognized') => ({
  type: 'veniceai:tool_call_generation.in_progress', detected_tools: [{ name, type }],
})
const body = {
  model: DEFAULT_MODEL,
  messages: [{ role: 'user', content: 'Read a.txt' }],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
}
const drain = async (generator) => {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}
const response = (events) => ({ ok: true, body: stream(events) })
const calls = (chunks) => chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])

for (const ending of ['response.incomplete', null]) {
  test(`a partial envelope is retried, never dispatched (${ending ?? 'EOF'})`, async () => {
    const mapping = toVeniceRequest(body)
    mapping.images = [{ mediaId: 'test-image' }]
    let attempts = 0
    const chunks = await drain(openaiChunks(body, mapping, stream(text(toolReply.replace('a.txt', 'partial.txt'), ending)), undefined, trace, {
      chat: async (request, path, signal, images) => {
        attempts++
        assert.equal(request.reasoningMode, 'disabled')
        assert.equal(images, mapping.images)
        return response(text(toolReply))
      },
    }))
    assert.equal(attempts, 1)
    assert.equal(calls(chunks).length, 1)
    assert.equal(calls(chunks)[0].function.arguments, '{"path":"a.txt"}')
  })
}

test('native external failures cannot escape as a final answer after retry exhaustion', async () => {
  const events = [native(), ...text('{"content":"The external tools are broken","status":"done","tool_calls":[]}')]
  let attempts = 0
  const chunks = await drain(openaiChunks(body, toVeniceRequest(body), stream(events), undefined, trace, {
    chat: async () => { attempts++; return response(events) },
  }))
  const content = chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('')
  assert.equal(attempts, 2)
  assert.equal(calls(chunks).length, 0)
  assert.match(content, /Proxy tool-call recovery failed/)
  assert.doesNotMatch(content, /external tools are broken/)
})

test('legitimate Venice built-ins do not taint a completed final answer', async () => {
  const toolBody = { ...body, messages: [...body.messages, { role: 'tool', content: 'file contents', tool_call_id: 'call-1' }] }
  const events = [native('view_media', 'view_media'), ...text('{"content":"The image is red","status":"done","tool_calls":[]}')]
  let attempts = 0
  const chunks = await drain(openaiChunks(toolBody, toVeniceRequest(toolBody), stream(events), undefined, trace, {
    chat: async () => { attempts++; throw new Error('unexpected retry') },
    judge: async () => ({ verdict: 'finished' }),
  }))
  assert.equal(attempts, 0)
  assert.match(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join(''), /The image is red/)
})

test('a valid envelope after native external rounds is accepted without a retry', async () => {
  const events = [native(), ...text(toolReply)]
  const chunks = await drain(openaiChunks(body, toVeniceRequest(body), stream(events), undefined, trace, {
    chat: async () => { throw new Error('unexpected retry') },
  }))
  assert.equal(calls(chunks).length, 1)
})

test('an incomplete correction never replaces a completed answer or dispatches partial calls', async () => {
  const toolBody = { ...body, messages: [...body.messages, { role: 'tool', content: 'file contents', tool_call_id: 'call-1' }] }
  let attempts = 0
  const chunks = await drain(openaiChunks(toolBody, toVeniceRequest(toolBody),
    stream(text('{"content":"Original answer","status":"done","tool_calls":[]}')), undefined, trace, {
      judge: async () => ({ verdict: 'missing_result' }),
      chat: async () => { attempts++; return response(text(toolReply, 'response.incomplete')) },
    }))
  assert.equal(attempts, 1)
  assert.equal(calls(chunks).length, 0)
  assert.match(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join(''), /Original answer/)
})

for (const failure of ['network', 503, 429]) {
  test(`a transient recovery failure uses the remaining retry budget (${failure})`, async () => {
    let attempts = 0
    const chunks = await drain(openaiChunks(body, toVeniceRequest(body), stream(text('not an envelope')), undefined, trace, {
      chat: async () => {
        if (++attempts === 1) {
          if (failure === 'network') throw new Error('temporary network error')
          return { ok: false, status: failure, body: stream([]) }
        }
        return response(text(toolReply))
      },
    }))
    assert.equal(attempts, 2)
    assert.equal(calls(chunks).length, 1)
  })
}

test('authentication failures do not spend extra retries', async () => {
  let attempts = 0
  await drain(openaiChunks(body, toVeniceRequest(body), stream(text('not an envelope')), undefined, trace, {
    chat: async () => { attempts++; return { ok: false, status: 401, body: stream([]) } },
  }))
  assert.equal(attempts, 1)
})

test('an aborted recovery is not retried', async () => {
  const controller = new AbortController()
  const reason = new Error('client disconnected')
  let attempts = 0
  await assert.rejects(drain(openaiChunks(body, toVeniceRequest(body), stream(text('not an envelope')), controller.signal, trace, {
    chat: async () => { attempts++; controller.abort(reason); throw reason },
  })), (error) => error === reason)
  assert.equal(attempts, 1)
})

test('exhausted incomplete replies never dispatch partial tool calls', async () => {
  let attempts = 0
  await assert.rejects(drain(openaiChunks(body, toVeniceRequest(body), stream(text(toolReply, 'response.incomplete')), undefined, trace, {
    chat: async () => { attempts++; return response(text(toolReply, 'response.incomplete')) },
  })), /stream ended before response.completed/)
  assert.equal(attempts, 2)
})

test('incomplete non-emulated streams still fail explicitly', async () => {
  const plain = { model: DEFAULT_MODEL, messages: body.messages }
  await assert.rejects(drain(openaiChunks(plain, toVeniceRequest(plain), stream(text('partial', 'response.incomplete')), undefined, trace)), /generation was incomplete/)
})

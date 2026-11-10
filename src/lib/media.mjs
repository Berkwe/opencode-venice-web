/**
 * Image attachments (vision input).
 *
 * The web app does not send images inline in the chat body. It uploads the file
 * to `POST /api/v2/agents/media`, gets a `mediaId` back, puts an
 * `input_image` content part into the message that references it, and then - on
 * the next resubmission - sends the bytes again as a multipart file field named
 * after the `mediaId`, together with a `function_call_output` for the
 * `hydrate_content` step the backend inserts. Only that combination makes the
 * model actually see the image; a bare `input_image` part with an unknown id
 * yields an empty answer, because the server's hydration step has nothing to
 * resolve (measured 2026-11-10, all combinations: id-only, mediaManifest only,
 * mediaManifest + materialized, previousResponseId - empty; upload + hydrate
 * output + multipart file - "Red.").
 *
 * The upload and the multipart inference call both have to go through curl:
 * Cloudflare answers Node's fetch with a 403 on the multipart form as well.
 *
 * So this module does two things:
 *  - `uploadImage()` puts an OpenAI `image_url` (data: URL, http URL or local
 *    file) onto Venice and returns the `mediaId`.
 *  - `hydratedChat()` runs the two-phase request: send the message with the
 *    `input_image` part, read the `hydrate_content` call out of the stream, and
 *    resubmit with the file attached.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { apiBase } from './config.mjs'
import { curlFetch, curlMultipartFetch } from './curl.mjs'
import { SignInError, loadSession, mintToken } from './venice.mjs'

const UPLOAD_PATH = '/api/v2/agents/media'
const MAX_BYTES = 25 * 1024 * 1024

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** `data:image/png;base64,...` -> { mimeType, bytes } */
export function parseDataUrl(url) {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(url)
  if (!match) throw new Error('image_url is not a data: URL')
  const mimeType = match[1].toLowerCase()
  if (!mimeType.startsWith('image/')) throw new Error(`unsupported attachment type: ${mimeType}`)
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw new Error('empty image data')
  return { mimeType, bytes }
}

/** Reads one OpenAI image part into bytes + mime type. */
async function readImage(part) {
  const url = typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url
  if (!url) throw new Error('image part has no image_url')
  if (url.startsWith('data:')) return parseDataUrl(url)
  if (/^https?:\/\//.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`could not download ${url} (HTTP ${response.status})`)
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    const bytes = Buffer.from(await response.arrayBuffer())
    return { mimeType: mimeType.startsWith('image/') ? mimeType : 'image/png', bytes }
  }
  const file = url.startsWith('file://') ? new URL(url).pathname : path.resolve(url)
  const mimeType = MIME_BY_EXT[path.extname(file).toLowerCase()]
  if (!mimeType) throw new Error(`unsupported image extension: ${file}`)
  return { mimeType, bytes: readFileSync(file) }
}

/** Uploads one image and returns its `mediaId`. */
async function uploadImage(part) {
  const { mimeType, bytes } = await readImage(part)
  if (bytes.length > MAX_BYTES) throw new Error(`image is larger than 25 MB (${bytes.length} bytes)`)
  const session = await loadSession()
  const access = await mintToken()
  // multipart body: `curlFetch` would drop the `files` option and send no file
  const response = await curlMultipartFetch(apiBase + UPLOAD_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      'user-agent': session.userAgent,
      origin: 'https://venice.ai',
      referer: 'https://venice.ai/',
      cookie: `__client=${session.client}`,
    },
    files: [{ field: 'file', filename: `image${mimeType === 'image/png' ? '.png' : '.bin'}`, contentType: mimeType, data: bytes }],
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 401) throw new SignInError('Venice rejected the media upload (HTTP 401)')
    throw new Error(`media upload failed (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
  const data = await response.json()
  if (!data?.mediaId) throw new Error('media upload returned no mediaId')
  return { mediaId: data.mediaId, mimeType, bytes }
}

/**
 * Replaces `image_url` parts of the newest user turn with `input_image` parts and
 * returns the attachments that still have to be sent.
 *
 * Only the last user turn is uploaded: the same image would otherwise be sent
 * on every turn of the session. Older turns keep their `[image]` text marker.
 */
export async function attachImages(messages) {
  const lastUser = [...(messages ?? [])].reverse().find((message) => message.role === 'user')
  if (!lastUser || !Array.isArray(lastUser.content)) return []
  const attachments = []
  const content = []
  for (const part of lastUser.content) {
    if (part?.type === 'image_url') {
      const uploaded = await uploadImage(part)
      attachments.push(uploaded)
      content.push({ type: 'input_image', media_id: uploaded.mediaId, mime_type: uploaded.mimeType, detail: 'auto' })
      continue
    }
    content.push(part)
  }
  lastUser.content = content
  return attachments
}

/**
 * Sends the request and, when it carries attachments, resubmits it once with the
 * files attached and the tool step already answered.
 *
 * The backend asks for that step with a `hydrate_content` call while the model has
 * not written anything yet; when it wrote text first, the step arrives as a failed
 * `view_media` call instead. Both mean the same thing here - name the uploaded
 * media in a function_call_output - so both are answered the same way.
 */
export async function hydratedChat(request, { attachments, signal } = {}) {
  const session = await loadSession()
  const access = await mintToken()
  const headers = {
    authorization: `Bearer ${access}`,
    'content-type': 'application/json',
    'user-agent': session.userAgent,
    origin: 'https://venice.ai',
    referer: 'https://venice.ai/',
    cookie: `__client=${session.client}`,
    'x-venice-middleface-version': '0.1.1128',
    'x-venice-request-timestamp-ms': String(Date.now()),
  }
  const url = apiBase + '/api/inference/chat/agents/ad-hoc'
  const first = await curlFetch(url, { method: 'POST', headers, body: JSON.stringify(request), signal })
  if (!attachments?.length || !first.ok) return first

  const raw = await first.text()
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
  const step = readHydration(raw) ?? readFailedViewMedia(raw)
  if (!step) return textResponse(raw)

  // The resubmission repeats the whole conversation, this time with the image
  // parts in place and the tool step already answered.
  const second = { ...request }
  const parts = attachments.flatMap((item) => [
    { type: 'input_image', media_id: item.mediaId, mime_type: item.mimeType, detail: 'auto' },
  ])
  second.messages = request.messages.map((message) =>
    message.id === lastUser?.id ? { ...message, content: [...parts, ...message.content] } : message,
  )
  second.messages.push(step.call, step.output)
  // multipart, so `content-type` must not claim JSON: with it the backend answers
  // "Invalid JSON request" and never parses the form
  const { 'content-type': _contentType, ...multipartHeaders } = headers
  return curlMultipartFetch(url, {
    method: 'POST',
    headers: multipartHeaders,
    fields: { request: JSON.stringify(second) },
    files: attachments.map((item) => ({ field: item.mediaId, filename: `image.${item.mimeType.split('/')[1] ?? 'png'}`, contentType: item.mimeType, data: item.bytes })),
    signal,
  })
}

/**
 * Reads the step the backend asks for out of an SSE body: the `hydrate_content`
 * call, or - when the model wrote text before asking - the failed `view_media`
 * call. Returns the call plus the output that answers it, or null.
 */
function readHydration(raw) {
  let call = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') break
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    const item = event.item
    if (item?.type === 'function_call' && item.name === 'hydrate_content' && item.call_id && item.arguments) {
      call = item
    }
  }
  if (!call) return null
  const args = safeJson(call.arguments)
  const mediaIds = args.media_ids ?? []
  return stepOf(call, Object.fromEntries(mediaIds.map((id) => [id, { media_id: id, mime_type: 'image/png' }])))
}

/** Reads the failed `view_media` call out of an SSE body, if there is one. */
function readFailedViewMedia(raw) {
  let call = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    let event
    try {
      event = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    const item = event.item
    if (item?.type === 'veniceai:server_function_call' && item.name === 'view_media' && item.status === 'failed') {
      call = item
    }
  }
  if (!call) return null
  const args = safeJson(call.arguments)
  const mediaIds = args.media_ids ?? []
  return stepOf(call, Object.fromEntries(mediaIds.map((id) => [id, { media_id: id, mime_type: 'image/png' }])))
}

/** The `function_call` / `function_call_output` pair that answers a tool step. */
function stepOf(call, items) {
  return {
    call: { id: call.id, type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments, status: 'completed' },
    output: { id: `${call.id}_output`, type: 'function_call_output', call_id: call.call_id, status: 'completed', output: JSON.stringify({ items }) },
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value ?? '{}')
  } catch {
    return {}
  }
}

/** A Response over an already-read SSE body. */
function textResponse(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Text-to-image over the Venice web inference route.
 *
 * The web studio posts to `POST /api/inference/image` on the inference host and
 * gets the raw bytes back (no JSON envelope, no CDN URL): the catalogue flags
 * these models with `supportsBinaryResponse: true`. Measured on 2026-11-10 against
 * the web session:
 *
 *   modelId: '<id>'  400 modelNotFound   (the studio sends `model`)
 *   model:   '<id>'  200 image/png|image/webp
 *
 * So the upstream body uses `model`, `width`/`height` and `format`, and the reply
 * is read as an ArrayBuffer and handed on as base64. Only the models the web
 * catalogue marks `usesCredits: false` are offered (see `models.mjs`).
 *
 * `seed`, `requestId`, `hideWatermark` and `matureFilter` are all required by the
 * endpoint (`400 Invalid request` otherwise). A repeated seed does **not** give a
 * byte-identical image (measured twice), so it only makes runs comparable.
 */
import { randomUUID } from 'node:crypto'

import { apiBase, requestTimeoutMs } from './config.mjs'
import { IMAGE_PATH, SignInError, mintToken, veneziaFetch } from './venice.mjs'

/** `size` strings (OpenAI `1024x1024`) to pixels; anything else falls back to 512². */
function dimensions(size) {
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(String(size ?? '').trim())
  if (!match) return { width: 512, height: 512 }
  const clamp = (value) => Math.min(1536, Math.max(256, Number(value)))
  return { width: clamp(match[1]), height: clamp(match[2]) }
}

/**
 * Generates one image and returns it as base64. Retries once with a fresh token
 * on 401, like `upstreamChat`.
 *
 * @param {{ model: string, prompt: string, size?: string, seed?: number, steps?: number, negativePrompt?: string }} options
 * @returns {Promise<{ b64: string, contentType: string }>}
 */
export async function generateImage({ model, prompt, size, seed, steps, negativePrompt, signal } = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt must not be empty')

  const { width, height } = dimensions(size)
  const timeout = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
    : AbortSignal.timeout(requestTimeoutMs)

  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await mintToken({ force: attempt > 0 })
    const body = JSON.stringify({
      model,
      prompt,
      width,
      height,
      format: 'png',
      seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 1_000_000_000),
      requestId: randomUUID(),
      type: 'image',
      variants: 1,
      hideWatermark: false,
      matureFilter: false,
      ...(Number.isFinite(steps) ? { steps } : {}),
      ...(negativePrompt ? { negativePrompt } : {}),
    })
    const response = await veneziaFetch(apiBase + IMAGE_PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        // the studio sends no `accept` here; `text/event-stream` gets the route
        // blocked by Cloudflare just like on the chat path
        'x-venice-middleface-version': '0.1.1128',
        'x-venice-request-timestamp-ms': String(Date.now()),
      },
      body,
      signal: timeout,
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) throw new SignInError(`image request rejected (HTTP 401): ${text.slice(0, 200)}`)
      throw new Error(`Venice image endpoint responded HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new Error('Venice returned an empty image')
    return { b64: bytes.toString('base64'), contentType: response.headers.get('content-type') ?? 'image/png' }
  }
  throw new Error('Venice image request failed')
}

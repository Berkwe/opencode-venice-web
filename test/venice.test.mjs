import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { atomicWritePrivateFile } from '../src/lib/private-file.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'venice-client-test-'))
process.env.VENICE_WEB_SESSION = path.join(dir, 'session.json')
process.env.VENICE_WEB_TRANSPORT = 'fetch'
const { SignInError, loadSession, mintToken, resetSessionCache, upstreamChat, veneziaFetch } = await import('../src/lib/venice.mjs')
const file = process.env.VENICE_WEB_SESSION
const jwt = (sub = 'user-test') => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub })).toString('base64url')}.signature`
const saved = () => JSON.parse(readFileSync(file, 'utf8'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
test.beforeEach(() => {
  resetSessionCache()
  atomicWritePrivateFile(file, JSON.stringify({ client: 'test-cookie', userAgent: 'test UA', uid: 'user-test', sessionId: 'sid-test', access: jwt(), expires: 0 }))
})

test('concurrent startup and token mint share one session and persist rotated credentials', async (t) => {
  let mints = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /^https:\/\/clerk\.venice\.ai\/v1\/client\/sessions\/sid-test\/tokens/)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.get('cookie'), '__client=test-cookie')
    mints++
    return Response.json({ jwt: jwt() }, { headers: { 'set-cookie': '__client=rotated-test-cookie; Path=/' } })
  })
  const tokens = await Promise.all(Array.from({ length: 8 }, () => mintToken()))
  assert.equal(mints, 1)
  assert.equal(new Set(tokens).size, 1)
  assert.equal(saved().client, 'rotated-test-cookie')
  assert.equal(saved().access, tokens[0])
  assert.ok(saved().expires > Date.now())
})

test('a rejected Clerk session is rediscovered before the next mint', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++
    if (calls === 1) return new Response('', { status: 401 })
    if (calls === 2) return Response.json({ response: { sessions: [
      { id: 'wrong', status: 'active', user: { id: 'other-user' } },
      { id: 'new-id', status: 'active', user: { id: 'user-test' } },
    ] } })
    assert.match(url, /\/sessions\/new-id\/tokens/)
    return Response.json({ jwt: jwt() })
  })
  await mintToken()
  assert.equal(calls, 3)
  assert.equal(saved().sessionId, 'new-id')
})

test('an account switch in a minted token is rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ jwt: jwt('other-user') }))
  await assert.rejects(mintToken(), /account changed/)
})

test('inference refreshes a 401 token and preserves multipart image bytes', async (t) => {
  let inference = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'error')
    if (url.includes('/tokens')) return Response.json({ jwt: jwt() })
    if (url.includes('/client_attestation/')) return Response.json({ token: 'test-attestation' })
    inference++
    assert.match(init.headers.get('content-type'), /^multipart\/form-data;/)
    assert.equal(init.headers.get('x-venice-client-attestation'), 'test-attestation')
    const form = await new Response(init.body, { headers: init.headers }).formData()
    assert.equal(JSON.parse(form.get('request')).modelId, 'test-model')
    assert.deepEqual(Buffer.from(await form.get('media.picture').arrayBuffer()), Buffer.from([0, 255, 128]))
    return new Response('answer', { status: inference === 1 ? 401 : 200 })
  })
  const response = await upstreamChat({ modelId: 'test-model' }, undefined, undefined, [{ mediaId: 'picture', mimeType: 'image/png', data: Buffer.from([0, 255, 128]) }])
  assert.equal(await response.text(), 'answer')
  assert.equal(inference, 2)
})

test('destination and Cloudflare guards fail closed', async (t) => {
  await assert.rejects(veneziaFetch('https://example.test/'), /unexpected upstream/)
  t.mock.method(globalThis, 'fetch', async () => new Response('challenge', { status: 403, headers: { 'content-type': 'text/html' } }))
  await assert.rejects(veneziaFetch('https://outerface.venice.ai/api/inference/test'), SignInError)
})

test('a missing or invalid session produces a sign-in error, not an upstream gateway error', async () => {
  rmSync(file)
  await assert.rejects(loadSession(), SignInError)
  atomicWritePrivateFile(file, 'not JSON')
  await assert.rejects(loadSession(), SignInError)
})

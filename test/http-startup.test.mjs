import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { createServer } from '../src/lib/server.mjs'

test('proxy serves health and models over loopback without browser login', async (t) => {
  const handler = createServer()
  const server = createHttpServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(error.message)
    })
  })
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  // The endpoint is live even when `ok` is false because no session is stored.
  assert.equal(typeof (await health.json()).ok, 'boolean')
  const models = await fetch(`${base}/v1/models`)
  assert.equal(models.status, 200)
  assert.ok((await models.json()).data.length > 0)
})

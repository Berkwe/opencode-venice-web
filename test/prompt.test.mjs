import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { createPrompter } from '../src/lib/prompt.mjs'

function fixture(terminal = false) {
  const input = new PassThrough()
  input.isTTY = terminal
  input.setRawMode = () => {}
  let output = ''
  const sink = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done() } })
  const prompt = createPrompter({ input, output: sink })
  return { input, prompt, output: () => output }
}

test('prompts preserve queued pipe lines and report EOF instead of hanging', async () => {
  const { input, prompt, output } = fixture()
  try {
    input.end('1\nprivate-token\n')
    assert.equal(await prompt.ask('choice: '), '1')
    assert.equal(await prompt.ask('token: ', { echo: false }), 'private-token')
    await assert.rejects(prompt.ask('again: '), /input closed/)
    assert.doesNotMatch(output(), /private-token/)
  } finally {
    prompt.close()
  }
})

test('a hidden terminal token is not echoed and raw mode is released on close', async () => {
  const { input, prompt, output } = fixture(true)
  let raw = false
  input.setRawMode = (value) => { raw = value }
  try {
    const answer = prompt.ask('token: ', { echo: false })
    input.write('private-token\r')
    assert.equal(await answer, 'private-token')
    assert.doesNotMatch(output(), /private-token/)
  } finally {
    prompt.close()
  }
  assert.equal(raw, false)
})

test('a multiline terminal paste cannot echo the token after the menu choice', async () => {
  const { input, prompt, output } = fixture(true)
  try {
    const choice = prompt.ask('choice: ')
    input.write('1\rprivate-token\r')
    assert.equal(await choice, '1')
    assert.equal(await prompt.ask('token: ', { echo: false }), 'private-token')
    assert.doesNotMatch(output(), /private-token/)
  } finally {
    prompt.close()
  }
})

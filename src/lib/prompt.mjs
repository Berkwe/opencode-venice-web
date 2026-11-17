/** Lazy terminal prompts: queued pipe input, hidden tokens, and explicit EOF. */
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  let muted = true
  let ended = false
  const lines = []
  const waiters = []
  const sink = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding)
      callback()
    },
  })
  const reader = createInterface({ input, output: sink, terminal: !!input.isTTY })
  reader.on('line', (line) => {
    // A multiline paste can include the next (secret) answer in this same
    // input chunk. Stop echoing immediately, before readline processes it.
    muted = true
    if (waiters.length) waiters.shift().resolve(line)
    else lines.push(line)
  })
  reader.on('close', () => {
    ended = true
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('input closed before an answer was entered'))
  })
  const nextLine = () => {
    if (lines.length) return Promise.resolve(lines.shift())
    if (ended) return Promise.reject(new Error('input closed before an answer was entered'))
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }
  return {
    async ask(question, { echo = true } = {}) {
      muted = !echo
      output.write(question)
      try {
        return (await nextLine()).trim()
      } finally {
        muted = true
        if (!echo && input.isTTY) output.write('\n')
      }
    },
    close() {
      reader.close()
      sink.end()
    },
  }
}

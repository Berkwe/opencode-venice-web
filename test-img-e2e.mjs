/**
 * Proxy'ye karşı: her renk 3 kez, stream bir kez, görselsiz bir kez.
 */
import { readFileSync } from 'node:fs'

const PORT = process.env.PORT ?? '3463'
const PROXY = `http://127.0.0.1:${PORT}/v1/chat/completions`
const MODEL = 'deepseek-v4-1-flash-1017'
const img = (file) => 'data:image/png;base64,' + readFileSync(file).toString('base64')

async function call(payload) {
  const started = Date.now()
  const r = await fetch(PROXY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const raw = await r.text()
  let answer = ''
  if (payload.stream) {
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('data: ')) continue
      const p = lines[i].slice(6)
      if (p === '[DONE]') continue
      try { answer += JSON.parse(p).choices?.[0]?.delta?.content ?? '' } catch { answer += ' <BAD>' }
    }
  } else {
    try { answer = JSON.parse(raw).choices?.[0]?.message?.content ?? '' } catch { answer = '<BAD:' + raw.slice(0, 120) + '>' }
  }
  return { status: r.status, answer: answer.trim(), ms: Date.now() - started }
}

const verdict = (want, answer) => want.some((w) => answer.toLowerCase().includes(w))
let pass = 0
let total = 0

for (const [file, want] of [['/data/data/com.termux/files/home/red.png', ['kirmizi', 'kırmızı', 'red', 'bordo']], ['/data/data/com.termux/files/home/green.png', ['yesil', 'yeşil', 'green']]]) {
  for (let i = 1; i <= 3; i++) {
    total++
    const out = await call({ model: MODEL, stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'Gorselin baskin rengi ne? Tek kelime.' }, { type: 'image_url', image_url: { url: img(file) } }] }] })
    const ok = out.status === 200 && verdict(want, out.answer)
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${file.split('/').pop()} #${i} ${out.status} ${out.ms}ms ${JSON.stringify(out.answer.slice(0, 120))}`)
  }
}

total++
const streamed = await call({ model: MODEL, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Gorselin baskin rengi ne? Tek kelime.' }, { type: 'image_url', image_url: { url: img('/data/data/com.termux/files/home/red.png') } }] }] })
const streamOk = streamed.status === 200 && verdict(['kirmizi', 'kırmızı', 'red', 'bordo'], streamed.answer)
if (streamOk) pass++
console.log(`${streamOk ? 'PASS' : 'FAIL'} red stream ${streamed.status} ${streamed.ms}ms ${JSON.stringify(streamed.answer.slice(0, 120))}`)

total++
const plain = await call({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'Merhaba, tek kelimeyle cevap ver: 2+2?' }] })
const plainOk = plain.status === 200 && plain.answer.length > 0
if (plainOk) pass++
console.log(`${plainOk ? 'PASS' : 'FAIL'} text-only ${plain.status} ${plain.ms}ms ${JSON.stringify(plain.answer.slice(0, 80))}`)

console.log(`SUMMARY ${pass}/${total}`)
process.exit(pass === total ? 0 : 1)

// Evaluate an expression in Claude Desktop's main process through the
// inspector it opens from Developer → Enable Main Process Debugger
// (127.0.0.1:9229). Usage: node cdp-main.mjs <file-with-expression>
import { readFileSync } from 'node:fs'

const expr = readFileSync(process.argv[2], 'utf8')
const list = await (await fetch('http://127.0.0.1:9229/json/list')).json()
const target = list.find((t) => t.type === 'node')
if (!target) throw new Error('no main-process inspector target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
const res = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  includeCommandLineAPI: true,
  timeout: 600000,
})
if (res.exceptionDetails) {
  console.error('EXCEPTION', JSON.stringify(res.exceptionDetails).slice(0, 2000))
  process.exitCode = 1
} else {
  const v = res.result.value
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
}
ws.close()

// The synthetic child host as a real process: stdout JSON lines + token-protected HTTP, as SPEC.md says.
// (The mod's own tests run in `claude plugin test`, where there is no process; this proves the fake
// host that the mod's tests stand in for speaks the protocol.)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST = join(here, 'fake-host.mjs')

function start(config) {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, FAKE_HOST_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const messages = []
  const waiters = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const message = JSON.parse(line)
      messages.push(message)
      for (const w of [...waiters]) {
        if (!w.match(message)) continue
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(message)
      }
    }
  })
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  const next = match =>
    new Promise((resolve, reject) => {
      const found = messages.find(match)
      if (found) return resolve(found)
      const timer = setTimeout(() => reject(new Error('timed out waiting for a host message')), 5000)
      waiters.push({
        match,
        resolve: m => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  return { child, messages, next, exited, stop: () => child.kill() }
}

async function rpc(ready, method, params, token = ready.token) {
  const response = await fetch(`http://127.0.0.1:${ready.port}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return { status: response.status, body: await response.json() }
}

async function withHost(config, body) {
  const host = start(config)
  try {
    await body(host, await host.next(m => m.type === 'ready'))
  } finally {
    host.stop()
    await host.exited
  }
}

test('ready carries port, a 32-byte token, tools, commands, prompt sections, interception, metadata', () =>
  withHost(
    { tools: [{ dshName: 'echo' }], commands: [{ name: 'c', description: 'd' }], promptSections: [{ id: 'p', text: 't' }], interception: true },
    (host, ready) => {
      assert.ok(Number.isInteger(ready.port) && ready.port > 0)
      assert.match(ready.token, /^[0-9a-f]{64}$/)
      assert.equal(ready.tools[0].dshName, 'echo')
      assert.equal(ready.tools[0].name, 'echo')
      assert.ok('inputSchema' in ready.tools[0] && 'description' in ready.tools[0])
      assert.deepEqual(ready.commands, [{ name: 'c', description: 'd' }])
      assert.deepEqual(ready.promptSections, [{ id: 'p', text: 't' }])
      assert.equal(ready.interception, true)
      assert.ok('metadata' in ready)
    },
  ))

test('a request without the token is refused; with it, tools.call / commands.run / status / interception answer', () =>
  withHost({ tools: [{ dshName: 'echo' }], interception: true }, async (host, ready) => {
    assert.equal((await rpc(ready, 'status', {}, 'wrong')).status, 401)

    const call = await rpc(ready, 'tools.call', { name: 'echo', args: { a: 1 }, callId: 'c1' })
    assert.deepEqual(call.body.result, { content: [{ type: 'text', text: '{"name":"echo","args":{"a":1}}' }], isError: false })
    assert.match((await rpc(ready, 'commands.run', { name: 'x', args: 'y z' })).body.result.text, /ran command x with args "y z"/)
    const status = (await rpc(ready, 'status', {})).body.result
    assert.deepEqual(Object.keys(status).sort(), ['plugin', 'services', 'state', 'tools', 'unsupported'])
    assert.equal((await rpc(ready, 'interception.pre', { tool: 'Bash', input: { command: 'forbidden' } })).body.result.decision, 'deny')
    assert.equal((await rpc(ready, 'interception.pre', { tool: 'Bash', input: { command: 'ls' } })).body.result.decision, 'allow')
    assert.equal((await rpc(ready, 'nope', {})).body.error.code, 'NO_METHOD')
  }))

test('a slow tool is cancelled by tools.cancel', () =>
  withHost({ tools: [{ dshName: 'slow', delayMs: 60000 }] }, async (host, ready) => {
    const pending = rpc(ready, 'tools.call', { name: 'slow', args: {}, callId: 'c9' })
    await new Promise(r => setTimeout(r, 100))
    assert.deepEqual((await rpc(ready, 'tools.cancel', { callId: 'c9' })).body.result, {})
    const done = (await pending).body.result
    assert.equal(done.isError, true)
    assert.match(done.content[0].text, /cancelled slow/)
  }))

test('a reverse request is sent on stdout and the tool waits for the reply', () =>
  withHost({ tools: [{ dshName: 'ask' }], reverse: 'approval' }, async (host, ready) => {
    const pending = rpc(ready, 'tools.call', { name: 'ask', args: { x: 1 }, callId: 'c2' })
    const request = await host.next(m => m.type === 'request')
    assert.equal(request.method, 'approval.request')
    assert.ok(typeof request.id === 'string')
    assert.deepEqual((await rpc(ready, 'reply', { id: request.id, result: { approved: true } })).body.result, {})
    const text = (await pending).body.result.content[0].text
    assert.deepEqual(JSON.parse(text), { method: 'approval.request', reply: { result: { approved: true } } })
  }))

test('a ui.ask reverse request carries one question with its options', () =>
  withHost({ tools: [{ dshName: 'ask' }], reverse: 'ask' }, async (host, ready) => {
    const pending = rpc(ready, 'tools.call', { name: 'ask', args: {}, callId: 'c3' })
    const request = await host.next(m => m.type === 'request')
    assert.equal(request.method, 'ui.ask')
    assert.deepEqual(request.params, { question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'] })
    await rpc(ready, 'reply', { id: request.id, result: { answer: 'Blue' } })
    assert.deepEqual(JSON.parse((await pending).body.result.content[0].text), { method: 'ui.ask', reply: { result: { answer: 'Blue' } } })
  }))

test('toolsChanged and promptChanged are announced', () =>
  withHost({ tools: [{ dshName: 'grow' }, { dshName: 'reprompt' }] }, async (host, ready) => {
    await rpc(ready, 'tools.call', { name: 'grow', args: {}, callId: 'a' })
    assert.equal((await host.next(m => m.type === 'toolsChanged')).tools.length, 3)
    await rpc(ready, 'tools.call', { name: 'reprompt', args: {}, callId: 'b' })
    assert.equal((await host.next(m => m.type === 'promptChanged')).promptSections[0].id, 'later')
  }))

test('fatal: the real message, then exit 1; no ready', async () => {
  const host = start({ fatal: 'Could not resolve "x"' })
  const fatal = await host.next(m => m.type === 'fatal')
  assert.equal(fatal.message, 'Could not resolve "x"')
  assert.ok(typeof fatal.code === 'string')
  assert.equal((await host.exited).code, 1)
  assert.equal(host.messages.some(m => m.type === 'ready'), false)
})

test('dispose answers and then the process ends', async () => {
  const host = start({})
  const ready = await host.next(m => m.type === 'ready')
  assert.deepEqual((await rpc(ready, 'dispose', {})).body.result, {})
  assert.equal((await host.exited).code, 0)
})

test('noise before ready: a non-JSON line is written (the mod must skip it)', async () => {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, FAKE_HOST_CONFIG: JSON.stringify({ noise: true }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', c => {
    out += c
  })
  await new Promise(resolve => setTimeout(resolve, 800))
  child.kill()
  assert.match(out, /^Debugger listening/m)
  assert.match(out, /"type":"surprise"/)
  assert.match(out, /"type":"ready"/)
})

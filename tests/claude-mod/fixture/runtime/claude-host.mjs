// Synthetic child host for the Claude Code mod (SPEC.md protocol), as a real Node process:
//   stdout JSON lines (ready / fatal / toolsChanged / promptChanged / request / log),
//   HTTP POST http://127.0.0.1:<random port>/rpc with a Bearer token.
// The protocol logic is fake-host-core.mjs. Configuration, first found wins:
//   env FAKE_HOST_CONFIG (a JSON text), then fake-host.config.json beside this file.
// It is copied into the fixture plugin as runtime/claude-host.mjs.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostCore } from './fake-host-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  if (process.env.FAKE_HOST_CONFIG) return JSON.parse(process.env.FAKE_HOST_CONFIG)
  try {
    return JSON.parse(readFileSync(join(here, 'fake-host.config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const config = loadConfig()
const token = randomBytes(32).toString('hex')
let port = 0

const emit = message => process.stdout.write(`${message.__raw !== undefined ? message.__raw : JSON.stringify(message)}\n`)
const core = createHostCore({
  config,
  token,
  emit,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  exit: code => setTimeout(() => process.exit(code), 20),
})

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  request.on('data', c => chunks.push(c))
  request.on('end', async () => {
    const { status, body } = await core.rpc(request.headers.authorization, Buffer.concat(chunks).toString('utf8'))
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
})

if (typeof config.fatal === 'string') {
  // fatal before listening: the same message the real host would give
  core.start()
} else {
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    core.setPort(port)
    core.start()
  })
}

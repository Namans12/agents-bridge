#!/usr/bin/env node
// Bridge between the codex plugin and `codex app-server`.
//
// Two roles in one file:
//   relay:  node bridge.mjs <codexPath> <sessionKey>
//           Started by the plugin with $.process.spawn. Finds (or starts) the
//           daemon for this Claude session and this build of the bridge (the
//           daemon's directory is <sessionKey>-<BUILD>, so a reload onto another
//           plugin version or path starts a new daemon instead of driving an old
//           one), then copies its event stream to stdout as NDJSON. First line:
//           {"type":"ready","socket",...}. It exits when its parent goes away,
//           stdout breaks or the daemon exits; the plugin killing it on reload is
//           expected and harmless.
//   launch: node bridge.mjs --launch <codexPath> <dir>
//           Started detached by the relay; starts the daemon detached, writes
//           its pid to <dir>/pid and exits at once. The daemon is thus never a
//           descendant of the relay: the engine kills the relay's whole tree
//           when the plugin reloads, and the daemon (with codex and its
//           running turns) must outlive that.
//   daemon: node bridge.mjs --daemon <codexPath> <dir>
//           Owns one `codex app-server --listen stdio://` and serves HTTP on
//           the Unix socket <dir>/s:
//             GET  /health
//             GET  /events           NDJSON stream (one subscriber, the relay)
//             POST /rpc   {method, params, timeoutMs?} -> {result} | {error}
//             POST /reply {id, result} | {id, error}   answers a server request
//             POST /wait  {threadId, msgKey?, timeoutMs} long-poll for turn end or a codex-msg message
//             POST /msg   {key, text}                  bin/codex-msg: a message from a Codex job
//           While no relay is attached it buffers events (so a plugin reload
//           loses nothing) and exits, killing codex, after GRACE_MS alone. With a
//           relay attached it exits after IDLE_MS with no turn running and no
//           request in flight; the plugin starts a new one when it next needs
//           Codex. Codex stops a thread's MCP servers (bin/codex-msg among them)
//           when it unloads the thread, and all of them when it exits. It also
//           stops daemons of bridge builds that predate this lifecycle (their
//           directory is the bare session key) once it has seen them run no
//           turn for LEGACY_IDLE_MS.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createDesktopSync } from './desktop-sync.mjs'
import { resolveCodex } from './resolve-codex.mjs'
import { authState, sameAuthState } from './auth-state.mjs'
import { createAntigravityBackend } from './antigravity.mjs'

const GRACE_MS = 20_000
const IDLE_MS = 10 * 60_000
const IDLE_CHECK_MS = 60_000
/** Half the idle window, so a daemon about to idle out itself still stops an idle legacy one. */
const LEGACY_IDLE_MS = IDLE_MS / 2
const BUFFER_CAP = 5_000
const MAILBOX_CAP = 50
const MESSAGE_CAP = 20_000
/** What a codex-msg delivery hands a waiting /wait. */
const MAIL = Symbol('mail')
const SELF = fileURLToPath(import.meta.url)
/** Names this bridge build: its path and its code. */
const BUILD = createHash('sha256').update(SELF).update(fs.readFileSync(SELF))
  .update(fs.readFileSync(new URL('./desktop-sync.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./resolve-codex.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./auth-state.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./antigravity.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./resolve-agy.mjs', import.meta.url)))
  .update(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')))
  .update(JSON.stringify([process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, process.env.CODEX_ACCESS_TOKEN]))
  .digest('hex').slice(0, 8)
const IS_WINDOWS = process.platform === 'win32'
/**
 * Where a daemon listens. POSIX: the Unix socket <dir>/s. Windows: Node has no Unix
 * sockets there, so a named pipe (an http `socketPath` too) named after the daemon's directory.
 */
const socketFor = dir =>
  IS_WINDOWS
    ? `\\\\.\\pipe\\cxb-${os.userInfo().username.replace(/[^A-Za-z0-9]/g, '')}-${path.basename(dir)}`
    : path.join(dir, 's')
/** The Unix socket Claude Code connects to. On Windows a forwarder (bin/unix-forward.ps1) serves it and relays to the pipe. */
const engineSocketFor = dir => path.join(dir, 's')
/** A daemon directory of a build before BUILD was part of it: the session key alone. */
const isLegacyDir = name => /^[A-Za-z0-9]+$/.test(name)

// Notifications the plugin never reads: streaming deltas and chatter.
const NOISE = new Set([
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'warning',
  'configWarning',
  'deprecationNotice',
  'guardianWarning',
  'skills/changed',
  'fs/changed',
  'turn/diff/updated',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/patchUpdated',
  'thread/settings/updated',
])
const isNoise = method =>
  NOISE.has(method) || /[dD]elta$/.test(method) || method.startsWith('rawResponse')

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

// ---------------------------------------------------------------- daemon

export async function daemon(codexPath, dir, { resolve = resolveCodex, acpClientFactory, spawnServer = file => spawn(file, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
}) } = {}) {
  const socketPath = socketFor(dir)
  const desktop = createDesktopSync({ log: line => process.stderr.write(`${line}\n`) })
  let credentials = authState()
  let generation = 0
  let codex
  const expectedExits = new WeakSet()
  const threadParams = new Map() // saved load settings, including full-access policy and messaging
  const loaded = new Set()
  const stderrTail = []

  let nextId = 1
  const pending = new Map() // our request id -> {resolve, timer}
  const outstanding = new Map() // server request id -> event
  const active = new Map() // threadId -> running turnId
  const lastTurn = new Map() // threadId -> last completed turn
  const waiters = new Map() // threadId -> Set<(value) => void>
  const mailboxes = new Map() // codex-msg key -> texts not yet read
  const mailWaiters = new Map() // codex-msg key -> Set<(value) => void>
  const drainMail = key => {
    const messages = mailboxes.get(key) ?? []
    mailboxes.delete(key)
    return messages
  }
  let buffer = []
  let subscriber = null
  let graceTimer = null
  let everSubscribed = false
  /** Requests other than /events being served, and when the daemon was last in use. */
  let inFlight = 0
  let lastUse = Date.now()

  const emit = event => {
    if (subscriber) subscriber.write(JSON.stringify(event) + '\n')
    else if (event.type !== 'request') {
      buffer.push(event)
      if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP)
    }
  }

  const writeCodex = message => codex.stdin.write(JSON.stringify(message) + '\n')

  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise(resolve => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: { code: -32000, message: `${method} timed out after ${timeoutMs} ms` } })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      writeCodex(params === undefined ? { id, method } : { id, method, params })
    })

  const settleWaiters = (threadId, value) => {
    const set = waiters.get(threadId)
    if (!set) return
    waiters.delete(threadId)
    for (const done of set) done(value)
  }

  const onCodexMessage = message => {
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message.error ? { error: message.error } : { result: message.result })
      return
    }
    if (message.id !== undefined) {
      const event = { type: 'request', id: message.id, method: message.method, params: message.params ?? {} }
      outstanding.set(message.id, event)
      emit(event)
      return
    }
    const { method, params = {} } = message
    if (method === 'turn/started' && params.turn?.id) active.set(params.threadId, params.turn.id)
    const completesCurrent = method === 'turn/completed' && params.turn
      && (!active.has(params.threadId) || active.get(params.threadId) === params.turn.id)
    if (completesCurrent) {
      active.delete(params.threadId)
      lastTurn.set(params.threadId, params.turn)
      lastUse = Date.now()
      // Read the saved title so a user's Desktop rename during the turn survives.
      if (desktop.enabled && !params.threadId?.startsWith('agy:')) void rpc('thread/read', { threadId: params.threadId, includeTurns: false }, 5000)
        .then(answer => desktop.announce(params.threadId, answer.result?.thread?.name))
    }
    if (method === 'serverRequest/resolved' && params.requestId !== undefined) outstanding.delete(params.requestId)
    if (!isNoise(method)) emit({ type: 'notification', method, params })
    if (completesCurrent) settleWaiters(params.threadId, { status: 'completed', turn: params.turn })
  }

  const antigravity = createAntigravityBackend({ emit: onCodexMessage, ...(acpClientFactory ? { clientFactory: acpClientFactory } : {}) })

  const connect = () => {
    codex = spawnServer(resolve(codexPath))
    const child = codex
    child.on('error', error => {
      process.stderr.write(`cannot start Codex: ${error.message}\n`)
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ error: { message: error.message } }) }
      pending.clear()
      if (codex === child) codex = null
    })
    readline.createInterface({ input: child.stderr }).on('line', line => {
      stderrTail.push(line)
      if (stderrTail.length > 40) stderrTail.shift()
    })
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (expectedExits.has(child) || line.trim() === '') return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      onCodexMessage(message)
    })
    child.on('exit', (code, signal) => {
      if (expectedExits.has(child)) return
      emit({ type: 'exit', code, signal, stderrTail })
      for (const { resolve, timer } of pending.values()) {
        clearTimeout(timer)
        resolve({ error: { code: -32001, message: 'codex app-server exited' } })
      }
      pending.clear()
      loaded.clear()
      for (const [threadId, turnId] of active) {
        if (threadId.startsWith('agy:')) continue
        onCodexMessage({ method: 'turn/completed', params: { threadId,
          turn: { id: turnId, status: 'failed', error: { message: 'codex app-server exited' }, items: [] } } })
      }
      codex = null
      // ACP jobs have their own children and are unaffected by a Codex server exit.
    })
  }

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  let forwarder = null
  let stopping = false
  const shutdown = code => {
    stopping = true
    antigravity.close()
    if (forwarder && forwarder.exitCode === null) forwarder.kill()
    if (codex && codex.exitCode === null && codex.signalCode === null) codex.kill('SIGTERM')
    cleanup()
    // End the relay's stream before exiting, so the relay reads an ordinary end, not a reset.
    if (subscriber) subscriber.end()
    subscriber = null
    setTimeout(() => process.exit(code), 100)
  }

  const armGrace = () => {
    clearTimeout(graceTimer)
    graceTimer = setTimeout(() => shutdown(0), GRACE_MS)
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))

  const initialize = async (timeoutMs = 15_000) => {
    const init = await rpc('initialize', { clientInfo: { name: 'claude-code-codex-plugin', version: '0.1.0' } }, timeoutMs)
    if (init.error) throw new Error(`Codex initialize failed: ${init.error.message}`)
    writeCodex({ method: 'initialized' })
  }
  // Preserve eager Codex startup when installed, but an Antigravity-only setup needs no Codex binary.
  try { connect(); await initialize() } catch (error) {
    if (codex) { expectedExits.add(codex); codex.kill(); codex = null }
    process.stderr.write(`Codex unavailable (Antigravity remains available): ${error.message}\n`)
  }

  // Serialize RPC admission with restart: parallel job starts cannot kill each other's requests.
  let admission = Promise.resolve()
  const dispatch = async body => {
    const { method, params } = body
    if (method.startsWith('antigravity/')) return antigravity.dispatch(method, params ?? {})
    if (!codex) { connect(); await initialize() }
    const deadline = Date.now() + (body.timeoutMs ?? 25_000)
    const remaining = () => Math.max(1, deadline - Date.now())
    const boundary = ['bridge/prepare', 'thread/start', 'thread/resume', 'turn/start'].includes(method)
      && !active.has(params?.threadId)
    if (boundary) {
      const current = authState()
      const changed = !sameAuthState(credentials, current)
      // No observable file for keyring/ephemeral auth: re-open the store at idle job boundaries.
      if (changed || current.externalStore) {
        if ([...active.keys()].some(id => !id.startsWith('agy:')) || outstanding.size || pending.size) {
          return { error: { code: -32002, message: changed
            ? 'Codex credentials changed while a turn is running. Existing turns continue with their current account. Wait for them to finish, then retry this job to use the new account.'
            : 'Codex uses credentials without an observable auth file (for example, keyring). Wait for existing turns to finish, then retry so this job can load the current account safely.' } }
        } else {
          const previous = codex
          expectedExits.add(previous)
          const exited = new Promise(resolve => previous.once('exit', resolve))
          previous.kill('SIGTERM')
          const force = setTimeout(() => previous.kill('SIGKILL'), 3000)
          await exited
          clearTimeout(force)
          loaded.clear()
          stderrTail.length = 0
          credentials = current
          try {
            connect()
            await initialize(Math.min(15_000, remaining()))
          } catch (error) {
            // A dead replacement must never remain advertised as a healthy daemon.
            emit({ type: 'fatal', message: error.message, logTail: '' })
            setTimeout(() => shutdown(1), 100)
            throw error
          }
          generation += 1
          emit({ type: 'notification', method: 'bridge/authChanged', params: {} })
        }
      }
    }
    if (method === 'bridge/prepare') return { result: { generation } }
    // The plugin may still have a loaded-thread cache from before the restart.
    if (method === 'turn/start' && !loaded.has(params?.threadId) && threadParams.has(params?.threadId)) {
      const resumed = await rpc('thread/resume', { ...threadParams.get(params.threadId), threadId: params.threadId }, remaining())
      if (resumed.error) return resumed
      loaded.add(params.threadId)
    }
    if (Date.now() >= deadline) return { error: { code: -32000, message: 'Codex account preparation timed out before the job could start; retry the job.' } }
    const answer = await rpc(method, params, remaining())
    if (!answer.error && ['thread/start', 'thread/resume'].includes(method)) {
      const id = answer.result?.thread?.id ?? params?.threadId
      if (id) { threadParams.set(id, { ...params }); loaded.add(id) }
    }
    if (!answer.error && method === 'thread/unsubscribe') loaded.delete(params?.threadId)
    if (method === 'turn/start' && answer.result?.turn?.id && params?.threadId
      && lastTurn.get(params.threadId)?.id !== answer.result.turn.id) active.set(params.threadId, answer.result.turn.id)
    return answer
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge')
      if (url.pathname !== '/events') {
        inFlight += 1
        lastUse = Date.now()
        res.on('close', () => {
          inFlight -= 1
          lastUse = Date.now()
        })
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, pid: process.pid, codexPid: codex?.pid, build: BUILD, active: Object.fromEntries(active) })
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        if (subscriber) subscriber.end()
        clearTimeout(graceTimer)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ type: 'hello', reattached: everSubscribed, active: Object.fromEntries(active) }) + '\n')
        for (const event of outstanding.values()) res.write(JSON.stringify(event) + '\n')
        for (const event of buffer) res.write(JSON.stringify(event) + '\n')
        buffer = []
        subscriber = res
        everSubscribed = true
        res.on('close', () => {
          if (subscriber === res) {
            subscriber = null
            armGrace()
          }
        })
        return
      }
      if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'not found' } })
      const body = await readBody(req)
      if (url.pathname === '/shutdown') {
        res.once('finish', () => shutdown(0))
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/rpc' || url.pathname === '/prepare') {
        if (url.pathname === '/prepare') body.method = 'bridge/prepare'
        if (typeof body.method !== 'string') return sendJson(res, 400, { error: { message: 'method required' } })
        const deadline = Date.now() + (body.timeoutMs ?? 25_000)
        // ACP startup is independent per job; cancellation/steering must not queue behind another startup.
        if (body.method.startsWith('antigravity/')) {
          const answer = await dispatch(body)
          if (res.destroyed && body.method === 'antigravity/start' && answer.result?.thread?.id) {
            await antigravity.dispatch('antigravity/release', { threadId: answer.result.thread.id })
          }
          return sendJson(res, 200, answer)
        }
        const work = admission.then(() => Date.now() >= deadline || res.destroyed
          ? { error: { code: -32000, message: 'Codex request expired while waiting for another request; retry the job.' } }
          : dispatch({ ...body, timeoutMs: deadline - Date.now() }))
        admission = work.catch(() => undefined)
        const answer = await work
        if (answer.result && body.method === 'thread/name/set' && typeof body.params?.name === 'string') {
          void desktop.announce(body.params.threadId, body.params.name)
        }
        return sendJson(res, 200, url.pathname === '/prepare' && !answer.error ? answer.result : answer)
      }
      if (url.pathname === '/reply') {
        if (!outstanding.has(body.id)) return sendJson(res, 404, { error: { message: `no open server request ${body.id}` } })
        outstanding.delete(body.id)
        writeCodex(body.error !== undefined ? { id: body.id, error: body.error } : { id: body.id, result: body.result })
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/wait') {
        const { threadId, msgKey, timeoutMs = 600_000 } = body
        // Messages first: a job may send one and end its turn before the next poll.
        if (msgKey && mailboxes.get(msgKey)?.length) return sendJson(res, 200, { status: 'message', messages: drainMail(msgKey) })
        if (!active.has(threadId)) return sendJson(res, 200, { status: 'idle', turn: lastTurn.get(threadId) ?? null })
        const answer = await new Promise(resolve => {
          const set = waiters.get(threadId) ?? new Set()
          waiters.set(threadId, set)
          const mail = msgKey ? (mailWaiters.get(msgKey) ?? new Set()) : null
          if (mail) mailWaiters.set(msgKey, mail)
          const done = value => {
            clearTimeout(timer)
            set.delete(done)
            mail?.delete(done)
            resolve(value === MAIL ? { status: 'message', messages: drainMail(msgKey) } : value)
          }
          const timer = setTimeout(() => done({ status: 'timeout', turnId: active.get(threadId) ?? null }), timeoutMs)
          set.add(done)
          mail?.add(done)
        })
        return sendJson(res, 200, answer)
      }
      if (url.pathname === '/msg') {
        const { key, text } = body
        if (typeof key !== 'string' || key === '' || typeof text !== 'string' || text.trim() === '') {
          return sendJson(res, 400, { error: { message: 'key and text are required' } })
        }
        const box = mailboxes.get(key) ?? []
        if (box.length >= MAILBOX_CAP) return sendJson(res, 429, { error: { message: `${MAILBOX_CAP} messages are already waiting to be read` } })
        box.push(text.slice(0, MESSAGE_CAP))
        mailboxes.set(key, box)
        const set = mailWaiters.get(key)
        if (set) {
          mailWaiters.delete(key)
          for (const done of set) done(MAIL)
        }
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? error) } })
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  if (!IS_WINDOWS) {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
  }
  server.listen(socketPath, () => {
    if (!IS_WINDOWS) fs.chmodSync(socketPath, 0o600)
    else {
      // Windows: serve the real Unix socket Claude Code needs, relaying to the pipe above.
      const script = path.join(path.dirname(SELF), 'unix-forward.ps1')
      const pwsh = [process.env.CODEX_BRIDGE_PWSH, 'pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']
        .filter(Boolean)
        .find(candidate => candidate === 'pwsh' || fs.existsSync(candidate))
      forwarder = spawn(
        pwsh,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, engineSocketFor(dir), path.basename(socketPath)],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
      )
      forwarder.on('error', error => {
        process.stderr.write(`cannot start PowerShell 7 (pwsh) for the Unix socket forwarder: ${error.message}\n`)
        shutdown(1)
      })
      forwarder.on('exit', code => {
        if (stopping) return
        process.stderr.write(`unix socket forwarder exited (${code})\n`)
        shutdown(1)
      })
      readline.createInterface({ input: forwarder.stderr }).on('line', line => process.stderr.write(`forwarder: ${line}\n`))
    }
    armGrace()
  })

  // Legacy daemon directory -> since when its daemon has been seen running no turn.
  const legacyIdleSince = new Map()
  const stopIdleLegacy = async () => {
    const base = path.dirname(dir)
    const now = Date.now()
    for (const name of fs.readdirSync(base).filter(isLegacyDir)) {
      const health = await readHealth(socketFor(path.join(base, name)))
      if (!health || Object.keys(health.active ?? {}).length > 0) {
        legacyIdleSince.delete(name)
        continue
      }
      const since = legacyIdleSince.get(name) ?? now
      legacyIdleSince.set(name, since)
      if (now - since < LEGACY_IDLE_MS) continue
      legacyIdleSince.delete(name)
      // The pid the daemon reports must be the one its launcher recorded.
      let recorded = null
      try {
        recorded = fs.readFileSync(path.join(base, name, 'pid'), 'utf8').trim()
      } catch {}
      if (recorded !== String(health.pid)) continue
      process.stderr.write(`stopping idle daemon ${name} (pid ${health.pid}) of an older bridge build\n`)
      process.kill(health.pid, 'SIGTERM')
    }
  }
  setInterval(() => {
    if (active.size > 0 || inFlight > 0) lastUse = Date.now()
    else if (subscriber && Date.now() - lastUse >= IDLE_MS) shutdown(0)
    stopIdleLegacy().catch(error => process.stderr.write(`legacy daemon sweep failed: ${error.message}\n`))
  }, IDLE_CHECK_MS)
}

// ---------------------------------------------------------------- relay

const request = (socketPath, method, urlPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** A daemon's /health answer, or null when none answers on the socket. */
const readHealth = async socketPath => {
  try {
    const res = await request(socketPath, 'GET', '/health', 1000)
    res.setEncoding('utf8')
    let text = ''
    for await (const chunk of res) text += chunk
    return res.statusCode === 200 ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const isHealthy = async socketPath => (await readHealth(socketPath)) !== null

const privateBase = () => {
  if (IS_WINDOWS) {
    // No uid or POSIX modes on Windows: a per-user directory under the user's own temp dir (already ACL-private).
    const base = path.join(os.tmpdir(), `cxb-${os.userInfo().username.replace(/[^A-Za-z0-9]/g, '')}`)
    fs.mkdirSync(base, { recursive: true })
    return base
  }
  const base = `/tmp/cxb-${process.getuid()}`
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(base)
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`${base} is not a directory this user owns`)
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(base, 0o700)
  return base
}

async function relay(codexPath, sessionKey) {
  const out = line => process.stdout.write(JSON.stringify(line) + '\n')
  process.stdout.on('error', () => process.exit(0))
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 1000).unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))

  const key = sessionKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'default'
  const dir = path.join(privateBase(), `${key}-${BUILD}`)
  const socketPath = socketFor(dir)
  // What the plugin connects to; on Windows it is served once the forwarder says it listens
  // (Node cannot stat the socket file there, so the forwarder writes forward.ready).
  const engineSocket = engineSocketFor(dir)
  const isServing = async () => (await isHealthy(socketPath)) && (!IS_WINDOWS || fs.existsSync(path.join(dir, 'forward.ready')))

  if (!(await isHealthy(socketPath))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { mode: 0o700 })
    const launcher = spawn(process.execPath, [SELF, '--launch', codexPath, dir], { detached: true, stdio: 'ignore', windowsHide: true })
    await new Promise(resolve => launcher.on('exit', resolve))
    const daemonPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
    const deadline = Date.now() + 30_000
    while (!(await isServing())) {
      const isAlive = (() => {
        try {
          process.kill(daemonPid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (!isAlive || Date.now() > deadline) {
        let logTail = ''
        try {
          logTail = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8').slice(-16_000)
        } catch {}
        out({ type: 'fatal', message: !isAlive ? 'the daemon exited' : 'daemon did not start in 30 s', logTail })
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const res = await request(socketPath, 'GET', '/events', 0)
  res.setEncoding('utf8')
  const lines = readline.createInterface({ input: res })
  let first = true
  for await (const line of lines) {
    if (first) {
      first = false
      const hello = JSON.parse(line)
      out({ type: 'ready', socket: engineSocket, reattached: hello.reattached, active: hello.active })
      continue
    }
    process.stdout.write(line + '\n')
  }
  process.exit(0)
}

function launch(codexPath, dir) {
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a', 0o600)
  const daemonChild = spawn(process.execPath, [SELF, '--daemon', codexPath, dir], { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  fs.writeFileSync(path.join(dir, 'pid'), String(daemonChild.pid), { mode: 0o600 })
  daemonChild.unref()
  process.exit(0)
}

const [, , first, ...rest] = process.argv
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (first === '--launch') {
    const [codexPath, dir] = rest
    launch(codexPath, dir)
  } else if (first === '--daemon') {
    const [codexPath, dir] = rest
    daemon(codexPath, dir).catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
  } else if (first && rest[0]) {
    relay(first, rest[0]).catch(error => {
      process.stdout.write(JSON.stringify({ type: 'fatal', message: error.message, logTail: '' }) + '\n')
      process.exit(1)
    })
  } else {
    process.stderr.write('usage: bridge.mjs <codexPath> <sessionKey>\n')
    process.exit(2)
  }
}

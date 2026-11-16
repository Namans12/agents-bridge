import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const bridge = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))

function request(socketPath, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ socketPath, path: route, method: data === undefined ? 'GET' : 'POST', timeout: 2_000 }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }) } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')))
    req.on('error', reject)
    req.end(data)
  })
}

const alive = pid => {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function boot(t, { keyring = false } = {}) {
  // A short path also works within macOS's Unix socket path length limit.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxb-test-'))
  const fake = path.join(dir, 'fake-codex.cjs')
  const auth = path.join(dir, 'auth.json')
  if (!keyring) await fs.writeFile(auth, 'synthetic-account-one')
  await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const account = fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json')) ? fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8') : 'keyring';
const loaded = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'turn/start') {
    if (!loaded.has(msg.params.threadId)) { send({ id: msg.id, error: { message: 'thread is not loaded' } }); return; }
    send({ id: msg.id, result: { turn: { id: 'turn-test' }, account, pid: process.pid, loadParams: loaded.get(msg.params.threadId) } });
    send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: 'turn-test' } } });
  } else if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-test', status: 'interrupted', items: [] } } });
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const threadId = msg.params.threadId || 'thread-test';
    loaded.set(threadId, msg.params);
    send({ id: msg.id, result: { thread: { id: threadId }, account, pid: process.pid } });
  } else if (msg.method === 'account/read') send({ id: msg.id, result: { account, pid: process.pid } });
  else if (msg.method === 'test/lateCompletion') {
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'older-turn', status: 'completed', items: [] } } });
  }
  else send({ id: msg.id, result: {} });
});
`, { mode: 0o700 })
  // Node explicitly runs the fixture on all platforms; production still spawns only native Codex.
  const driver = path.join(dir, 'driver.mjs')
  await fs.writeFile(driver, `import { daemon } from ${JSON.stringify(new URL('../bin/bridge.mjs', import.meta.url).href)};
import { spawn } from 'node:child_process';
import { AcpClient } from ${JSON.stringify(new URL('../bin/antigravity.mjs', import.meta.url).href)};
daemon('', ${JSON.stringify(dir)}, { resolve: () => process.execPath,
  acpClientFactory: options => new AcpClient({ ...options, command: { file: process.execPath, args: [${JSON.stringify(fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url)))}] } }),
  spawnServer: () => spawn(process.execPath, [${JSON.stringify(fake)}], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}).catch(error => { console.error(error.message); process.exit(1) });`)
  const child = spawn(process.execPath, [driver], { env: { ...process.env, CODEX_HOME: dir, CODEX_BRIDGE_DESKTOP_SYNC: '0' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  let codexPid
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    if (codexPid && alive(codexPid)) process.kill(codexPid, 'SIGTERM')
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\cxb-${os.userInfo().username.replace(/[^A-Za-z0-9]/g, '')}-${path.basename(dir)}` : path.join(dir, 's')
  let health
  for (let i = 0; i < 100; i++) {
    try { health = await request(socket, '/health'); break } catch { await delay(20) }
  }
  assert.equal(health?.body.ok, true, stderr)
  codexPid = health.body.codexPid
  assert.equal(alive(codexPid), true)
  return { dir, auth, socket, exited, child, codexPid }
}

test('bridge routes messages, tracks turns, and shuts down its Codex child', { timeout: 20_000 }, async t => {
  const { socket, exited, codexPid, dir } = await boot(t)
  await request(socket, '/rpc', { method: 'thread/start', params: { sandbox: 'danger-full-access', approvalPolicy: 'never' } })

  await request(socket, '/rpc', { method: 'turn/start', params: { threadId: 'thread-test' } })
  const running = await request(socket, '/health')
  assert.equal(running.body.active['thread-test'], 'turn-test')
  const waiting = request(socket, '/wait', { threadId: 'thread-test', msgKey: 'mail-test', timeoutMs: 1_000 })
  await request(socket, '/msg', { key: 'mail-test', text: 'question for Claude' })
  assert.deepEqual((await waiting).body, { status: 'message', messages: ['question for Claude'] })

  await request(socket, '/rpc', { method: 'turn/interrupt', params: { threadId: 'thread-test', turnId: 'turn-test' } })
  assert.equal((await request(socket, '/wait', { threadId: 'thread-test', timeoutMs: 1 })).body.turn.status, 'interrupted')
  assert.deepEqual((await request(socket, '/shutdown', {})).body, { ok: true })
  assert.equal((await exited)[0], 0)
  for (let i = 0; i < 100 && alive(codexPid); i++) await delay(10)
  assert.equal(alive(codexPid), false)
  await assert.rejects(fs.stat(path.join(dir, 's')), { code: 'ENOENT' })
})

test('shared Windows bridge routes independent ACP jobs, cancel/wait/resume and shutdown', { timeout: 20_000 }, async t => {
  const { socket, dir, exited } = await boot(t)
  const start = () => request(socket, '/rpc', { method: 'antigravity/start', params: { cwd: dir, family: 'gemini' } })
  const [first, second] = await Promise.all([start(), start()])
  const one = first.body.result.thread.id
  const two = second.body.result.thread.id
  assert.notEqual(one, two)
  const rpc = (method, threadId, text) => request(socket, '/rpc', { method: `antigravity/${method}`, params: { threadId, cwd: dir, family: 'gemini', text } })
  await rpc('prompt', one, 'hang')
  await rpc('prompt', two, 'hello')
  assert.equal((await request(socket, '/wait', { threadId: two, timeoutMs: 1000 })).body.turn.items[0].text, 'FAKE_AGY_OK')
  assert.ok((await request(socket, '/health')).body.active[one])
  await rpc('cancel', one)
  assert.equal((await request(socket, '/wait', { threadId: one, timeoutMs: 1000 })).body.turn.status, 'interrupted')
  await rpc('release', two)
  await rpc('resume', two)
  await rpc('prompt', two, 'permission-outside')
  const denied = (await request(socket, '/wait', { threadId: two, timeoutMs: 1000 })).body.turn.items[0].text
  assert.match(denied, /PERMISSION:deny-id/)
  assert.match(denied, /outside cwd/)
  await request(socket, '/shutdown', {})
  assert.equal((await exited)[0], 0)
})

test('auth change restarts only the idle app-server, resumes loaded threads and preserves daemon IPC', { timeout: 20_000 }, async t => {
  const { socket, auth, codexPid } = await boot(t)
  const params = { sandbox: 'danger-full-access', approvalPolicy: 'never', config: { test: true } }
  const started = await request(socket, '/rpc', { method: 'thread/start', params })
  assert.equal(started.body.result.account, 'synthetic-account-one')
  await fs.writeFile(auth, 'synthetic-account-two')
  assert.equal((await request(socket, '/prepare', {})).body.generation, 1)
  const result = await request(socket, '/rpc', { method: 'turn/start', params: { threadId: 'thread-test' } })
  assert.equal(result.body.result.account, 'synthetic-account-two')
  assert.deepEqual(result.body.result.loadParams, { ...params, threadId: 'thread-test' })
  assert.notEqual(result.body.result.pid, codexPid)
  assert.equal(alive(codexPid), false)
  assert.equal((await request(socket, '/health')).body.active['thread-test'], 'turn-test')
})

test('auth switch never kills active turns; next accepted job uses the new account', { timeout: 20_000 }, async t => {
  const { socket, auth, codexPid } = await boot(t)
  await request(socket, '/rpc', { method: 'thread/start', params: {} })
  await request(socket, '/rpc', { method: 'turn/start', params: { threadId: 'thread-test' } })
  await fs.writeFile(auth, 'synthetic-account-two')
  await request(socket, '/rpc', { method: 'test/lateCompletion', params: { threadId: 'thread-test' } })
  assert.equal((await request(socket, '/health')).body.active['thread-test'], 'turn-test')
  const denied = await request(socket, '/rpc', { method: 'thread/start', params: {} })
  assert.match(denied.body.error.message, /Wait for them to finish/)
  assert.equal((await request(socket, '/health')).body.codexPid, codexPid)
  // Steering and interruption remain available to the old turn.
  await request(socket, '/rpc', { method: 'turn/steer', params: { threadId: 'thread-test' } })
  await request(socket, '/rpc', { method: 'turn/interrupt', params: { threadId: 'thread-test' } })
  const next = await request(socket, '/rpc', { method: 'thread/start', params: {} })
  assert.equal(next.body.result.account, 'synthetic-account-two')
  assert.notEqual(next.body.result.pid, codexPid)
})

test('concurrent starts are serialized across account reload', { timeout: 20_000 }, async t => {
  const { socket, auth } = await boot(t)
  await fs.writeFile(auth, 'synthetic-account-two')
  const results = await Promise.all([1, 2].map(() => request(socket, '/rpc', { method: 'thread/start', params: {} })))
  assert.ok(results.every(result => result.body.result?.account === 'synthetic-account-two'))
  assert.equal(results[0].body.result.pid, results[1].body.result.pid)
})

test('unobservable keyring credentials reload at idle boundaries and refuse new jobs while busy', { timeout: 20_000 }, async t => {
  const { socket, codexPid } = await boot(t, { keyring: true })
  const first = await request(socket, '/rpc', { method: 'thread/start', params: {} })
  assert.notEqual(first.body.result.pid, codexPid)
  const turn = await request(socket, '/rpc', { method: 'turn/start', params: { threadId: 'thread-test' } })
  assert.ok(turn.body.result)
  const next = await request(socket, '/rpc', { method: 'thread/start', params: {} })
  assert.match(next.body.error.message, /keyring/)
  assert.equal((await request(socket, '/health')).body.codexPid, turn.body.result.pid)
})

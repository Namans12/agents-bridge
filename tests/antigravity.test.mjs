import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { AcpClient, cleanAgyEnv, permissionDecision, createAntigravityBackend } from '../bin/antigravity.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
const command = { file: process.execPath, args: [fixture] }
async function client(t, options = {}, sessionId) {
  const updates = []
  const value = new AcpClient({ command, cwd: os.tmpdir(), onUpdate: update => updates.push(update), ...options })
  const exit = once(value.child, 'exit')
  t.after(async () => { value.close(); await exit })
  await value.open(sessionId)
  return { value, updates }
}

test('ACP initialize/new/configure/stream/prompt completion uses advertised opaque IDs; strips billing env', async t => {
  const { value, updates } = await client(t, { env: { ...process.env, GEMINI_API_KEY: 'synthetic', GOOGLE_API_KEY: 'synthetic', GOOGLE_GENAI_USE_VERTEXAI: '1' } })
  assert.equal(value.configOptions.find(one => one.id === 'useG1Credits').currentValue, false)
  const settings = await value.configure({ family: 'gemini', effort: 'Low', mode: 'plan' })
  assert.deepEqual(settings, { model: 'fixture-gemini', effort: 'low-id' })
  assert.equal((await value.prompt('hello')).stopReason, 'end_turn')
  assert.equal(updates.filter(one => one.sessionUpdate === 'agent_message_chunk').map(one => one.content.text).join(''), 'FAKE_AGY_OK')
  updates.length = 0
  await value.prompt('env')
  assert.equal(updates.filter(one => one.content).map(one => one.content.text).join(''), 'KEYS:')
})

test('permissions approve inside/no-path and deny outside through real stdio callback', async t => {
  const { value, updates } = await client(t)
  for (const [prompt, expected] of [['permission-inside', 'allow-id'], ['permission-no-path', 'allow-id'], ['permission-outside', 'deny-id'], ['permission-prior-outside', 'deny-id']]) {
    updates.length = 0
    await value.prompt(prompt)
    assert.equal(updates.filter(one => one.content).map(one => one.content.text).join(''), `PERMISSION:${expected}`)
  }
  assert.match(updates.find(one => one.sessionUpdate === 'permission_decision').text, /outside cwd/)
})

test('permission policy handles traversal, boundary siblings, raw commands, URI paths, symlink escapes, and opt-out', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-permission-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'd', kind: 'reject_once' }]
  const verdict = (toolCall, extra) => permissionDecision({ toolCall, options }, root, extra).outcome.optionId
  assert.equal(verdict({ locations: [{ path: path.join(root, 'ok') }] }), 'a')
  assert.equal(verdict({ rawInput: { paths: ['../outside'] } }), 'd')
  assert.equal(verdict({ rawInput: { command: 'cd ..' } }), 'd')
  assert.equal(verdict({ content: [{ type: 'diff', path: pathToFileURL(path.resolve(root, '..', 'outside')).href }] }), 'd')
  assert.equal(verdict({ rawInput: { command: `cat "${path.resolve(root, '..', 'outside')}"` } }), 'd')
  assert.equal(verdict({ rawInput: { file_path: `${root}-sibling/file` } }), 'd')
  assert.equal(verdict({}, { denyAll: true }), 'd')
  const link = path.join(root, 'escape')
  fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(verdict({ locations: [{ path: path.join(link, 'new-file') }] }), 'd')
  const windows = { paths: path.win32, canonical: value => value }
  assert.equal(permissionDecision({ toolCall: { locations: [{ path: 'C:\\work2\\file' }] }, options }, 'C:\\work', windows).outcome.optionId, 'd')
})

test('ACP cancel is a notification; original prompt finishes cancelled', async t => {
  const { value } = await client(t)
  const prompt = value.prompt('hang')
  await delay(50); value.cancel()
  assert.equal((await prompt).stopReason, 'cancelled')
})

test('uncooperative cancel and inactivity stop only the owned child', async t => {
  const { value } = await client(t, { cancelMs: 50 })
  const prompt = value.prompt('ignore-cancel')
  const rejection = assert.rejects(prompt, /Cancellation timed out/)
  await delay(40); value.cancel(); await rejection
  assert.equal(value.closed, true)
  const second = await client(t, { inactivityMs: 50 })
  await assert.rejects(second.value.prompt('hang'), /inactivity/)
})

test('resume after child restart preserves session ID; load fallback ignores replay', async t => {
  const first = await client(t)
  const id = first.value.sessionId
  await first.value.prompt('hello'); first.value.close()
  const resumed = await client(t, {}, id)
  assert.equal(resumed.value.sessionId, id)
  await resumed.value.prompt('hello')
  const loaded = await client(t, { env: { ...process.env, FAKE_AGY_LOAD_ONLY: '1' } }, id)
  assert.equal(loaded.updates.some(one => one.content?.text === 'REPLAY_MUST_NOT_APPEAR'), false)
  await loaded.value.prompt('hello')
})

test('missing resume capability and authentication are actionable failures; unknown config rejected', async t => {
  const bad = new AcpClient({ command, cwd: os.tmpdir(), env: { ...process.env, FAKE_AGY_NO_RESUME: '1' } })
  const exit = once(bad.child, 'exit'); t.after(async () => { bad.close(); await exit })
  await assert.rejects(bad.open('saved'), /cannot resume/)
  const auth = new AcpClient({ command, cwd: os.tmpdir(), env: { ...process.env, FAKE_AGY_AUTH_ERROR: '1' } })
  const authExit = once(auth.child, 'exit'); t.after(async () => { auth.close(); await authExit })
  await assert.rejects(auth.open(), /Authentication required/)
  const { value } = await client(t)
  await assert.rejects(value.configure({ model: 'invented' }), /Available model IDs/)
  await assert.rejects(value.configure({ effort: 'ultra' }), /Advertised choices/)
})

test('quota errors complete failed with no retry; steering correlates prompt responses; adapter resumes', async t => {
  const events = []
  const backend = createAntigravityBackend({ emit: event => events.push(event), clientFactory: options => new AcpClient({ ...options, command }) })
  t.after(() => backend.close())
  const start = await backend.dispatch('antigravity/start', { cwd: os.tmpdir(), family: 'gemini' })
  const threadId = start.result.thread.id
  await backend.dispatch('antigravity/prompt', { threadId, text: 'quota' })
  for (let i = 0; i < 100 && !events.some(one => one.method === 'turn/completed'); i++) await delay(10)
  let completed = events.filter(one => one.method === 'turn/completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].params.turn.status, 'failed')
  assert.match(completed[0].params.turn.error.message, /quota.*No retry/)
  events.length = 0
  await backend.dispatch('antigravity/prompt', { threadId, text: 'hang' })
  await backend.dispatch('antigravity/prompt', { threadId, text: 'steer' })
  for (let i = 0; i < 100 && !events.some(one => one.method === 'turn/completed'); i++) await delay(10)
  completed = events.filter(one => one.method === 'turn/completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].params.turn.items[0].text, 'FAKE_AGY_OK')
  events.length = 0
  await backend.dispatch('antigravity/prompt', { threadId, text: 'hang' })
  await backend.dispatch('antigravity/prompt', { threadId, text: 'quota' })
  for (let i = 0; i < 100 && !events.some(one => one.method === 'turn/completed'); i++) await delay(10)
  assert.equal(events.find(one => one.method === 'turn/completed')?.params.turn.status, 'failed')
  await backend.dispatch('antigravity/release', { threadId })
  const resumed = await backend.dispatch('antigravity/resume', { threadId, cwd: os.tmpdir(), family: 'gemini' })
  assert.equal(resumed.result.thread.id, threadId)
})

test('bridge shutdown also closes ACP children still negotiating setup', async () => {
  let owned
  const backend = createAntigravityBackend({ emit: () => {}, clientFactory: options => {
    owned = new AcpClient({ ...options, command }); return owned
  } })
  const setup = backend.dispatch('antigravity/start', { cwd: os.tmpdir(), family: 'gemini' })
  const exited = once(owned.child, 'exit')
  backend.close()
  assert.match((await setup).error.message, /closed|shutting down/)
  await exited
  assert.equal(owned.closed, true)
})

test('credit option absent warns without inventing flags; child crash/malformed stdout fails promptly', async t => {
  const { value, updates } = await client(t, { env: { ...process.env, FAKE_AGY_NO_CREDITS: '1' } })
  assert.match(updates[0].text, /Use AI Credits OFF/)
  await assert.rejects(value.prompt('crash'), /exited.*fixture crash/s)
  const malformed = await client(t)
  await assert.rejects(malformed.value.prompt('malformed'), /Invalid ACP message/)
  assert.equal(cleanAgyEnv({ Path: 'ok', google_api_key: 'x', GOOGLE_GENAI_USE_VERTEXAI: 'true' }).Path, 'ok')
  assert.deepEqual(cleanAgyEnv({ AGY_ADC_AUTH: '1', GEMINI_API_KEY_FILE: 'synthetic', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: 'synthetic', PATH: 'ok' }), { PATH: 'ok' })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopSync } from '../bin/desktop-sync.mjs'

const enabled = { platform: 'win32', env: { CODEX_BRIDGE_DESKTOP_SYNC: '1' } }
const receipt = (threadId, title) => ({ ok: true, operation: 'set_thread_title', result: { threadId, title } })

test('desktop sync is opt-in and leaves macOS/Linux inactive', async () => {
  for (const options of [{ platform: 'win32', env: {} }, { platform: 'win32', env: { CODEX_BRIDGE_DESKTOP_SYNC: '0' } }, ...['darwin', 'linux'].map(platform => ({ ...enabled, platform }))]) {
    const sync = createDesktopSync({ ...options, load: () => { throw new Error('must not load') }, log: () => assert.fail('must not log') })
    await sync.announce('thread', 'title')
  }
})

test('announces only the exact existing title and reuses the loaded client', async () => {
  const calls = []
  let loads = 0
  const sync = createDesktopSync({ ...enabled, load: async () => {
    loads++
    return { announce: async (id, title) => { calls.push([id, title]); return receipt(id, title) } }
  } })
  await sync.announce('thread', 'A title with $() and quotes "')
  await sync.announce('thread', 'A title with $() and quotes "')
  assert.equal(loads, 1)
  assert.deepEqual(calls, [['thread', 'A title with $() and quotes "'], ['thread', 'A title with $() and quotes "']])
})

test('missing thread identity or title does no IO', async () => {
  const sync = createDesktopSync({ ...enabled, load: () => assert.fail('must not load') })
  for (const args of [[undefined, 'name'], ['', 'name'], ['thread', undefined], ['thread', ' ']]) await sync.announce(...args)
})

test('relay failure is nonfatal and a later announcement retries', async () => {
  let loads = 0
  const logs = []
  const sync = createDesktopSync({ ...enabled, log: line => logs.push(line), load: async () => {
    if (++loads === 1) throw new Error('Desktop unavailable')
    return { announce: async (id, title) => receipt(id, title) }
  } })
  await sync.announce('thread', 'title')
  await sync.announce('thread', 'title')
  assert.equal(loads, 2)
  assert.match(logs[0], /Desktop unavailable/)
  assert.equal(logs[1], 'desktop sync: announced thread')
})

test('rejects a receipt for another thread or title without failing the job', async () => {
  for (const answer of [receipt('other', 'title'), receipt('thread', 'other'), { ok: false }, { ...receipt('thread', 'title'), operation: 'create_thread' }]) {
    const logs = []
    const sync = createDesktopSync({ ...enabled, log: line => logs.push(line), load: async () => ({ announce: async () => answer }) })
    await sync.announce('thread', 'title')
    assert.match(logs[0], /did not confirm/)
  }
})

test('same-thread announcements are ordered while another thread proceeds', async () => {
  const started = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const sync = createDesktopSync({ ...enabled, load: async () => ({ announce: async (id, title) => {
    started.push([id, title])
    if (title === 'first') await blocked
    return receipt(id, title)
  } }) })
  const first = sync.announce('one', 'first')
  const second = sync.announce('one', 'second')
  await sync.announce('two', 'independent')
  assert.deepEqual(started, [['one', 'first'], ['two', 'independent']])
  release()
  await Promise.all([first, second])
  assert.deepEqual(started.at(-1), ['one', 'second'])
})

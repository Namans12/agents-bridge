// Optional Windows catalog notification through an installed codex-mcp-bridge.
// Desktop's native set_thread_title tool emits its own thread/name/updated,
// which schedules catalog discovery. Execution stays on our private app-server.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadRelay(env) {
  const root = env.CODEX_BRIDGE_DESKTOP_RELAY_ROOT || path.join(
    env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'npm', 'node_modules', '@minhspark', 'codex-mcp-bridge',
  )
  if (!path.isAbsolute(root)) throw new Error('CODEX_BRIDGE_DESKTOP_RELAY_ROOT must be an absolute package directory')
  const modulePath = path.join(root, 'src', 'native-relay.mjs')
  const accountsPath = path.join(root, 'src', 'bridge-account-context.mjs')
  if (!fs.existsSync(modulePath) || !fs.existsSync(accountsPath)) {
    throw new Error('codex-mcp-bridge native relay is not installed; set CODEX_BRIDGE_DESKTOP_RELAY_ROOT to its package directory')
  }
  const native = await import(pathToFileURL(modulePath).href)
  const accounts = await import(pathToFileURL(accountsPath).href)
  if (typeof native.NativeDesktopRelay !== 'function' || typeof accounts.requireBridgeAccounts !== 'function' || typeof accounts.readBridgeAccounts !== 'function') {
    throw new Error('installed codex-mcp-bridge does not expose the expected native relay API')
  }
  const relay = new native.NativeDesktopRelay({ env, timeoutMs: 5000 })
  return {
    announce: (threadId, title) => relay.requestDesktop('set_thread_title', { threadId, title }, {
      // Recheck account identity on each announcement. Never read or forward tokens.
      accountContext: accounts.requireBridgeAccounts(accounts.readBridgeAccounts()),
      timeoutMs: 5000,
    }),
  }
}

export function createDesktopSync({ platform = process.platform, env = process.env, load = () => loadRelay(env), log = () => {} } = {}) {
  const enabled = platform === 'win32' && env.CODEX_BRIDGE_DESKTOP_SYNC === '1'
  const queues = new Map()
  let client
  return {
    enabled,
    announce(threadId, title) {
      if (!enabled || typeof threadId !== 'string' || !threadId || typeof title !== 'string' || !title.trim()) return Promise.resolve()
      // Announcements for the same thread remain ordered; different jobs do not block.
      const previous = queues.get(threadId) ?? Promise.resolve()
      const next = previous.then(async () => {
        try {
          client ??= Promise.resolve().then(load)
          const relay = await client
          const answer = await relay.announce(threadId, title)
          if (answer?.ok !== true || answer.operation !== 'set_thread_title' || answer.result?.threadId !== threadId || answer.result?.title !== title) {
            throw new Error('Desktop did not confirm this thread title')
          }
          log(`desktop sync: announced ${threadId}`)
        } catch (error) {
          client = undefined // A later turn can recover after installation/sign-in/reconnection.
          log(`desktop sync: ${threadId}: ${error?.message ?? error}`)
        }
      })
      queues.set(threadId, next)
      void next.then(() => { if (queues.get(threadId) === next) queues.delete(threadId) })
      return next
    },
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Only opaque digests escape this function; never parse, log or persist token contents. */
export function authState(env = process.env, io = fs) {
  const home = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'))
  const digest = file => {
    try { return createHash('sha256').update(io.readFileSync(path.join(home, file))).digest('hex') }
    catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error(`Cannot check Codex ${file}; check permissions on CODEX_HOME (contents were not logged).`)
    }
  }
  const auth = digest('auth.json')
  const config = digest('config.toml')
  let store = ''
  if (config) {
    // This setting is top-level TOML. A conservative fallback covers managed keyring settings too.
    const text = io.readFileSync(path.join(home, 'config.toml'), 'utf8').split(/^\s*\[/m)[0]
    store = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? ''
  }
  return { home, auth, config, externalStore: auth === null || ['keyring', 'auto', 'ephemeral'].includes(store) }
}

export const sameAuthState = (a, b) => a.home === b.home && a.auth === b.auth && a.config === b.config

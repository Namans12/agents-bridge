import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { authState, sameAuthState } from '../bin/auth-state.mjs'

test('auth contents are represented only by digest; changes, deletion and CODEX_HOME are detected', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { CODEX_HOME: home }
  fs.writeFileSync(path.join(home, 'auth.json'), 'synthetic-secret-one')
  const first = authState(env)
  assert.equal(sameAuthState(first, authState(env)), true)
  assert.doesNotMatch(JSON.stringify(first), /synthetic-secret/)
  assert.equal(first.externalStore, false)
  fs.writeFileSync(path.join(home, 'auth.json'), 'synthetic-secret-two')
  assert.equal(sameAuthState(first, authState(env)), false)
  fs.unlinkSync(path.join(home, 'auth.json'))
  assert.equal(authState(env).externalStore, true)
  assert.equal(sameAuthState(first, authState(env)), false)
  assert.equal(sameAuthState(first, authState({ CODEX_HOME: path.join(home, 'other') })), false)
})

test('keyring and config changes are recognized even with a leftover auth file', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'auth.json'), '{}')
  const first = authState({ CODEX_HOME: home })
  fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n')
  const after = authState({ CODEX_HOME: home })
  assert.equal(after.externalStore, true)
  assert.equal(sameAuthState(first, after), false)
})

for (const store of ['keyring', 'auto', 'ephemeral']) test(`${store} credentials with a leftover file are conservatively external`, () => {
  const io = { readFileSync(file) {
    return file.endsWith('auth.json') ? 'synthetic-secret' : `# macOS Keychain or other non-file store\ncli_auth_credentials_store = '${store}'\n[other]\nvalue = true\n`
  } }
  const state = authState({ CODEX_HOME: '/synthetic-codex' }, io)
  assert.equal(state.externalStore, true)
  assert.doesNotMatch(JSON.stringify(state), /synthetic-secret/)
  assert.equal(sameAuthState(state, authState({ CODEX_HOME: '/synthetic-codex' }, io)), true)
})

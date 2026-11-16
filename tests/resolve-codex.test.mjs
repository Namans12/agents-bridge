import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createCodexResolver } from '../bin/resolve-codex.mjs'

function layout(files = {}, env = {}, options = {}) {
  const calls = []
  const key = file => file.toLowerCase().replaceAll('\\', '/')
  const data = new Map(Object.entries(files).map(([file, value]) => [key(file), value]))
  const io = {
    statSync(file) { const value = data.get(key(file)); if (value === undefined) throw new Error('missing'); return { isFile: () => true, mtimeMs: value.mtime ?? 1 } },
    readFileSync(file) { return data.get(key(file))?.text ?? '' },
    readdirSync(dir) { const prefix = key(dir) + '/'; return [...new Set([...data.keys()].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]))] },
  }
  const resolve = createCodexResolver({ platform: 'win32', paths: path.win32, home: 'C:/Users/test',
    env: { PATH: 'C:/npm;C:/native', LOCALAPPDATA: 'C:/local', ProgramFiles: 'C:/programs', PATHEXT: '.CMD;.EXE', ...env }, io,
    run(file, args, settings) {
      calls.push([key(file), args, settings])
      if (data.get(key(file))?.invalid) return { status: 1, stdout: 'do not expose this output' }
      return { status: 0, stdout: args[0] === '--version' ? 'codex-cli 0.162.1' : 'Usage: codex app-server --listen <URL>' }
    }, ...options })
  return { resolve, data, calls }
}

test('existing override wins; native PATH executables precede shims and are validated once', () => {
  const fixture = layout({ 'C:/manual/codex.exe': {}, 'C:/native/codex.exe': {}, 'C:/npm/codex.cmd': {} })
  assert.equal(fixture.resolve('C:/manual/codex.exe'), 'C:/manual/codex.exe')
  fixture.resolve('C:/manual/codex.exe')
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.calls[0][2].timeout, 3000)
  assert.equal(fixture.calls[0][2].windowsHide, true)
  assert.equal(fixture.resolve('C:/missing.exe'), 'C:\\native\\codex.exe')
})

for (const extension of ['cmd', 'ps1']) test(`npm ${extension}-only PATH unwraps native optional package`, () => {
  const exe = 'C:/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
  const fixture = layout({ [`C:/npm/codex.${extension}`]: { text: extension === 'cmd'
    ? '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js"' : '"$basedir/node_modules/@openai/codex/bin/codex.js"' }, [exe]: {} })
  assert.equal(fixture.resolve().replaceAll('\\', '/'), exe)
  assert.ok(fixture.calls.every(([file]) => file.endsWith('.exe')))
})

test('supports older vendor/codex layout and ARM64', () => {
  const exe = 'C:/npm/node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/codex/codex.exe'
  const fixture = layout({ 'C:/npm/codex.cmd': { text: 'node_modules/@openai/codex/bin/codex.js' }, [exe]: {} }, {}, { arch: 'arm64' })
  assert.equal(fixture.resolve().replaceAll('\\', '/'), exe)
})

test('newest Desktop hash is selected and removed cache path is rediscovered', () => {
  const old = 'C:/local/OpenAI/Codex/bin/old/codex.exe'
  const fresh = 'C:/local/OpenAI/Codex/bin/new/codex.exe'
  const fixture = layout({ [old]: { mtime: 10 }, [fresh]: { mtime: 20 } })
  assert.equal(fixture.resolve().replaceAll('\\', '/').toLowerCase(), fresh.toLowerCase())
  fixture.data.delete(fresh.toLowerCase())
  assert.equal(fixture.resolve().replaceAll('\\', '/').toLowerCase(), old.toLowerCase())
})

test('Store CLI resource is last fallback; GUI executable is never selected', () => {
  const exe = 'C:/programs/WindowsApps/OpenAI.Codex_1_x64/app/resources/codex.exe'
  const fixture = layout({ [exe]: {}, 'C:/programs/WindowsApps/OpenAI.Codex_1_x64/app/Codex.exe': {} })
  assert.equal(fixture.resolve().replaceAll('\\', '/').toLowerCase(), exe.toLowerCase())
})

test('bad override falls back; nothing usable produces an actionable tried list without subprocess output', () => {
  const fixture = layout({ 'C:/native/codex.exe': { invalid: true }, 'C:/npm/codex.cmd': { text: 'unrecognized shim' } })
  assert.throws(() => fixture.resolve('C:/gone/codex.exe'), error => {
    assert.match(error.message, /Install\/update Codex/)
    assert.match(error.message, /gone.*missing/)
    assert.match(error.message, /--version failed/)
    assert.match(error.message, /OpenAI.*Codex.*bin/)
    assert.match(error.message, /WindowsApps/)
    assert.doesNotMatch(error.message, /do not expose/)
    return true
  })
})

test('POSIX configured and PATH binaries retain shell-free behavior', () => {
  const fixture = layout({ '/usr/local/bin/codex': {} }, { PATH: '/usr/bin:/usr/local/bin' }, { platform: 'linux', paths: path.posix })
  assert.equal(fixture.resolve('/missing/codex'), '/usr/local/bin/codex')
})

test('a version-only executable and a timed-out executable are rejected', () => {
  for (const failed of [{ status: 0, stdout: 'unknown command' }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    const fixture = layout({ 'C:/native/codex.exe': {} }, {}, { run: (_file, args) => args[0] === '--version'
      ? { status: 0, stdout: 'codex-cli 1.0.0' } : failed })
    assert.throws(() => fixture.resolve(), /app-server --help failed/)
  }
})

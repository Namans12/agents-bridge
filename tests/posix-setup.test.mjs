import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createCodexResolver } from '../bin/resolve-codex.mjs'
import { createAgyResolver } from '../bin/resolve-agy.mjs'
import { withPosixPath, npmGlobalBin } from '../bin/posix-paths.mjs'
import { bridgePaths, socketPathFits } from '../bin/socket-paths.mjs'
import { versionOf, versionAtLeast, pluginStatus, findCommand } from '../scripts/check-setup.mjs'

function fixture(platform, files, env = {}, prefix = '/custom/npm') {
  const present = new Set(files), calls = []
  const options = { platform, arch: 'arm64', env, paths: path.posix, home: '/Users/test',
    io: { statSync(file) { if (!present.has(file)) throw new Error('missing'); return { isFile: () => true } } },
    run(file, args, settings) {
      calls.push({ file, args, settings })
      if (args[0] === 'prefix') return { status: 0, stdout: prefix + '\n' }
      return { status: 0, stdout: args[0] === '--version' ? (file.endsWith('agy') ? 'agy 1.5.1' : 'codex-cli 0.162.1')
        : args[0] === 'acp' ? 'Usage: agy acp' : 'Usage: codex app-server --listen' }
    } }
  return { options, calls }
}

for (const platform of ['darwin', 'linux']) {
  for (const bin of ['codex', 'agy']) {
    const locations = ['/usr/local/bin', '/Users/test/.local/bin', '/Users/test/.npm-global/bin', '/Users/test/.codex/bin',
      ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/home/linuxbrew/.linuxbrew/bin'])]
    for (const dir of locations) test(`${platform}/arm64 PATH-less ${bin}: ${dir}`, () => {
      const file = `${dir}/${bin}`, f = fixture(platform, [file])
      const resolve = (bin === 'codex' ? createCodexResolver : createAgyResolver)(f.options)
      assert.equal(resolve('/missing/override'), file)
      assert.ok(f.calls.every(call => !call.settings.shell))
      assert.ok(f.calls[0].settings.env.PATH.includes('/usr/bin')) // npm /usr/bin/env node launchers
    })
    test(`${platform} ${bin} discovers a custom npm prefix without PATH or a shell`, () => {
      const f = fixture(platform, ['/usr/local/bin/npm', `/custom/npm/bin/${bin}`])
      assert.equal((bin === 'codex' ? createCodexResolver : createAgyResolver)(f.options)(), `/custom/npm/bin/${bin}`)
      assert.deepEqual(f.calls[0].args, ['prefix', '-g'])
    })
    test(`${platform} ${bin} honors npm prefix environment`, () => {
      const f = fixture(platform, [`/configured/prefix/bin/${bin}`], { NPM_CONFIG_PREFIX: '/configured/prefix' })
      assert.equal((bin === 'codex' ? createCodexResolver : createAgyResolver)(f.options)(), `/configured/prefix/bin/${bin}`)
    })
  }
}
for (const file of ['/Applications/Codex.app/Contents/Resources/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Users/test/Applications/Codex.app/Contents/Resources/codex', '/Users/test/.codex/codex']) {
  test(`darwin/arm64 discovers bundle or standalone candidate ${file}`, () => {
    const f = fixture('darwin', [file])
    assert.equal(createCodexResolver(f.options)(), file)
  })
}
test('POSIX discovery preserves explicit override and PATH priority; child PATH is augmented without mutating env', () => {
  const f = fixture('darwin', ['/chosen/codex', '/shell/bin/codex', '/opt/homebrew/bin/codex'], { PATH: '/shell/bin' })
  assert.equal(createCodexResolver(f.options)('/chosen/codex'), '/chosen/codex')
  assert.equal(createCodexResolver(f.options)(), '/shell/bin/codex')
  assert.equal(f.options.env.PATH, '/shell/bin')
  assert.equal(withPosixPath(f.options.env, f.options).PATH.split(':')[0], '/shell/bin')
  const windows = { PATH: 'C:\\bin', FLAG: 'keep' }
  assert.equal(withPosixPath(windows, { platform: 'win32' }), windows)
})
test('npm prefix output must be a successful single absolute path', () => {
  const f = fixture('linux', ['/usr/local/bin/npm'])
  for (const result of [{ status: 1, stdout: '/bad' }, { status: 0, stdout: 'relative' },
    { status: 0, stdout: '/first\n/second' }, { error: { code: 'ETIMEDOUT' } }]) {
    assert.equal(npmGlobalBin({ ...f.options, run: () => result }), undefined)
  }
})
for (const platform of ['darwin', 'linux']) test(`${platform} socket layout ignores long/multibyte TMPDIR and bounds the session key`, () => {
  const layout = bridgePaths({ platform, tmpdir: '/var/folders/' + 'longé'.repeat(100), uid: 4294967295,
    username: 'long'.repeat(100), sessionKey: 'a-'.repeat(100), build: '12345678' })
  assert.equal(layout.socket, '/tmp/cxb-4294967295/aaaaaaaaaaaaaaaa-12345678/s')
  assert.equal(socketPathFits(layout.socket, platform), true)
  assert.equal(socketPathFits('é'.repeat(52), 'darwin'), false)
  assert.equal(socketPathFits('a'.repeat(103), 'darwin'), true)
  assert.equal(socketPathFits('a'.repeat(104), 'darwin'), false)
  assert.equal(socketPathFits('a'.repeat(107), 'linux'), true)
  assert.equal(socketPathFits('a'.repeat(108), 'linux'), false)
})
test('Windows bridge directory layout remains unchanged', () => {
  assert.deepEqual(bridgePaths({ platform: 'win32', tmpdir: 'C:\\Temp', username: 'test.user', uid: undefined,
    sessionKey: 'ab-cd', build: '12345678' }), { base: 'C:\\Temp\\cxb-testuser', dir: 'C:\\Temp\\cxb-testuser\\abcd-12345678', socket: 'C:\\Temp\\cxb-testuser\\abcd-12345678\\s' })
})
test('setup version helpers reject missing, old and prerelease versions', () => {
  assert.equal(versionOf('2.1.296 (Claude Code)'), '2.1.296')
  assert.equal(versionOf('not installed'), undefined)
  for (const [version, expected] of [['2.1.287', true], ['2.1.296', true], ['3.0.0', true],
    ['2.1.286', false], ['2.0.999', false], ['2.1.287-beta.1', false], [undefined, false]]) {
    assert.equal(versionAtLeast(version, '2.1.287'), expected)
  }
})
test('setup plugin checks distinguish missing, disabled, stale cache, duplicate scopes, and current installs', () => {
  const current = { id: 'codex@codex-full-access', version: '0.2.4-fullaccess.6', enabled: true }
  const check = plugins => pluginStatus(JSON.stringify(plugins), current.version).level
  assert.equal(check([]), 'FAIL')
  assert.equal(check([{ ...current, enabled: false }]), 'FAIL')
  assert.equal(check([{ ...current, version: 'old' }]), 'WARN')
  assert.equal(check([{ ...current, folderVersion: 'old' }]), 'WARN')
  assert.equal(check([current, current]), 'WARN')
  assert.equal(check([current]), 'PASS')
  assert.equal(pluginStatus('invalid', current.version).level, 'WARN')
})
test('setup command discovery finds PATH-less Apple Silicon Node and local Claude', () => {
  const f = fixture('darwin', ['/opt/homebrew/bin/node', '/Users/test/.local/bin/claude'])
  assert.equal(findCommand('node', f.options), '/opt/homebrew/bin/node')
  assert.equal(findCommand('claude', f.options), '/Users/test/.local/bin/claude')
})

test('POSIX backend PATH includes an explicitly selected Node directory for npm shebangs', () => {
  const env = withPosixPath({ PATH: '/usr/bin' }, { platform: 'darwin', home: '/Users/test', paths: path.posix, nodeDir: '/custom/node/bin' })
  assert.equal(env.PATH.split(':')[0], '/usr/bin')
  assert.ok(env.PATH.split(':').includes('/custom/node/bin'))
})

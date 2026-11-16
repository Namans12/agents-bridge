import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { agyCommand, createAgyResolver } from '../bin/resolve-agy.mjs'

function fixture(files, outputs = {}, env = {}) {
  const calls = []
  const present = new Set(files)
  const resolve = createAgyResolver({ platform: 'win32', paths: path.win32, home: 'C:\\home',
    env: { PATH: 'C:\\bin', LOCALAPPDATA: 'C:\\local', PATHEXT: '.CMD;.EXE', ...env },
    io: { statSync: file => { if (!present.has(file)) throw new Error('missing'); return { isFile: () => true } } },
    run: (file, args, options) => {
      calls.push({ file, args, options })
      return outputs[file] ?? { status: 0, stdout: args.includes('--version') || args.join(' ').includes('--version') ? 'agy v1.5.1' : 'Usage: agy acp [flags]' }
    } })
  return { resolve, calls, present }
}

test('agy override, native PATH priority, cache and re-resolution', () => {
  const f = fixture(['C:\\custom\\agy.exe', 'C:\\bin\\agy.exe', 'C:\\bin\\agy.cmd'])
  assert.equal(f.resolve('C:\\custom\\agy.exe'), 'C:\\custom\\agy.exe')
  assert.equal(f.resolve('C:\\custom\\agy.exe'), 'C:\\custom\\agy.exe')
  assert.equal(f.calls.length, 2)
  f.present.delete('C:\\custom\\agy.exe')
  assert.equal(f.resolve('C:\\custom\\agy.exe'), 'C:\\bin\\agy.exe')
  assert.equal(f.calls[0].options.timeout, 3000)
})

test('agy CMD/PowerShell shims are explicit safely quoted launch descriptors', () => {
  const cmd = fixture(['C:\\bin\\agy.cmd'])
  assert.equal(cmd.resolve(), 'C:\\bin\\agy.cmd')
  assert.match(cmd.calls[0].file, /cmd.exe$/)
  assert.deepEqual(cmd.calls[0].args.slice(0, 4), ['/d', '/s', '/v:off', '/c'])
  assert.equal(cmd.calls[0].options.windowsVerbatimArguments, true)
  const ps = fixture(['C:\\bin\\agy.ps1'])
  assert.equal(ps.resolve(), 'C:\\bin\\agy.ps1')
  assert.match(ps.calls[0].file, /powershell.exe$/)
  assert.throws(() => agyCommand('C:\\bad%PATH%\\agy.cmd', ['acp'], { platform: 'win32' }), /Unsafe/)
})

test('agy documented Windows location, old version, no acp, timeout and missing diagnostics', () => {
  assert.equal(fixture(['C:\\local\\agy\\bin\\agy.exe']).resolve(), 'C:\\local\\agy\\bin\\agy.exe')
  assert.throws(() => fixture(['C:\\bin\\agy.exe'], { 'C:\\bin\\agy.exe': { status: 0, stdout: 'agy 1.4.9' } }).resolve(), /requires agy >= 1.5.1/)
  assert.throws(() => fixture(['C:\\bin\\agy.exe'], { 'C:\\bin\\agy.exe': { status: 0, stdout: 'agy 1.5.1' } }).resolve(), /acp subcommand not available/)
  assert.throws(() => fixture(['C:\\bin\\agy.exe'], { 'C:\\bin\\agy.exe': { error: { code: 'ETIMEDOUT' } } }).resolve(), /ETIMEDOUT/)
  assert.throws(() => fixture([]).resolve(), /Install the official CLI.*run agy interactively/s)
})

test('agy POSIX PATH uses no shell', () => {
  const resolve = createAgyResolver({ platform: 'linux', paths: path.posix, env: { PATH: '/bin' }, home: '/home/test',
    io: { statSync: file => { if (file !== '/bin/agy') throw new Error(); return { isFile: () => true } } },
    run: (_file, args) => ({ status: 0, stdout: args[0] === '--version' ? '1.5.1' : 'agy acp' }) })
  assert.equal(resolve(), '/bin/agy')
})

test('real Windows CMD and PS1 shims launch Node fixture with spaces in paths', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy shim '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
  const cmd = path.join(dir, 'agy.cmd')
  const ps = path.join(dir, 'agy.ps1')
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
  fs.writeFileSync(ps, `& '${process.execPath.replaceAll("'", "''")}' '${fixture.replaceAll("'", "''")}' @args\r\nexit $LASTEXITCODE\r\n`)
  for (const file of [cmd, ps]) {
    const resolve = createAgyResolver({ env: { ...process.env, PATH: dir } })
    assert.equal(resolve(file), file)
    const launch = agyCommand(file, ['--version'])
    const result = spawnSync(launch.file, launch.args, { ...launch, timeout: 3000, windowsHide: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /agy 1.5.1/)
  }
})

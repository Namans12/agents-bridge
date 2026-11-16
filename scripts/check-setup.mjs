// Read-only diagnostics, except a throwaway local Unix socket removed before exit.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCodexResolver } from '../bin/resolve-codex.mjs'
import { createAgyResolver, agyCommand } from '../bin/resolve-agy.mjs'
import { posixBinDirs, withPosixPath } from '../bin/posix-paths.mjs'
import { bridgePaths, socketPathFits } from '../bin/socket-paths.mjs'

export const versionOf = text => /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/.exec(text || '')?.[1]
export function versionAtLeast(value, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(value || '')) return false
  const parts = value.split('.').map(Number), floor = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (parts[i] !== floor[i]) return parts[i] > floor[i] }
  return true
}
export function pluginStatus(output, expected) {
  let plugins
  try { plugins = JSON.parse(output) } catch { return { level: 'WARN', text: 'Cannot parse plugin list JSON; check claude plugin list manually.' } }
  if (!Array.isArray(plugins)) return { level: 'WARN', text: 'Unknown plugin list format; check claude plugin list manually.' }
  const matches = plugins.filter(p => p.id === 'codex@codex-full-access')
  if (!matches.length) return { level: 'FAIL', text: 'codex@codex-full-access is missing. Run claude plugin install codex@codex-full-access.' }
  if (!matches.some(p => p.enabled === true)) return { level: 'FAIL', text: 'codex@codex-full-access is disabled. Run claude plugin enable codex@codex-full-access.' }
  if (matches.length > 1 || matches.some(p => p.version !== expected || (p.folderVersion && p.folderVersion !== expected))) {
    return { level: 'WARN', text: `Plugin version differs from repository ${expected}, or multiple scopes exist; cache/source may be stale. Update the marketplace, uninstall/reinstall, then start a new Claude session.` }
  }
  return { level: 'PASS', text: `codex@codex-full-access enabled, version ${expected}.` }
}

export function findCommand(name, { platform = process.platform, env = process.env, home = os.homedir(), io = fs, paths = path } = {}) {
  const dirs = platform === 'win32' ? [...(env.PATH || env.Path || '').split(';'), paths.join(home, '.local', 'bin')]
    : posixBinDirs({ platform, env, home, paths })
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : ['']
  for (const dir of dirs.filter(Boolean)) for (const ext of extensions) {
    const file = paths.join(dir.replace(/^"|"$/g, ''), name + ext)
    try { if (io.statSync(file).isFile()) return file } catch {}
  }
  return name
}

export async function probeUnixSocket(base) {
  let madeBase = false, dir, server
  try {
    try { fs.mkdirSync(base, { mode: 0o700 }); madeBase = true } catch (e) { if (e.code !== 'EEXIST') throw e }
    const stat = fs.lstatSync(base)
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe base')
    dir = fs.mkdtempSync(path.join(base, 'check-'))
    server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path.join(dir, 's'), resolve)
    })
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    if (madeBase) { try { fs.rmdirSync(base) } catch {} }
  }
}

export async function main({ log = console.log } = {}) {
  let failures = 0
  const report = (level, text) => { if (level === 'FAIL') failures++; log(`${level} ${text}`) }
  const env = withPosixPath({ ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const run = (file, args, options = {}) => {
    const command = agyCommand(file, args)
    return spawnSync(command.file, command.args, { ...command, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 1024 * 1024, windowsHide: true, env, ...options })
  }
  const versionCheck = (label, result, minimum) => {
    const version = versionOf(`${result.stdout || ''}\n${result.stderr || ''}`)
    const good = !result.error && result.status === 0 && versionAtLeast(version, minimum)
    report(good ? 'PASS' : 'FAIL', `${label}: ${version || 'unavailable'} (requires >= ${minimum}).${good ? '' : ' Install/update it and reopen the terminal.'}`)
    return good
  }
  versionCheck('Node', { status: 0, stdout: process.versions.node }, '18.0.0')
  report('PASS', `Platform ${process.platform}/${process.arch}; Node ${process.execPath}.`)
  if (process.platform === 'darwin' && process.arch !== 'arm64') report('WARN', 'Node is not arm64; on Apple Silicon use native Homebrew Node and disable Rosetta for Terminal.')
  const claude = findCommand('claude')
  versionCheck('Claude Code', run(claude, ['--version']), '2.1.287')
  const manifest = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const plugins = run(claude, ['plugin', 'list', '--json'])
  if (plugins.error || plugins.status !== 0) report('FAIL', 'claude plugin list failed; check Claude installation and run it manually.')
  else { const result = pluginStatus(plugins.stdout, manifest.version); report(result.level, result.text) }
  try {
    const codex = createCodexResolver({ env })()
    const result = run(codex, ['--version'])
    const version = versionOf(`${result.stdout || ''}\n${result.stderr || ''}`)
    report(result.status === 0 && !result.error && version ? 'PASS' : 'FAIL', `Codex ${codex}; version ${version || 'unavailable'}.`)
    // Auth stdout/stderr can contain account identifiers. Never capture or print either.
    const auth = run(codex, ['login', 'status'], { stdio: 'ignore' })
    report(auth.status === 0 && !auth.error ? 'PASS' : 'FAIL', `codex login status exit ${auth.status ?? 'unavailable'}.${auth.status === 0 ? '' : ' Run codex login yourself in the same environment.'}`)
  } catch { report('FAIL', 'Codex discovery failed. Install/update Codex, check PATH, or configure its absolute binary path; app-server --listen is required.') }
  try {
    const agy = createAgyResolver({ env })()
    const result = run(agy, ['--version'])
    const version = versionOf(`${result.stdout || ''}\n${result.stderr || ''}`)
    report(result.status === 0 && versionAtLeast(version, '1.5.1') ? 'PASS' : 'WARN', `Optional agy ${agy}; version ${version || 'unavailable'} (requires >= 1.5.1).`)
  } catch { report('WARN', 'Optional agy >= 1.5.1 with ACP not found. Install the official CLI and sign in interactively if using Antigravity.') }
  if (process.platform === 'win32') {
    const pwsh = process.env.CODEX_BRIDGE_PWSH || findCommand('pwsh')
    versionCheck('PowerShell', run(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']), '7.0.0')
    report('PASS', `CODEX_BRIDGE_DESKTOP_SYNC is ${process.env.CODEX_BRIDGE_DESKTOP_SYNC === '1' ? 'enabled (optional relay required)' : 'disabled'}; this feature is Windows-only.`)
  } else {
    const layout = bridgePaths({ platform: process.platform, tmpdir: os.tmpdir(), uid: process.getuid(),
      username: os.userInfo().username, sessionKey: '0123456789abcdef', build: '01234567' })
    report(socketPathFits(layout.socket, process.platform) ? 'PASS' : 'FAIL', `Bridge Unix socket ${layout.socket}: ${Buffer.byteLength(layout.socket)} bytes (must be < ${process.platform === 'darwin' ? 104 : 108}). Uses /tmp, independent of TMPDIR.`)
    const msg = fileURLToPath(new URL('../bin/codex-msg', import.meta.url))
    try {
      fs.accessSync(msg, fs.constants.X_OK)
      report('PASS', 'bin/codex-msg is executable.')
    } catch { report('FAIL', 'bin/codex-msg is not executable. Run chmod +x bin/codex-msg in the repository.') }
    try { await probeUnixSocket(layout.base); report('PASS', 'Throwaway Unix socket created and removed under the bridge directory.') }
    catch { report('FAIL', 'Cannot create a private Unix socket under the bridge directory; check /tmp ownership, permissions and local socket support.') }
  }
  report(failures ? 'FAIL' : 'PASS', `Setup check complete: ${failures} failing checks. No model turns or login changes were requested.`)
  return failures ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(() => { console.error('FAIL Setup check could not finish; check file permissions and installation.'); process.exitCode = 1 })
}

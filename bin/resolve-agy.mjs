import { posixBinDirs, npmGlobalBin, withPosixPath } from './posix-paths.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const MIN_AGY_VERSION = '1.5.1'
export const cleanAgyEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) =>
  !/^(GEMINI_API_KEY.*|GOOGLE_API_KEY.*|GOOGLE_CLOUD_API_KEY.*|GOOGLE_GENAI_USE_.*|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|AGY_ADC_AUTH|GOOGLE_CLOUD_(PROJECT|LOCATION)|GCLOUD_PROJECT|VERTEX_.*)$/i.test(key)))

/** Official Windows installer supplies agy.exe. Custom PATH shims are supported without shell:true. */
export function agyCommand(file, args, { platform = process.platform, env = process.env, paths = path } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // cmd expands these even inside quotes. Refuse rather than interpolate an unsafe path/argument.
    if ([file, ...args].some(value => /["%\r\n!^&|<>]/.test(value))) throw new Error('Unsafe characters in agy CMD launcher path/arguments; use the native agy.exe instead')
    return { file: env.ComSpec || paths.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/v:off', '/c', `""${file}" ${args.map(value => `"${value}"`).join(' ')}"`], windowsVerbatimArguments: true }
  }
  if (platform === 'win32' && /\.ps1$/i.test(file)) {
    return { file: paths.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] }
  }
  return { file, args }
}

export function createAgyResolver({ platform = process.platform, arch = process.arch, env = process.env, paths = path,
  home = os.homedir(), io = fs, run = spawnSync, now = Date.now } = {}) {
  let cached
  const exists = file => { try { return io.statSync(file).isFile() } catch { return false } }
  return function resolveAgy(configured = '') {
    if (cached?.configured === configured && exists(cached.file) && now() - cached.at < 60_000) return cached.file
    const tried = []
    const search = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
      .map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean)
    const extensions = platform === 'win32'
      ? [...new Set(['.exe', ...(env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';'), '.ps1'])]
        .filter(ext => ['.exe', '.cmd', '.bat', '.ps1', '.com'].includes(ext)) : ['']
    const candidates = [configured, ...extensions.flatMap(ext => search.map(dir => paths.join(dir, `agy${ext}`))),
      platform === 'win32' ? paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
        : paths.join(home, '.local', 'bin', 'agy')].filter(Boolean)
    // Lazy generator keeps npm prefix discovery behind the ordinary candidates.
    function* allCandidates() {
      yield* candidates
      if (platform !== 'win32') {
        const options = { platform, arch, env, home, paths, io, run }
        yield* posixBinDirs(options).map(dir => paths.join(dir, 'agy'))
        const npmBin = npmGlobalBin(options)
        if (npmBin) yield paths.join(npmBin, 'agy')
      }
    }
    const seen = new Set()
    for (const file of allCandidates()) {
      if (seen.has(file)) continue
      seen.add(file)
      if (!exists(file)) { tried.push(`${file}: missing`); continue }
      let valid = true
      for (const args of [['--version'], ['acp', '--help']]) {
        let result
        try {
          const command = agyCommand(file, args, { platform, env, paths })
          result = run(command.file, command.args, { ...command, env: withPosixPath(cleanAgyEnv(env), { platform, home, paths }), encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 })
        } catch { valid = false; tried.push(`${file}: cannot launch safely`); break }
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        if (result.error || result.status !== 0) {
          tried.push(`${file}: ${args.join(' ')} failed (${result.error?.code ?? result.status})`); valid = false; break
        }
        if (args[0] === '--version') {
          const match = /\bv?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?\b/i.exec(output)
          const version = match?.slice(1, 4).map(Number)
          const minimum = [1, 5, 1]
          const diff = version?.findIndex((value, index) => value !== minimum[index])
          if (!version || match[4] || (diff !== -1 && version[diff] < minimum[diff])) {
            tried.push(`${file}: requires agy >= ${MIN_AGY_VERSION}${match ? ` (found ${match[0]})` : ''}`); valid = false; break
          }
        } else if (!/\bacp\b/i.test(output)) { tried.push(`${file}: acp subcommand not available`); valid = false; break }
      }
      if (valid) { cached = { configured, file, at: now() }; return file }
    }
    throw new Error(`Cannot find Antigravity CLI agy >= ${MIN_AGY_VERSION} with ACP support. Install the official CLI using https://antigravity.google/docs/getting-started (PowerShell: irm https://antigravity.google/cli/install.ps1 | iex), reopen Claude, then run agy interactively to sign in with Google. Or set the plugin's Antigravity binary (agyPath) to its absolute path. Desktop/IDE launchers are not the CLI. Tried:\n${tried.join('\n') || 'PATH is empty'}`)
  }
}

export const resolveAgy = createAgyResolver()

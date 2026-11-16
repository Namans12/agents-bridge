import { posixBinDirs, npmGlobalBin, withPosixPath } from './posix-paths.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

/** Shell-free discovery. Dependencies are injectable so Windows layouts can be tested anywhere. */
export function createCodexResolver({ platform = process.platform, arch = process.arch, env = process.env,
  io = fs, paths = path, home = os.homedir(), run = spawnSync } = {}) {
  let cached
  const exists = file => { try { return io.statSync(file).isFile() } catch { return false } }
  const entries = dir => { try { return io.readdirSync(dir) } catch { return [] } }
  const newest = files => files.sort((a, b) => {
    const mtime = file => { try { return io.statSync(file).mtimeMs } catch { return 0 } }
    return mtime(b) - mtime(a) || b.localeCompare(a)
  })
  return function resolveCodex(configured = '') {
    if (cached?.configured === configured && exists(cached.file)) return cached.file
    const tried = []
    const seen = new Set()
    const verify = file => {
      if (!file || seen.has(file)) return
      seen.add(file)
      if (!exists(file)) { tried.push(`${file}: missing`); return }
      if (platform === 'win32' && !/\.exe$/i.test(file)) {
        tried.push(`${file}: launcher, not a native .exe`)
        return
      }
      for (const args of [['--version'], ['app-server', '--help']]) {
        const result = run(file, args, { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024,
          ...(platform !== 'win32' ? { env: withPosixPath(env, { platform, home, paths }) } : {}) })
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        if (result.error || result.status !== 0 || !(args[0] === '--version' ? /codex\S*\s+\d/i : /--listen\b/).test(output)) {
          // Do not include command output: user wrappers could print credentials.
          tried.push(`${file}: ${args.join(' ')} failed (${result.error?.code ?? result.status ?? 'invalid output'})`)
          return
        }
      }
      cached = { configured, file }
      return file
    }
    let found = verify(configured)
    if (found) return found
    const search = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')
      .map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean)
    if (platform !== 'win32') {
      const options = { platform, arch, env, home, paths, io, run }
      for (const dir of posixBinDirs(options)) { found = verify(paths.join(dir, 'codex')); if (found) return found }
      const npmBin = npmGlobalBin(options)
      if (npmBin) { found = verify(paths.join(npmBin, 'codex')); if (found) return found }
      const bundles = platform === 'darwin' ? ['/Applications', paths.join(home, 'Applications')].flatMap(root => [
        paths.join(root, 'Codex.app', 'Contents', 'Resources', 'codex'),
        paths.join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
        paths.join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
      ]) : []
      for (const file of [paths.join(home, '.codex', 'codex'), ...bundles]) { found = verify(file); if (found) return found }
    } else {
      // PATHEXT-aware, but only .exe is suitable for a shell-free native spawn.
      const extensions = [...new Set(['.exe', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';'), '.ps1'])]
      for (const dir of search) { found = verify(paths.join(dir, 'codex.exe')); if (found) return found }
      const shims = [configured, ...search.flatMap(dir => extensions.filter(ext => ['.cmd', '.ps1'].includes(ext))
        .map(ext => paths.join(dir, `codex${ext}`)))].filter(file => file && /\.(cmd|ps1)$/i.test(file) && exists(file))
      for (const shim of shims) {
        tried.push(`${shim}: inspecting npm launcher`)
        let source
        try { source = io.readFileSync(shim, 'utf8').replaceAll('\\', '/') } catch { continue }
        // npm's actual cmd and PowerShell launchers point here; never execute the shim.
        if (!/node_modules\/@openai\/codex\/bin\/codex\.js/i.test(source)) continue
        const root = paths.join(paths.dirname(shim), 'node_modules', '@openai', 'codex')
        const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
        let vendor
        try {
          const require = createRequire(paths.join(root, 'package.json'))
          vendor = paths.join(paths.dirname(require.resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor')
        } catch {}
        // Nested and hoisted optional packages, plus older bundled vendor layouts.
        for (const base of [vendor, paths.join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor'),
          paths.join(paths.dirname(root), `codex-win32-${arch}`, 'vendor'), paths.join(root, 'vendor')].filter(Boolean)) {
          for (const leaf of ['bin', 'codex']) {
            found = verify(paths.join(base, triple, leaf, 'codex.exe'))
            if (found) return found
          }
        }
      }
      const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local')
      const bin = paths.join(local, 'OpenAI', 'Codex', 'bin')
      tried.push(`${bin}/*/codex.exe: newest first`)
      for (const file of newest(entries(bin).map(name => paths.join(bin, name, 'codex.exe')).filter(exists))) {
        found = verify(file); if (found) return found
      }
      // Store's CLI resource, never the GUI app/Codex.exe. Inaccessible packages are skipped.
      const store = paths.join(env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
      tried.push(`${store}/OpenAI.Codex_*/app/resources/codex.exe`)
      let packages = entries(store).filter(name => /^OpenAI\.Codex_/i.test(name)).map(name => paths.join(store, name))
      if (!packages.length) {
        // WindowsApps listing can be denied even when the current user's registered package is readable.
        const powershell = paths.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        tried.push('Get-AppxPackage OpenAI.Codex: registered Store locations')
        const result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          'ConvertTo-Json -Compress -InputObject @(Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation)'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 })
        try {
          const locations = JSON.parse(result.stdout)
          if (Array.isArray(locations)) packages = locations.filter(file => typeof file === 'string' && paths.isAbsolute(file))
        } catch {}
      }
      for (const file of newest(packages.map(dir => paths.join(dir, 'app', 'resources', 'codex.exe')).filter(exists))) {
        found = verify(file); if (found) return found
      }
    }
    throw new Error(`Cannot find a working Codex CLI with app-server --listen support. Install/update Codex, reopen Claude so it inherits PATH, or set the plugin's Codex binary to an existing native executable. Tried:\n${tried.join('\n') || 'PATH is empty'}`)
  }
}

export const resolveCodex = createCodexResolver()

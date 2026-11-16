import os from 'node:os'
import path from 'node:path'

/** GUI launches need not inherit a login shell's PATH. Keep its order, then add common installs. */
export function posixBinDirs({ platform = process.platform, env = process.env, home = os.homedir(), paths = path,
  nodeDir = platform === process.platform ? paths.dirname(process.execPath) : '' } = {}) {
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX
  return [...new Set([
    ...(env.PATH || '').split(':').map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean),
    ...(nodeDir ? [nodeDir] : []),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/home/linuxbrew/.linuxbrew/bin']),
    '/usr/local/bin', '/usr/bin', '/bin',
    ...(prefix && paths.isAbsolute(prefix) ? [paths.join(prefix, 'bin')] : []),
    paths.join(home, '.local', 'bin'), paths.join(home, '.npm-global', 'bin'), paths.join(home, '.codex', 'bin'),
  ])]
}

export function withPosixPath(env = process.env, options = {}) {
  return (options.platform || process.platform) === 'win32' ? env
    : { ...env, PATH: posixBinDirs({ ...options, env }).join(':') }
}

/** Ask only an installed npm, without a shell or registry access. Custom prefixes remain discoverable. */
export function npmGlobalBin(options) {
  const { io, paths, run } = options
  for (const dir of posixBinDirs(options)) {
    const npm = paths.join(dir, 'npm')
    try { if (!io.statSync(npm).isFile()) continue } catch { continue }
    const result = run(npm, ['prefix', '-g'], { env: withPosixPath(options.env, options), encoding: 'utf8',
      timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 })
    const prefix = result.stdout?.trim()
    if (!result.error && result.status === 0 && prefix && !/[\r\n]/.test(prefix) && paths.isAbsolute(prefix)) return paths.join(prefix, 'bin')
  }
}

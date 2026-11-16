import path from 'node:path'

/** Pure layout calculation shared with the setup check. POSIX deliberately ignores TMPDIR. */
export function bridgePaths({ platform, tmpdir, username, uid, sessionKey, build }) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const base = platform === 'win32' ? paths.join(tmpdir, `cxb-${username.replace(/[^A-Za-z0-9]/g, '')}`) : `/tmp/cxb-${uid}`
  const key = sessionKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'default'
  const dir = paths.join(base, `${key}-${build}`)
  return { base, dir, socket: paths.join(dir, 's') }
}

// Reserve one byte for NUL (Darwin sun_path has 104 bytes, Linux 108).
export const socketPathFits = (file, platform) => Buffer.byteLength(file) < (platform === 'darwin' ? 104 : 108)

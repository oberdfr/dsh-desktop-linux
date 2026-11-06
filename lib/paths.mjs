/** Per-user installation paths, independent of the shared Harness data home. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function paths(env = process.env) {
  const home = env.HOME || homedir()
  const xdg = (name, fallback) => {
    if (env[name] && !isAbsolute(env[name])) throw new Error(`${name} must be absolute`)
    return env[name] || join(home, fallback)
  }
  const data = join(xdg('XDG_DATA_HOME', '.local/share'), 'dsh-desktop-linux')
  return {
    data, releases: join(data, 'releases'), active: join(data, 'active.json'), lock: join(data, 'operation.lock'),
    applications: join(xdg('XDG_DATA_HOME', '.local/share'), 'applications'),
    wrapper: join(data, 'launch'), desktop: join(xdg('XDG_DATA_HOME', '.local/share'), 'applications/dsh-desktop-linux.desktop'),
    cache: join(xdg('XDG_CACHE_HOME', '.cache'), 'dsh-desktop-linux'),
    userData: join(xdg('XDG_CONFIG_HOME', '.config'), 'dsh-desktop-linux'),
    dshHome: resolve(env.DSH_HOME?.trim() || join(home, '.dsh')),
  }
}

export function releaseId(manifest) {
  return `${manifest.distributionVersion}-${manifest.upstreamCommit.slice(0, 12)}-${manifest.arch}`
}

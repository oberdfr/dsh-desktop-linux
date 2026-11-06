/** Fetch and build only the pinned, unmodified upstream checkout. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const upstream = join(root, '.cache/upstream')
export const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'))
export function verifyUpstream(directory = upstream, expected = lock.commit) {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
  if (git('rev-parse', 'HEAD') !== expected) throw new Error('Upstream commit does not match upstream.lock.json')
  if (git('status', '--porcelain', '--untracked-files=no') !== '') throw new Error('Upstream tracked files have changed; refusing to build')
  return expected
}
export function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${code ?? signal})`)))
  })
}
async function main() {
  if (process.argv[2] === 'build') {
    if (!existsSync(join(upstream, '.git'))) {
      mkdirSync(join(root, '.cache'), { recursive: true })
      await run('git', ['clone', '--no-checkout', lock.repository, upstream])
      await run('git', ['checkout', '--detach', lock.commit], upstream)
    }
    verifyUpstream()
    try {
      await run('pnpm', ['install', '--frozen-lockfile'], upstream)
      await run('pnpm', ['run', 'build:artifacts'], upstream)
      await run('pnpm', ['--dir', 'native/system', 'run', 'build:native'], upstream)
      await run('pnpm', ['run', 'build:check'], upstream)
    } finally { verifyUpstream() }
  } else if (process.argv[2] === 'verify') console.log(`Unmodified upstream: ${verifyUpstream()}`)
  else throw new Error('Usage: upstream.mjs build|verify')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()

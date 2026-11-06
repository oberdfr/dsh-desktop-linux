/** Invoke the upstream payload builder directly; its Desktop target CLI does not support Linux. */
import { preparePrimaryRuntime, smokePrimaryRuntime } from '../.cache/upstream/scripts/primary-runtime/prepare.ts'
import { writeDesktopRuntime } from '../.cache/upstream/apps/desktop/src/runtime-tree.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../.cache/upstream/apps/desktop/src/host-protocol.ts'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const [root, runtime] = process.argv.slice(2)
if (!root || !runtime) throw new Error('Expected output and runtime directories')
const lock = JSON.parse(readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
await preparePrimaryRuntime({ target: 'linux-x64', output: root, cache: join(root, '../../downloads'), version: lock.version })
smokePrimaryRuntime(join(root, 'primary-runtime'))
const versions = JSON.parse(readFileSync(join(root, 'primary-runtime/runtime.json'), 'utf8'))
const modules = join(runtime, 'node_modules')
const names = readdirSync(modules).flatMap(name => name.startsWith('@')
  ? readdirSync(join(modules, name)).map(child => `${name}/${child}`) : name.startsWith('.') ? [] : [name])
  .filter(name => { try { return statSync(join(modules, name, 'package.json')).isFile() } catch { return false } })
writeDesktopRuntime(runtime, { schemaVersion: 1, version: lock.version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  nodeVersion: versions.node, pnpmVersion: versions.pnpm }, names, { platform: 'linux', arch: 'x64' })

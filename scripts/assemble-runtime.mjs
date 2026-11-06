/** Freeze a production graph from packed upstream packages, without deploying workspace links. */
import { createRequire } from 'node:module'
import { globSync, readFileSync, existsSync, statSync } from 'node:fs'
import { mkdir, copyFile, writeFile, cp, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { root, upstream, run, verifyUpstream, lock } from './upstream.mjs'
const requireUpstream = createRequire(join(upstream, 'package.json'))
const yaml = requireUpstream('js-yaml')
const workspace = yaml.load(readFileSync(join(upstream, 'pnpm-workspace.yaml'), 'utf8'))
const packages = new Map(globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: upstream })
  .map(file => { const manifest = JSON.parse(readFileSync(join(upstream, file), 'utf8')); return [manifest.name, { manifest, source: join(upstream, dirname(file)) }] }))
const selected = new Map()
function visit(name) {
  if (selected.has(name) || !packages.has(name)) return
  const pkg = packages.get(name)
  const matches = (values, value) => !values || (!values.includes(`!${value}`) && (values.includes(value) || values.every(x => x.startsWith('!'))))
  if (!matches(pkg.manifest.os, lock.platform) || !matches(pkg.manifest.cpu, lock.arch)) return
  selected.set(name, pkg)
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(pkg.manifest[section] ?? {})) visit(dependency)
  }
}
visit('@deepseek-ai/dsh-desktop-host')
visit('@deepseek-ai/dsh-client-shortcuts')
visit('@deepseek-ai/dsh-client-ui-settings-general')
/**
 * Upstream packages import a few workspace modules they do not declare, because the
 * monorepo hoists them. A carrier must resolve what the built code actually imports, so
 * extend the closure over the emitted `lib/` specifiers of every selected package.
 */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/gu
const builtFiles = source => globSync('lib/**/*.{js,mjs,cjs}', { cwd: source })
for (let changed = true; changed;) {
  changed = false
  for (const pkg of [...selected.values()]) {
    const specifiers = new Set()
    for (const file of builtFiles(pkg.source)) {
      for (const match of readFileSync(join(pkg.source, file), 'utf8').matchAll(IMPORT_SPECIFIER)) specifiers.add(match[2])
    }
    for (const specifier of specifiers) {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (!packages.has(name) || selected.has(name)) continue
      visit(name)
      if (selected.has(name)) changed = true
    }
  }
}
const isBinaryPackage = pkg => existsSync(join(pkg.source, 'prebuilds.json'))
  || Object.keys(pkg.manifest.bin ?? {}).length > 0
  || (pkg.manifest.files ?? []).some(entry => entry.startsWith('bin/'))
const withoutBuild = [...selected.values()].filter(pkg => !isBinaryPackage(pkg) && builtFiles(pkg.source).length === 0)
if (withoutBuild.length > 0) throw new Error(`Selected packages have no built lib/: ${withoutBuild.map(pkg => pkg.manifest.name).join(', ')}`)
const project = join(root, '.cache/runtime-project')
const packed = join(project, 'packages')
await mkdir(packed, { recursive: true })
const entries = [...selected.entries()].sort(([a], [b]) => a.localeCompare(b))
const remaining = entries.values()
const packedResults = await Promise.allSettled(Array.from({ length: 4 }, async () => {
  for (const [name, pkg] of remaining) {
    const filename = `${name.replaceAll('@', '').replaceAll('/', '-')}.tgz`
    pkg.spec = `file:./packages/${filename}`
    if (!existsSync(join(packed, filename))) await run('pnpm', ['--dir', pkg.source, 'pack', '--out', join(packed, filename)])
  }
}))
const packingFailure = packedResults.find(result => result.status === 'rejected')
if (packingFailure) throw packingFailure.reason
const overrides = Object.fromEntries(entries.map(([name, pkg]) => [name, pkg.spec]))
const manifest = { name: 'dsh-desktop-linux-runtime', version: lock.version, private: true, type: 'module',
  // Every selected monorepo package is a direct dependency: upstream packages import some
  // workspace modules they do not declare, relying on monorepo hoisting at build time.
  dependencies: { ...overrides, zod: '4.4.3', ws: '8.21.3', semver: '7.8.5' } }
await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
// Preserve the upstream patches for third-party dependencies, not new Linux patches.
const patchedDependencies = {}
for (const [name, path] of Object.entries(workspace.patchedDependencies ?? {})) {
  await mkdir(dirname(join(project, path)), { recursive: true })
  await copyFile(join(upstream, path), join(project, path))
  patchedDependencies[name] = path
}
const allowBuilds = { ...workspace.allowBuilds,
  [`@deepseek-ai/dsh-subprocess-local@${overrides['@deepseek-ai/dsh-subprocess-local'].replace('file:./', 'file:')}`]: true }
await writeFile(join(project, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
  overrides, patchedDependencies, allowUnusedPatches: true, allowBuilds }))
const frozen = join(root, 'locks', lock.commit, 'pnpm-lock.yaml')
const frozenInputs = join(root, 'locks', lock.commit, 'inputs.json')
await mkdir(dirname(frozen), { recursive: true })
const environment = { ...process.env }
for (const name of Object.keys(environment)) if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(name) || name === 'NODE_OPTIONS' || name === 'NODE_PATH') delete environment[name]
// A lock is reusable only for the exact package selection and build policy that produced it.
const inputs = createHash('sha256').update(JSON.stringify({ dependencies: manifest.dependencies, overrides, patchedDependencies, allowBuilds, nodeLinker: 'hoisted' })).digest('hex')
const reusable = existsSync(frozen) && existsSync(frozenInputs) && readFileSync(frozenInputs, 'utf8').trim() === inputs
if (reusable) await copyFile(frozen, join(project, 'pnpm-lock.yaml'))
else {
  await run('pnpm', ['install', '--lockfile-only'], project, environment)
  await copyFile(join(project, 'pnpm-lock.yaml'), frozen)
  await writeFile(frozenInputs, `${inputs}\n`)
}
try {
  await run('pnpm', ['install', '--prod', '--frozen-lockfile'], project, environment)
} catch (error) {
  // Packed tarball bytes can differ while the selected packages stay the same; that is a
  // stale lockfile, not a dependency change, so regenerate once and retry.
  await rm(frozen)
  await run('pnpm', ['install', '--lockfile-only'], project, environment)
  await copyFile(join(project, 'pnpm-lock.yaml'), frozen)
  await writeFile(frozenInputs, `${inputs}\n`)
  await run('pnpm', ['install', '--prod', '--frozen-lockfile'], project, environment)
}
const destination = join(root, 'dist/payload/dsh')
// This is this builder's generated output, never a user's checkout or installed release.
await rm(destination, { recursive: true, force: true })
await cp(project, destination, { recursive: true, dereference: true, filter: path => !path.includes(`${project}/node_modules/.pnpm`) })
// No package-manager cache, tarballs or patch inputs are needed at runtime.
for (const file of ['packages', 'patches']) await rm(join(destination, file), { recursive: true, force: true })
await copyFile(frozen, join(root, 'dist/payload/production-lock.yaml'))
const inventory = entries.map(([name, pkg]) => ({ name, version: pkg.manifest.version,
  sha256: createHash('sha256').update(readFileSync(join(project, pkg.spec.slice('file:./'.length)))).digest('hex') }))
await writeFile(join(root, 'dist/payload/workspace-packages.json'), JSON.stringify(inventory, null, 2) + '\n')
verifyUpstream()

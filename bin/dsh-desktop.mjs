#!/usr/bin/env node
/** User-owned launcher. It never replaces or updates the upstream dsh command. */
import { spawn, execFileSync } from 'node:child_process'
import { readFile, access, rm, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths, releaseId } from '../lib/paths.mjs'
import { parseManifest } from '../lib/manifest.mjs'
import { installArchive, downloadArchive, activeRelease, withLock, verifyPayload, digest } from '../lib/install.mjs'
import { isAlive, ownerCommand } from '../lib/lock.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const p = paths()
const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1]) throw new Error(`Missing value for ${name}`)
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}
async function release() {
  const override = option('--payload')
  if (!override) return activeRelease(p)
  const directory = resolve(override)
  const manifest = parseManifest(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')))
  await verifyPayload(directory, manifest)
  return { directory, manifest }
}
async function run(command, argv, env = process.env) {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  delete clean.NODE_OPTIONS
  delete clean.NODE_PATH
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { env: clean, stdio: 'inherit' })
    child.once('error', reject)
    const signals = ['SIGTERM', 'SIGINT']
    const forward = signal => child.kill(signal)
    const handlers = signals.map(signal => [signal, () => forward(signal)])
    handlers.forEach(([signal, handler]) => process.on(signal, handler))
    child.once('exit', (code, signal) => {
      handlers.forEach(([name, handler]) => process.off(name, handler))
      if (signal) reject(new Error(`Desktop process exited on ${signal}`))
      else { process.exitCode = code; resolveRun() }
    })
  })
}
async function requireClosed() {
  const lock = join(p.dshHome, 'profiles/desktop/linux-desktop-owner.lock')
  let recorded
  try { recorded = Number.parseInt(await readFile(lock, 'utf8'), 10) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!await isAlive(recorded)) return
  const command = await ownerCommand(recorded)
  throw new Error(`Desktop is running (pid ${recorded}${command ? `: ${command.slice(0, 120)}` : ''}). Quit it from the window menu or the tray, then retry. Never delete a live lock.`)
}
async function install() {
  const metadata = option('--manifest')
  const archive = option('--archive')
  const declared = parseManifest(JSON.parse(await readFile(metadata ? resolve(metadata) : join(packageRoot, 'release.json'), 'utf8')))
  if (args.includes('--if-published') && !declared.artifact) return
  // Installing writes a new release directory and switches the active pointer; a running
  // instance keeps using the files it already loaded and picks up the new release on restart.
  const input = archive ? resolve(archive) : await downloadArchive(p, declared)
  // A locally supplied archive is trusted by the user's selection; its own embedded
  // release identity still has to match, and the digest binds the exact bytes installed.
  const manifest = declared.artifact ? declared : { ...declared, artifact: {
    url: 'https://local.invalid/local-archive.tar.gz', sha256: await digest(input), bytes: (await stat(input)).size } }
  const directory = await installArchive(p, input, manifest)
  console.log(`Installed Desktop ${manifest.distributionVersion} / Harness ${manifest.upstreamVersion}\n${directory}`)
  const running = Number.parseInt(await readFile(join(p.dshHome, 'profiles/desktop/linux-desktop-owner.lock'), 'utf8').catch(() => ''), 10)
  if (await isAlive(running)) console.log(`Desktop is running (pid ${running}): close and reopen it to use this release.`)
}
async function doctor() {
  const checks = { platform: process.platform, arch: process.arch, display: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    glibc: process.report.getReport().header.glibcVersionRuntime ?? null, dshHome: p.dshHome, data: p.data, installation: null, warnings: [] }
  try {
    const installed = await release()
    checks.installation = installed.manifest
    const libraries = execFileSync('ldd', [join(installed.directory, 'electron/electron')], { encoding: 'utf8' })
    checks.warnings.push(...libraries.split('\n').filter(line => line.includes('not found')))
  } catch (error) { checks.warnings.push(error.message) }
  try { await access(p.lock); checks.warnings.push(`An installation lock exists: ${p.lock}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!checks.glibc) checks.warnings.push('The first release requires glibc; musl is not qualified.')
  if (!checks.display) checks.warnings.push('No graphical session is available.')
  console.log(JSON.stringify(checks, null, 2))
  if (checks.warnings.length) process.exitCode = 1
}
async function main() {
  const commands = new Set(['install', 'update', 'doctor', 'help', 'plugin', 'cli', 'uninstall'])
  const command = args[0] !== undefined && commands.has(args[0]) ? args.shift() : undefined
  if (command === 'install' || command === 'update') { await install(); return }
  if (command === 'doctor') { await doctor(); return }
  if (args.includes('--help') || command === 'help') {
    console.log('dsh-desktop [DIRECTORY] [--workspace DIRECTORY]\ndsh-desktop install|update [--archive FILE --manifest FILE]\ndsh-desktop doctor\ndsh-desktop plugin list|add|remove ...\ndsh-desktop cli <dsh arguments>\ndsh-desktop uninstall --yes\n\nA DIRECTORY opens or creates its workspace and starts a chat in it.\nDoes not replace dsh. Desktop plugin operations require the app to be fully quit.')
    return
  }
  if (command === 'uninstall') {
    if (!args.includes('--yes')) throw new Error('Use uninstall --yes to remove owned application files. Harness data and profiles will be retained.')
    await requireClosed()
    await withLock(p, async () => {
      const entry = await readFile(p.desktop, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (entry && !entry.includes('X-DSH-Desktop-Owner=dsh-desktop-linux\n')) throw new Error('Desktop entry belongs to another application')
      // Validate ownership metadata before removing the bounded release store.
      await activeRelease(p)
      await rm(p.desktop, { force: true })
      await rm(p.wrapper, { force: true })
      await rm(p.active, { force: true })
      await rm(p.releases, { recursive: true })
    })
    console.log('Application files removed. Chats, credentials, profiles and upstream dsh retained.')
    return
  }
  const selected = await release()
  if (command === undefined && args.includes('--version')) {
    console.log(`dsh-desktop ${selected.manifest.distributionVersion}\nHarness ${selected.manifest.upstreamVersion}\nUpstream ${selected.manifest.upstreamCommit}\nRelease ${releaseId(selected.manifest)}\nPayload ${selected.directory}`)
    return
  }
  if (command === 'plugin' || command === 'cli') {
    if (command === 'plugin' || args[0] === 'plugin') await requireClosed()
    const forwarded = command === 'plugin' ? ['plugin', '--profile', 'desktop', ...args] : args
    await run(join(selected.directory, 'runtime/primary-runtime/dependencies/node/bin/node'),
      ['--expose-internals', join(selected.directory, 'app/lib/cli.js'), ...forwarded])
  } else if (command === undefined) {
    const inline = args.find(argument => argument.startsWith('--workspace='))
    const flagged = option('--workspace') ?? (inline === undefined ? undefined : inline.slice('--workspace='.length))
    args.splice(0, args.length, ...args.filter(argument => argument !== inline))
    const unknown = args.filter(argument => argument.startsWith('-'))
    if (unknown.length > 0) throw new Error(`Unsupported option: ${unknown[0]}. Chromium sandbox bypass flags are not forwarded.`)
    if (args.length > 1) throw new Error('Pass at most one directory to open as a workspace.')
    const directory = flagged ?? args[0]
    const extra = []
    if (directory !== undefined) {
      const expanded = resolve(directory.replace(/^~/u, process.env.HOME ?? ''))
      const info = await stat(expanded).catch(error => {
        throw new Error(`Cannot open ${directory}: ${error.code === 'ENOENT' ? 'no such directory' : error.message}`)
      })
      if (!info.isDirectory()) throw new Error(`Cannot open ${directory}: not a directory`)
      extra.push('--workspace', expanded)
    }
    await run(join(selected.directory, 'electron/electron'), [join(selected.directory, 'app'), ...extra])
  } else throw new Error(`Unknown command: ${command}`)
}
main().catch(error => { console.error(`dsh-desktop: ${error.message}`); process.exitCode = 1 })

/** Assemble an independent carrier from clean upstream exports, without source or bundle patching. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, upstream, lock, verifyUpstream, run } from './upstream.mjs'

const output = join(root, 'dist/payload')
const requireUpstream = createRequire(join(upstream, 'package.json'))
const desktop = join(upstream, 'apps/desktop')
const app = join(output, 'app')
const upstreamPlugin = { name: 'upstream-exports', setup(b) {
  b.onResolve({ filter: /^#upstream\// }, args => ({ path: join(desktop, 'src', args.path.slice('#upstream/'.length)) }))
  b.onResolve({ filter: /^@deepseek-ai\// }, args => {
    if (!args.importer.startsWith(join(root, 'src'))) return
    return { path: args.path, external: true }
  })
} }

verifyUpstream()
try {
  if (!existsSync(join(desktop, 'lib/preload-app.cjs'))) throw new Error('Build the pinned upstream first: npm run build:upstream')
  await mkdir(app, { recursive: true })
  const runtime = join(output, 'dsh')
  await run(process.execPath, [join(root, 'scripts/assemble-runtime.mjs')])
  // App-only native dependencies resolve against the same pinned upstream installation.
  for (const name of ['ws', 'semver', 'zod']) {
    if (!existsSync(join(runtime, 'node_modules', name))) {
      const source = dirname(requireUpstream.resolve(`${name}/package.json`))
      await cp(source, join(runtime, 'node_modules', name), { recursive: true, dereference: true })
    }
  }
  await cp(join(desktop, 'renderer'), join(app, 'renderer'), { recursive: true })
  await mkdir(join(app, 'lib'), { recursive: true })
  for (const entry of await readdir(join(desktop, 'lib'))) {
    if (entry.endsWith('.cjs') || entry === 'welcome' || entry === 'operation-report-worker.js') {
      await cp(join(desktop, 'lib', entry), join(app, 'lib', entry), { recursive: true })
    }
  }
  await cp(join(desktop, 'resources/icon-windows.png'), join(app, 'icon.png'))
  await cp(join(upstream, 'LICENSE'), join(output, 'UPSTREAM-LICENSE'))
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'dsh-desktop-linux-app', version: '0.1.0', type: 'module', main: 'lib/main.js' }, null, 2) + '\n')
  if (!existsSync(join(app, 'node_modules'))) await symlink('../dsh/node_modules', join(app, 'node_modules'))
  const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external',
    plugins: [upstreamPlugin], define: { 'process.env.DSH_CLIENT_VERSION': JSON.stringify(lock.version) }, logLevel: 'info' }
  await build({ ...common, entryPoints: [join(root, 'src/main.mjs')], outfile: join(app, 'lib/main.js') })
  await build({ ...common, entryPoints: [join(root, 'src/cli.mjs')], outfile: join(app, 'lib/cli.js') })
  const electronPackage = requireUpstream.resolve('electron/package.json', { paths: [desktop] })
  if (!existsSync(join(output, 'electron/electron'))) {
    const { downloadArtifact } = await import(pathToFileURL(requireUpstream.resolve('@electron/get', { paths: [desktop] })).href)
    const extractZip = requireUpstream('extract-zip')
    const archive = await downloadArtifact({ version: lock.electron, platform: 'linux', arch: lock.arch, artifactName: 'electron', cacheRoot: join(root, '.cache/electron-downloads') })
    await extractZip(archive, { dir: join(output, 'electron') })
  }
  if (JSON.parse(await readFile(electronPackage, 'utf8')).version !== lock.electron) throw new Error('Electron version differs from lock')
  const tsx = createRequire(join(desktop, 'package.json')).resolve('tsx/esm')
  await run(process.execPath, ['--import', pathToFileURL(tsx).href, join(root, 'scripts/prepare-runtime.mts'), join(output, 'runtime'), runtime])
  await mkdir(join(output, 'runtime/bin'), { recursive: true })
  await writeFile(join(output, 'runtime/bin/node'), '#!/bin/sh\nexec "$(dirname -- "$0")/../primary-runtime/dependencies/node/bin/node" "$@"\n', { mode: 0o755 })
  await writeFile(join(output, 'release.json'), await readFile(join(root, 'release.json')))
  // Release inventory includes exact installed production dependencies and their lockfile.
  console.log(`Independent Linux payload: ${output}`)
} finally { verifyUpstream() }

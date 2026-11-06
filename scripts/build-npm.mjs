/** Build the publishable npm package that installs a hosted release payload. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, verifyUpstream } from './upstream.mjs'
import { parseManifest } from '../lib/manifest.mjs'

const name = process.env.DSH_DESKTOP_NPM_NAME
if (!name || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)) throw new Error('Set DSH_DESKTOP_NPM_NAME to the package name you own (e.g. @you/dsh-desktop-linux)')
const manifest = parseManifest(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
if (!manifest.artifact) throw new Error('release.json has no artifact. Publish the archive and set its URL before building the npm package.')
const out = join(root, 'dist/npm')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const entry of ['bin', 'lib']) await cp(join(root, entry), join(out, entry), { recursive: true })
for (const file of ['README.md', 'LICENSE', 'release.json']) await cp(join(root, file), join(out, file))
await writeFile(join(out, 'package.json'), `${JSON.stringify({
  name,
  version: manifest.distributionVersion,
  description: 'Linux Electron desktop for DeepSeek Harness (community build, unmodified upstream)',
  license: 'MIT',
  type: 'module',
  bin: { 'dsh-desktop': 'bin/dsh-desktop.mjs' },
  files: ['bin', 'lib', 'release.json', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  os: ['linux'],
  cpu: ['x64', 'arm64'],
  dependencies: { tar: '7.5.22' },
  scripts: {
    // Downloads and verifies the hosted payload; a disabled install script leaves
    // `dsh-desktop install` as the explicit path.
    postinstall: 'node bin/dsh-desktop.mjs install --if-published',
  },
}, null, 2)}\n`)
await verifyUpstream()
console.log(`npm package ready: ${out}\nPublish with: npm publish --access public ${out}`)

/** Deterministic release archive: one payload root, recorded digest and byte size. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import * as tar from 'tar'
import { root, verifyUpstream } from './upstream.mjs'
import { parseManifest } from '../lib/manifest.mjs'

const { values } = parseArgs({ options: {
  archive: { type: 'string' }, 'base-url': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('npm run package:release -- --archive /path/to/release.tar.gz --base-url https://host/releases [--output release.json]')
  process.exit(0)
}
const payload = join(root, 'dist/payload')
const manifestPath = values.output ?? join(root, 'release.json')
const manifest = parseManifest(JSON.parse(await readFile(join(payload, 'release.json'), 'utf8')))
const archive = values.archive ?? join(root, 'dist', `dsh-desktop-linux-${manifest.distributionVersion}-${manifest.upstreamCommit.slice(0, 12)}.tar.gz`)
await mkdir(join(archive, '..'), { recursive: true })
try {
  await rm(archive, { force: true })
  await tar.c({ file: archive, cwd: join(payload, '..'), gzip: { level: 6 }, portable: true, noMtime: false }, ['payload'])
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const size = (await stat(archive)).size
  const name = archive.split('/').at(-1)
  const url = values['base-url'] ? `${values['base-url'].replace(/\/$/u, '')}/${name}` : null
  if (values['base-url'] && !url.startsWith('https://')) throw new Error('--base-url must use HTTPS')
  const next = { ...manifest, artifact: url === null ? null : { url, sha256: hash.digest('hex'), bytes: size } }
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  await writeFile(join(payload, 'release.json'), `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Archive: ${archive}\nSHA-256: ${next.artifact?.sha256 ?? 'recorded only in the manifest'}\nBytes: ${size}\nManifest: ${manifestPath}`)
  verifyUpstream()
} catch (error) {
  await rm(archive, { force: true })
  throw error
}

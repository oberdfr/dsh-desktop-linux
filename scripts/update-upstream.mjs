/** Pin a new upstream release: resolve one tag to one commit and record it. */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, lock } from './upstream.mjs'

const tag = process.argv[2]
if (!tag) throw new Error('Usage: update-upstream.mjs <upstream tag, e.g. v0.2.3-rc.1>')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// Resolve the tag remotely so a stale local clone cannot decide what gets built.
const refs = git('ls-remote', '--tags', lock.repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
  .split('\n').filter(Boolean).map(line => line.split('\t'))
const peeled = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`)
const direct = refs.find(([, ref]) => ref === `refs/tags/${tag}`)
const commit = peeled?.[0] ?? direct?.[0]
if (!commit || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`Tag ${tag} does not resolve to one commit`)
if (refs.length > 1 && !peeled) throw new Error(`Tag ${tag} is ambiguous`)

// The Harness version comes from the tagged root manifest, not from the tag spelling.
// `git show` needs the commit locally; fetch just that object when it is missing.
try { git('cat-file', '-e', `${commit}^{commit}`) }
catch {
  git('fetch', '--quiet', '--depth=1', lock.repository, commit)
}
const version = JSON.parse(git('show', `${commit}:package.json`)).versionif (typeof version !== 'string' || version === '') throw new Error(`Commit ${commit} declares no version`)

const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
const [major, minor, patch] = release.distributionVersion.split('.')
const nextRelease = { ...release, distributionVersion: `${major}.${minor}.${Number(patch) + 1}`,
  upstreamVersion: version, upstreamCommit: commit, artifact: null, payloadDigest: undefined }
await writeFile(join(root, 'upstream.lock.json'), `${JSON.stringify({ ...lock, commit, version }, null, 2)}\n`)
await writeFile(join(root, 'release.json'), `${JSON.stringify(nextRelease, null, 2)}\n`)
console.log(`Pinned ${tag} → ${commit} (Harness ${version})`)
console.log(`Distribution ${release.distributionVersion} → ${nextRelease.distributionVersion}`)
console.log('Next: npm run build:upstream && npm run build && npm test && npm run test:gui')

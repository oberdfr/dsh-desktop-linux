import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as tar from 'tar'
import { paths, releaseId } from '../lib/paths.mjs'
import { parseManifest, checkPlatform } from '../lib/manifest.mjs'
import { activeRelease, atomicJson, digest, installArchive, validateArchive, withLock, digestPayload } from '../lib/install.mjs'
import { verifyUpstream } from '../scripts/upstream.mjs'

const baseManifest = () => ({ schemaVersion: 1, distributionVersion: '0.1.0', upstreamVersion: '0.2.2-rc.1',
  upstreamCommit: 'a'.repeat(40), platform: 'linux', arch: 'x64', artifact: null })
async function fixture(t, mutate) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const p = paths({ HOME: root })
  const payload = join(root, 'source/payload')
  for (const name of ['electron/electron', 'app/lib/main.js', 'app/lib/cli.js', 'runtime/primary-runtime/dependencies/node/bin/node', 'app/icon.png']) {
    await mkdir(join(payload, name, '..'), { recursive: true })
    await writeFile(join(payload, name), name, { mode: 0o755 })
  }
  await writeFile(join(payload, 'release.json'), JSON.stringify(baseManifest()))
  await mutate?.(payload)
  const payloadDigest = await digestPayload(payload)
  await writeFile(join(payload, 'release.json'), JSON.stringify({ ...baseManifest(), payloadDigest }))
  const archive = join(root, 'payload.tar.gz')
  await tar.c({ file: archive, cwd: join(root, 'source'), gzip: true, portable: true }, ['payload'])
  const manifest = { ...baseManifest(), payloadDigest, artifact: { url: 'https://example.com/payload.tar.gz', sha256: await digest(archive), bytes: (await stat(archive)).size } }
  return { p, root, payload, archive, manifest }
}

test('keeps profile and install locations independent and respects XDG overrides', () => {
  const p = paths({ HOME: '/home/user', DSH_HOME: '/data/harness', XDG_DATA_HOME: '/data/apps', XDG_CONFIG_HOME: '/config' })
  assert.equal(p.dshHome, '/data/harness')
  assert.equal(p.data, '/data/apps/dsh-desktop-linux')
  assert.equal(p.userData, '/config/dsh-desktop-linux')
  assert.throws(() => paths({ HOME: '/h', XDG_DATA_HOME: 'relative' }), /absolute/)
})
test('rejects invalid release versions, commits, targets and artifact metadata', () => {
  for (const change of [{ distributionVersion: '../escape' }, { upstreamVersion: null }, { upstreamCommit: 'HEAD' },
    { platform: 'win32' }, { arch: 'ia32' }, { artifact: { url: 'http://bad', sha256: '0'.repeat(64), bytes: 1 } },
    { artifact: { url: 'https://user:secret@example.com/a', sha256: '0'.repeat(64), bytes: 1 } },
    { artifact: { url: 'https://example.com/a', sha256: 'x', bytes: 1 } },
    { artifact: { url: 'https://example.com/a', sha256: '0'.repeat(64), bytes: -1 } }]) {
    assert.throws(() => parseManifest({ ...baseManifest(), ...change }))
  }
  assert.equal(parseManifest(baseManifest()).schemaVersion, 1)
  assert.throws(() => checkPlatform(baseManifest(), 'darwin', 'arm64'), /requires/)
})
test('installs and re-installs a verified archive without touching Harness data', async t => {
  const f = await fixture(t)
  await mkdir(f.p.dshHome, { recursive: true })
  await writeFile(join(f.p.dshHome, 'keep'), 'user data')
  const directory = await installArchive(f.p, f.archive, f.manifest)
  assert.equal(directory, join(f.p.releases, releaseId(f.manifest)))
  assert.equal((await activeRelease(f.p)).directory, directory)
  await installArchive(f.p, f.archive, f.manifest)
  assert.equal(await readFile(join(f.p.dshHome, 'keep'), 'utf8'), 'user data')
  assert.match(await readFile(f.p.desktop, 'utf8'), /X-DSH-Desktop-Owner=dsh-desktop-linux/)
  assert.doesNotMatch(await readFile(f.p.wrapper, 'utf8'), /--no-sandbox/)
  await assert.rejects(access(f.p.lock), { code: 'ENOENT' })
})
test('rejects a payload whose content differs from the declared digest', async t => {
  const f = await fixture(t)
  await assert.rejects(installArchive(f.p, f.archive, { ...f.manifest, payloadDigest: 'b'.repeat(64) }), /content digest/)
  await assert.rejects(access(f.p.active), { code: 'ENOENT' })
})
test('a rebuilt release with new content activates a new directory and keeps the previous one', async t => {
  const f = await fixture(t)
  const first = await installArchive(f.p, f.archive, f.manifest)
  // Same version and commit, different bytes: the identity must change with the content.
  await writeFile(join(f.payload, 'app/lib/main.js'), 'rebuilt')
  const second = { ...f.manifest }
  second.payloadDigest = await digestPayload(f.payload)
  await writeFile(join(f.payload, 'release.json'), JSON.stringify({ ...baseManifest(), payloadDigest: second.payloadDigest }))
  const rebuiltArchive = join(f.root, 'rebuilt.tar.gz')
  await tar.c({ file: rebuiltArchive, cwd: join(f.root, 'source'), gzip: true, portable: true }, ['payload'])
  second.artifact = { url: 'https://example.com/rebuilt.tar.gz', sha256: await digest(rebuiltArchive), bytes: (await stat(rebuiltArchive)).size }
  const active = await installArchive(f.p, rebuiltArchive, second)
  assert.notEqual(active, first)
  assert.equal((await activeRelease(f.p)).directory, active)
  await access(first)
  assert.equal(await readFile(join(active, 'app/lib/main.js'), 'utf8'), 'rebuilt')
})
test('corrupt archives leave the active installation unchanged', async t => {
  const f = await fixture(t)
  await installArchive(f.p, f.archive, f.manifest)
  const before = await readFile(f.p.active, 'utf8')
  await assert.rejects(installArchive(f.p, f.archive, { ...f.manifest, artifact: { ...f.manifest.artifact, sha256: '0'.repeat(64) } }), /integrity/)
  assert.equal(await readFile(f.p.active, 'utf8'), before)
})
test('rejects payload identity mismatches before activation', async t => {
  const f = await fixture(t)
  await assert.rejects(installArchive(f.p, f.archive, { ...f.manifest, upstreamCommit: 'b'.repeat(40) }), /mismatch/)
  await assert.rejects(access(f.p.active), { code: 'ENOENT' })
})
test('rejects archive links escaping the payload', async t => {
  const f = await fixture(t, payload => symlink('/etc/passwd', join(payload, 'escape')))
  await assert.rejects(validateArchive(f.archive), /link/)
  await assert.rejects(access(f.p.active), { code: 'ENOENT' })
})
test('retains contained relative symbolic links', async t => {
  const f = await fixture(t, payload => symlink('main.js', join(payload, 'app/lib/alias.js')))
  await installArchive(f.p, f.archive, f.manifest)
  const selected = await activeRelease(f.p)
  assert.equal(await readFile(join(selected.directory, 'app/lib/alias.js'), 'utf8'), 'app/lib/main.js')
})
test('does not overwrite a desktop entry belonging to another application', async t => {
  const f = await fixture(t)
  await mkdir(f.p.applications, { recursive: true })
  await writeFile(f.p.desktop, 'unrelated application')
  await assert.rejects(installArchive(f.p, f.archive, f.manifest), /not owned/)
  assert.equal(await readFile(f.p.desktop, 'utf8'), 'unrelated application')
  await assert.rejects(access(f.p.active), { code: 'ENOENT' })
})
test('serializes installation operations and releases the lock after failure', async t => {
  const { p } = await fixture(t)
  await withLock(p, async () => {
    await assert.rejects(withLock(p, async () => {}), /Another running process/)
  })
  await assert.rejects(withLock(p, async () => { throw new Error('failed operation') }), /failed operation/)
  await withLock(p, async () => {})
})
test('reclaims a lock left by a dead process and keeps one held by a live process', async t => {
  const { p } = await fixture(t)
  await mkdir(p.data, { recursive: true })
  await writeFile(p.lock, '999999999\n')
  await withLock(p, async () => {})
  await writeFile(p.lock, `${process.pid}\n`)
  await assert.rejects(withLock(p, async () => {}), /Another running process/)
  await rm(p.lock)
  await writeFile(p.lock, 'not a pid\n')
  await assert.rejects(withLock(p, async () => {}), /Another running process/)
})
test('refuses an installation directory replaced by a symlink', async t => {
  const { p, root } = await fixture(t)
  await mkdir(join(p.data, '..'), { recursive: true })
  const other = join(root, 'other')
  await mkdir(other)
  await symlink(other, p.data)
  await assert.rejects(withLock(p, async () => {}), /symlink/)
})
test('rejects a forged active release path', async t => {
  const f = await fixture(t)
  await mkdir(f.p.data, { recursive: true })
  await atomicJson(f.p.active, { id: '../outside', manifest: f.manifest })
  await assert.rejects(activeRelease(f.p), /reference/)
})
test('the upstream gate rejects changed tracked files and the wrong commit', async t => {
  const { root } = await fixture(t)
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-q', dir])
  await writeFile(join(dir, 'source'), 'original')
  execFileSync('git', ['-C', dir, 'add', 'source'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(verifyUpstream(dir, commit), commit)
  assert.throws(() => verifyUpstream(dir, '0'.repeat(40)), /commit/)
  await writeFile(join(dir, 'source'), 'changed')
  assert.throws(() => verifyUpstream(dir, commit), /tracked files/)
})

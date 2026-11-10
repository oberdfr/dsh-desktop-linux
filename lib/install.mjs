/** Verified, staged payload installation. No user profiles are modified. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { acquireLock } from './lock.mjs'
import { parseManifest, checkPlatform } from './manifest.mjs'
import { releaseId } from './paths.mjs'

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export async function withLock(p, operation) {
  await mkdir(p.data, { recursive: true, mode: 0o700 })
  const info = await lstat(p.data)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installation directory must not be a symlink')
  let file
  try { file = await acquireLock(p.lock) }
  catch (error) { throw new Error(`${error.message}. Run dsh-desktop doctor before recovery.`) }
  try { return await operation() } finally { await file.close(); await rm(p.lock, { force: true }) }
}

function safeName(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || isAbsolute(name)
    || name.split('/').includes('..') || !/^payload(?:\/|$)/u.test(name)) throw new Error(`Unsafe archive entry: ${name}`)
  return posix.normalize(name).replace(/\/$/u, '')
}

export async function validateArchive(file) {
  const links = []
  const names = new Set()
  let count = 0
  let bytes = 0
  let failure
  await tar.t({ file, strict: true, onReadEntry(entry) {
    if (failure) return
    try {
    const name = safeName(entry.path)
    if (++count > 300000 || (bytes += entry.size) > 8 * 1024 ** 3) throw new Error('Archive exceeds installation limits')
    if (names.has(name)) throw new Error(`Duplicate archive entry: ${name}`)
    names.add(name)
    if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error(`Unsupported archive type: ${entry.type}`)
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      if (isAbsolute(entry.linkpath) || entry.linkpath.includes('\\')) throw new Error('Absolute archive link')
      const target = posix.resolve('/', entry.type === 'Link' ? '' : posix.dirname(name), entry.linkpath)
      if (!target.startsWith('/payload/')) throw new Error('Archive link escapes payload')
      links.push(name)
    }
    } catch (error) { failure = error }
  } })
  if (failure) throw failure
  for (const link of links) for (const name of names) if (name.startsWith(`${link}/`)) throw new Error('Archive writes through a link')
  return bytes
}

export async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Hash the payload inventory: sorted relative paths, sizes and file digests.
 * `release.json` is excluded because it carries the result.
 * @param directory - Installed or staged payload root.
 * @returns Lowercase SHA-256 of the complete content.
 */
export async function digestPayload(directory) {
  const entries = []
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && relative(directory, path) !== 'release.json') entries.push(path)
    }
  }
  await visit(directory)
  entries.sort((a, b) => relative(directory, a) < relative(directory, b) ? -1 : 1)
  const hash = createHash('sha256')
  for (const path of entries) {
    const info = await stat(path)
    hash.update(`${relative(directory, path)}\0${info.size}\0`)
    for await (const chunk of createReadStream(path)) hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function verifyPayload(directory, manifest, options = {}) {
  const embedded = parseManifest(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')))
  for (const field of ['distributionVersion', 'upstreamVersion', 'upstreamCommit', 'platform', 'arch']) {
    if (embedded[field] !== manifest[field]) throw new Error(`Payload release mismatch: ${field}`)
  }
  if (manifest.payloadDigest !== undefined && embedded.payloadDigest !== manifest.payloadDigest) {
    throw new Error('Payload content digest does not match the release metadata')
  }
  const root = await realpath(directory)
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Payload link escapes release: ${await readlink(path)}`)
      } else if (entry.isDirectory()) await visit(path)
      else if (!entry.isFile()) throw new Error('Payload contains a special file')
    }
  }
  await visit(directory)
  for (const name of ['electron/electron', 'app/lib/main.js', 'runtime/primary-runtime/dependencies/node/bin/node', 'app/lib/cli.js']) {
    if (!(await stat(join(directory, name))).isFile()) throw new Error(`Payload file missing: ${name}`)
  }
  // Content hashing is an install-time check; launches rely on the recorded digest.
  if (options.content === true && manifest.payloadDigest !== undefined) {
    if (await digestPayload(directory) !== manifest.payloadDigest) throw new Error('Payload content digest verification failed')
  }
}

export async function activeRelease(p) {
  const value = JSON.parse(await readFile(p.active, 'utf8'))
  const manifest = parseManifest(value.manifest)
  if (value.id !== releaseId(manifest)) throw new Error('Invalid active release reference')
  const directory = join(p.releases, value.id)
  const actual = await realpath(directory)
  if (relative(await realpath(p.releases), actual) !== value.id) throw new Error('Active release escapes installation')
  return { directory, manifest }
}

export async function integrate(p, directory) {
  await mkdir(p.applications, { recursive: true })
  // Only this owned wrapper is changed. Never write a dsh command or shell startup file.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(p.wrapper, `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH\nexec ${quote(join(directory, 'electron/electron'))} ${quote(join(directory, 'app'))} "$@"\n`, { mode: 0o755 })
  await chmod(p.wrapper, 0o755)
  const exec = `"${p.wrapper.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`
  const content = `[Desktop Entry]\nType=Application\nName=DeepSeek Harness (community Linux)\nExec=${exec}\nIcon=${join(directory, 'app/icon.png')}\nStartupWMClass=dsh-desktop-linux\nTerminal=false\nCategories=Development;\nX-DSH-Desktop-Owner=dsh-desktop-linux\n`
  try {
    const previous = await readFile(p.desktop, 'utf8')
    if (!previous.includes('X-DSH-Desktop-Owner=dsh-desktop-linux\n')) throw new Error('Existing desktop entry is not owned by this application')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(p.desktop, content, { mode: 0o644 })
}

export async function installArchive(p, input, rawManifest) {
  const manifest = parseManifest(rawManifest)
  checkPlatform(manifest)
  if (!manifest.artifact) throw new Error('This development package has no published binary. Build or provide a release archive first.')
  return withLock(p, async () => {
    const metadata = await stat(input)
    if (metadata.size !== manifest.artifact.bytes || await digest(input) !== manifest.artifact.sha256) throw new Error('Archive integrity verification failed')
    const unpackedBytes = await validateArchive(input)
    await mkdir(p.releases, { recursive: true, mode: 0o700 })
    const space = await statfs(p.releases)
    if (space.bavail * space.bsize < unpackedBytes + metadata.size) throw new Error('Insufficient free space for staged installation')
    const stage = join(p.releases, `.stage-${randomUUID()}`)
    const destination = join(p.releases, releaseId(manifest))
    const previous = await readFile(p.active, 'utf8').then(JSON.parse).then(value => value.id).catch(() => undefined)
    await mkdir(stage, { mode: 0o700 })
    try {
      await tar.x({ file: input, cwd: stage, strict: true, preserveOwner: false, noChmod: true })
      const payload = join(stage, 'payload')
      // The archived content must hash to the digest the release metadata names.
      await verifyPayload(payload, manifest, { content: true })
      try { await access(destination); await verifyPayload(destination, manifest) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        await rename(payload, destination)
      }
      await integrate(p, destination)
      await atomicJson(p.active, { id: releaseId(manifest), manifest })
      // Retain the previously active release for rollback; remove other stale payloads.
      for (const entry of await readdir(p.releases)) {
        if (entry.startsWith('.') || entry === releaseId(manifest) || entry === previous) continue
        await rm(join(p.releases, entry), { recursive: true, force: true })
      }
      return destination
    } finally { await rm(stage, { recursive: true, force: true }) }
  })
}

export async function downloadArchive(p, manifest) {
  parseManifest(manifest)
  if (!manifest.artifact) throw new Error('No binary release configured')
  await mkdir(p.cache, { recursive: true, mode: 0o700 })
  const file = join(p.cache, `${manifest.artifact.sha256}.tar.gz`)
  try { if (await digest(file) === manifest.artifact.sha256) return file }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${file}.${randomUUID()}`
  try {
    // GitHub release assets answer with a redirect to a signed HTTPS URL; the digest and size
    // checks below authenticate the bytes, so following redirects is safe here.
    const response = await fetch(manifest.artifact.url, { signal: AbortSignal.timeout(300000) })
    if (!response.ok || !response.body) throw new Error(`Binary download failed: HTTP ${response.status}`)
    if (new URL(response.url).protocol !== 'https:') throw new Error('Binary download left HTTPS')
    const total = Number(response.headers.get('content-length') ?? manifest.artifact.bytes)
    const shown = process.stderr.isTTY === true
    let received = 0
    let lastReport = 0
    const report = () => {
      if (!shown) return
      const now = Date.now()
      if (now - lastReport < 500 && received < total) return
      lastReport = now
      const percent = total > 0 ? Math.floor((received / total) * 100) : 0
      process.stderr.write(`\rdsh-desktop: downloading ${percent}% (${Math.floor(received / 1048576)}/${Math.ceil(total / 1048576)} MiB)`)
    }
    async function* limit(stream) {
      for await (const chunk of stream) {
        received += chunk.byteLength
        if (received > manifest.artifact.bytes) throw new Error('Download exceeds declared size')
        report()
        yield chunk
      }
    }
    try {
      await pipeline(limit(Readable.fromWeb(response.body)), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    } finally { if (shown) process.stderr.write('\n') }
    if (received !== manifest.artifact.bytes || await digest(temporary) !== manifest.artifact.sha256) throw new Error('Downloaded archive integrity mismatch')
    await rename(temporary, file)
    return file
  } finally { await rm(temporary, { force: true }) }
}

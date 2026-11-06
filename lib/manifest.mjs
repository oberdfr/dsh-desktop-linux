/** Validate durable and remote release metadata before it selects executable files. */
export function parseManifest(value) {
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1
    || !version.test(value.distributionVersion) || !version.test(value.upstreamVersion)
    || !/^[a-f0-9]{40}$/u.test(value.upstreamCommit)
    || value.platform !== 'linux' || !['x64', 'arm64'].includes(value.arch)) throw new Error('Invalid Linux release metadata')
  if (value.payloadDigest !== undefined && !/^[a-f0-9]{64}$/u.test(value.payloadDigest)) throw new Error('Invalid payload digest')
  if (value.artifact !== null) {
    const a = value.artifact
    if (!a || !/^[a-f0-9]{64}$/u.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes <= 0
      || a.bytes > 4 * 1024 ** 3) throw new Error('Invalid archive digest or size')
    const url = new URL(a.url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Artifact URL must use HTTPS without credentials')
  }
  return value
}

export function checkPlatform(manifest, platform = process.platform, arch = process.arch) {
  if (platform !== manifest.platform || arch !== manifest.arch) throw new Error(`This release requires ${manifest.platform}/${manifest.arch}; found ${platform}/${arch}`)
}

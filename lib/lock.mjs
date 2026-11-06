/** PID-recorded lock files: an interrupted owner is reclaimable, a live one is not. */
import { open, readFile, rm } from 'node:fs/promises'

/**
 * Read a process command line for lock diagnostics.
 * @param pid - Candidate owner.
 * @returns Space-joined argv, or `undefined` when it cannot be read.
 */
export async function ownerCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter(Boolean).join(' ')
  } catch {
    // A non-Linux or restricted host exposes no command line; the owner still holds the lock.
    return undefined
  }
}

/**
 * Whether the recorded owner still exists.
 * A recycled PID keeps the lock held: the message names the process so a human can decide.
 * @param pid - Recorded process id.
 * @returns `false` only when the process is provably gone; unknown errors keep it held.
 */
export async function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/**
 * Create a lock, reclaiming only a lock whose recorded owner is gone.
 * An unreadable or malformed record stays held: guessing could corrupt another instance.
 * @param path - Lock file path outside any user data.
 * @returns The open descriptor the caller must close, which releases ownership.
 */
export async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`)
      return handle
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const recorded = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10)
      if (await isAlive(recorded)) throw new Error(`Another running process (${recorded > 0 ? recorded : 'unknown'}) owns ${path}`)
      await rm(path)
    }
  }
  throw new Error(`Could not acquire ${path}`)
}

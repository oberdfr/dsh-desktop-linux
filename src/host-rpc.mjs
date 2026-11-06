/** Minimal authenticated Host RPC used by the carrier's own startup actions. */
import { randomUUID } from 'node:crypto'

/**
 * Call one Host remote method with the desktop cookie.
 * @param origin - Host origin.
 * @param cookie - Host authentication cookie.
 * @param namespace - Remote namespace, e.g. `workspace`.
 * @param method - Remote method name.
 * @param args - Method arguments.
 * @returns The Remote result value.
 */
export function createHostClient(origin, cookie) {
  const invoke = async (namespace, method, args = {}) => {
    const rpcId = randomUUID()
    const name = `${namespace}/${method}`
    const response = await fetch(new URL(`/api/${name}`, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: name, payload: { args } }),
    })
    if (!response.ok) throw new Error(`Host ${name} failed with HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`Host ${name} returned an invalid response`)
    if (envelope.result?.ok !== true) throw new Error(`Host ${name} failed: ${envelope.result?.error?.message ?? 'unknown error'}`)
    return envelope.result.value
  }
  return { invoke }
}

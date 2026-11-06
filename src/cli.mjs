/** The unmodified upstream Desktop CLI owns profile writes and plugin compatibility. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
const payload = fileURLToPath(new URL('../../', import.meta.url))
const runtime = join(payload, 'dsh')
const entry = join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const { runDesktopCli } = await import(pathToFileURL(entry).href)
await runDesktopCli(runtime, join(payload, 'runtime'))

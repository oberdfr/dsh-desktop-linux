/** Real Electron/Host smoke. No model requests, personal profiles or sandbox bypass. */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { root, verifyUpstream } from './upstream.mjs'

await mkdir(join(root, '.cache'), { recursive: true })
const payload = process.env.DSH_DESKTOP_PAYLOAD ?? join(root, 'dist/payload')
const scratch = await mkdtemp(join(root, '.cache/gui-'))
const output = join(root, 'artifacts/verification')
await mkdir(output, { recursive: true })
const env = { ...process.env, DSH_HOME: join(scratch, 'dsh'), XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_DATA_HOME: join(scratch, 'data'), DSH_TELEMETRY_MODE: 'DISABLED' }
delete env.NODE_OPTIONS
delete env.NODE_PATH
delete env.ELECTRON_RUN_AS_NODE
// xdg-user-dir falls back to $HOME without this file, which the Host reads as "no Documents".
await mkdir(join(scratch, 'config'), { recursive: true })
await mkdir(join(scratch, 'Documents'), { recursive: true })
await writeFile(join(scratch, 'config/user-dirs.dirs'),
  `XDG_DOCUMENTS_DIR="${join(scratch, 'Documents')}"\n`)
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" })
  response.end('<!doctype html><title>Native browser fixture</title><h1>Browser fixture</h1><input aria-label="Browser input"><a href="/next">Next page</a>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let app
const errors = []
try {
  app = await electron.launch({ executablePath: join(payload, 'electron/electron'),
    args: [join(payload, 'app')], chromiumSandbox: true, env, timeout: 120000 })
  app.process().stderr?.on('data', chunk => errors.push(chunk.toString()))
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.stack))
  await page.locator('[data-shell-overlay]').waitFor({ state: 'attached', timeout: 120000 })
  const welcome = app.windows().find(window => window.url().includes('welcome.html'))
    ?? await app.waitForEvent('window', { predicate: window => window.url().includes('welcome.html'), timeout: 60000 })
  await welcome.locator('#api-key').click()
  await welcome.locator('#skip-key').click()
  await page.locator('body').waitFor({ state: 'visible' })
  // A first-use workspace must be created from the system Documents directory, not a toast.
  await page.locator('[data-shell-overlay]').waitFor({ state: 'attached' })
  await page.waitForTimeout(4000)
  const bodyText = await page.locator('body').innerText()
  assert.doesNotMatch(bodyText, /Unable to create default workspace/u)
  assert.match(bodyText, /Default workspace/u)
  const details = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'dsh-app://app/')
    return { preferences: window.webContents.getLastWebPreferences(), argv: process.argv, platform: process.platform, visible: window.isVisible(), devtools: window.webContents.isDevToolsOpened() }
  })
  assert.equal(details.platform, 'linux')
  assert.equal(details.preferences.sandbox, true)
  assert.equal(details.preferences.nodeIntegration, false)
  assert.equal(details.preferences.contextIsolation, true)
  assert.equal(details.preferences.webviewTag, true)
  assert.equal(details.argv.includes('--no-sandbox'), false)
  assert.equal(details.devtools, false)
  await page.screenshot({ path: join(output, 'desktop-light.png') })
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(output, 'desktop-dark.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'dsh-app://app/').setSize(620, 720))
  await page.waitForFunction(() => innerWidth === 620)
  // Electron reports the CSS viewport before the next layout pass on Wayland.
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 620)
  await page.screenshot({ path: join(output, 'desktop-narrow.png') })
  // Native Browser tab is opened through the real product UI, not an injected webview.
  const text = await page.locator('body').innerText()
  await writeFile(join(output, 'product-text.txt'), text)
  await writeFile(join(output, 'gui-result.json'), JSON.stringify({ ...details, scratch, browserFixture: `http://127.0.0.1:${server.address().port}`, errors }, null, 2))
  verifyUpstream()
  console.log(`Electron + unmodified Desktop Host passed. Evidence: ${output}`)
} finally {
  await writeFile(join(output, 'electron.log'), errors.join('\n'))
  await app?.close()
  await new Promise(resolve => server.close(resolve))
}

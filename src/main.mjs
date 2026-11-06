/** Linux composition root. Every imported upstream component is built without modification. */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, Tray, nativeImage, powerMonitor } from 'electron'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acquireLock } from '../lib/lock.mjs'
import { DesktopProjectManager } from '#upstream/project-manager.ts'
import { DesktopHostProcess } from '#upstream/host-process.ts'
import { resolveDesktopPaths } from '#upstream/paths.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender } from '#upstream/ipc.ts'
import { authenticateWebHost, forwardWebRequest, removeLegacyHostCookies, serveWebDocument } from '#upstream/web-document.ts'
import { DesktopBrowserGuests } from '#upstream/browser-guests.ts'
import { installDesktopDirectoryPicker } from '#upstream/directory-picker.ts'
import { installMicrophonePermissions } from '#upstream/microphone-permissions.ts'
import { installFileActions } from '#upstream/file-actions.ts'
import { installDesktopFileDrag } from '#upstream/file-drag.ts'
import { installDesktopShortcuts } from '#upstream/keyboard.ts'
import { DesktopQuitConfirmation } from '#upstream/quit-confirmation.ts'
import { resolveDesktopLocale, resolveDesktopStartupLocale } from '#upstream/locale.ts'
import { desktopClientMetadata } from '#upstream/client-metadata.ts'
import { connectDesktopWelcome } from '#upstream/welcome-backend.ts'
import { openWelcomeWindow } from '#upstream/welcome-window.ts'
import { needsWelcome } from '#upstream/welcome-api.ts'
import { PLATFORM_IPC } from '#upstream/platform-ipc.ts'
import { readDeviceInfo } from '#upstream/device-info.ts'
import { paths } from '../lib/paths.mjs'

const p = paths()
const payload = resolve(app.getAppPath(), '..')
const runtime = join(payload, 'dsh')
const support = join(payload, 'runtime')
const node = join(support, 'primary-runtime/dependencies/node/bin/node')
const icon = join(app.getAppPath(), 'icon.png')
app.setName('DeepSeek Harness (community Linux)')
app.setPath('userData', p.userData)
app.setAppLogsPath()
// Rootless installs use Chromium's namespace sandbox, not a root-owned setuid helper.
app.commandLine.appendSwitch('disable-setuid-sandbox')
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])

async function start() {
  let window, welcomeWindow, host, welcome, shortcuts, tray, removeDrag, cookie, hostUrl
  let quitting = false, shutdown, entered = false, ready, inspection, ownerLock
  let locale = resolveDesktopLocale(app.getLocale())
  const m = () => locale.messages
  const productUrl = `${SCHEME}://app/`
  const guests = new DesktopBrowserGuests(() => hostUrl)
  const focus = () => {
    const target = welcomeWindow && !welcomeWindow.isDestroyed() ? welcomeWindow : window
    if (!target || target.isDestroyed()) return
    if (target.isMinimized()) target.restore()
    target.show(); target.focus()
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', focus)
  app.on('activate', focus)
  await app.whenReady()
  // A shared profile must not be opened by different installation paths at once.
  const profile = resolveDesktopPaths(p.dshHome)
  await mkdir(profile.profile, { recursive: true, mode: 0o700 })
  const lockFile = join(profile.profile, 'linux-desktop-owner.lock')
  ownerLock = await acquireLock(lockFile).catch(error => { throw new Error(`${error.message}. Desktop holds the reserved profile; close the other instance before retrying.`) })
  const authorized = event => {
    assertDesktopSender(event, ['app'])
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Rejected command from a non-product frame')
    return window
  }
  const manager = new DesktopProjectManager(profile, { dsh: runtime })
  await manager.applyRelease()

  const fatal = async error => {
    console.error(error)
    const report = join(app.getPath('logs'), `failure-${Date.now()}.log`)
    await mkdir(app.getPath('logs'), { recursive: true })
    await writeFile(report, `WARNING: diagnostics may include sensitive plugin data. Review before sharing.\n${error.stack || error}\n`, { mode: 0o600 })
    await dialog.showMessageBox({ type: 'error', title: m().aboutProduct,
      message: 'Desktop could not complete the operation.', detail: `Diagnostic report: ${report}` })
    await stop()
  }
  const stop = async () => {
    if (shutdown) return shutdown
    quitting = true
    shutdown = (async () => {
      tray?.destroy()
      shortcuts?.dispose()
      if (window && !window.isDestroyed()) window.hide()
      welcomeWindow?.hide()
      await removeDrag?.()
      if (host) await host.stop()
      await ownerLock?.close()
      await rm(lockFile)
      app.quit()
    })().catch(error => { console.error('Desktop shutdown failed; profile lock retained:', error); app.exit(1) })
    return shutdown
  }
  inspection = new DesktopQuitConfirmation({ locale: () => locale, inspect: () => host?.inspectQuit(),
    show: options => dialog.showMessageBox(options), focus })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    void inspection.confirm().then(approved => approved && stop()).catch(error => { console.error(error); focus() })
  })
  powerMonitor.on('shutdown', () => { void stop() })
  const checkUpdates = async () => {
    // An unpublished package must not claim to be current or contact the official update feeds.
    await dialog.showMessageBox(window, { type: 'info', title: m().updateCheckTitle,
      message: 'Community Linux updates', detail: 'No public release channel is configured. Update this installation with its original dsh-desktop npm package; the upstream dsh installation is not changed.' })
  }
  const menu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: m().application, submenu: [
      { label: m().aboutMenu, role: 'about' },
      { label: m().checkUpdatesMenu, click: () => { void checkUpdates() } },
      { type: 'separator' },
      { label: m().toggleDevToolsMenu, role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
      { role: 'toggleDevTools', accelerator: 'F12', visible: false },
      { type: 'separator' }, { label: m().quitApplication, role: 'quit' },
    ] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  shortcuts = installDesktopShortcuts(() => window, p.userData, 'linux', menu, () => ({ revision: 0, blocked: false }))
  menu()
  app.setAboutPanelOptions({ applicationName: 'DeepSeek Harness — community Linux', applicationVersion: app.getVersion(), iconPath: icon })
  protocol.handle(SCHEME, request => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveWebDocument(request, join(app.getAppPath(), url.pathname === '/design-platform.css' ? 'lib/welcome' : 'renderer'))
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
      || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
      return serveWebDocument(request, join(runtime, 'node_modules/@deepseek-ai/dsh-web-frontend/dist'))
    }
    return hostUrl && cookie ? forwardWebRequest(request, hostUrl, cookie) : new Response(null, { status: 503 })
  })
  installDesktopDirectoryPicker(() => window)
  installMicrophonePermissions(session.defaultSession, () => window?.webContents)
  installFileActions(authorized, () => hostUrl)
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*', 'wss://127.0.0.1/*'] }, (details, callback) => {
    if (!hostUrl || !cookie || details.webContentsId !== window?.webContents.id) { callback({}); return }
    const target = new URL(hostUrl), request = new URL(details.url)
    if (target.host !== request.host || request.protocol !== (target.protocol === 'https:' ? 'wss:' : 'ws:')) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([key, value]) => [key.toLowerCase(), value]))
    if (headers.origin !== productUrl.slice(0, -1)) { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie, 'sec-fetch-site': 'same-origin' } })
  })
  ipcMain.handle(DESKTOP_IPC.boot, async event => { authorized(event); await ready; return { injections: hostReady.injections, streamBaseUrl: new URL(hostUrl).origin } })
  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, text) => { authorized(event); if (typeof text === 'string') void fatal(new Error(text.slice(0, 65536))) })
  ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace) => { authorized(event); return guests.acquire(event.sender, workspace) })
  ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => { authorized(event); return guests.release(event.sender, lease) })
  ipcMain.handle(DESKTOP_IPC.deviceInfo, event => { authorized(event); return readDeviceInfo() })
  ipcMain.handle(DESKTOP_IPC.onboardingApiKey, async event => { authorized(event); await ready; return (await welcome.read()).hasApiKey })
  ipcMain.on(DESKTOP_IPC.onboardingActive, (event, active) => { authorized(event); if (typeof active === 'boolean') window.setMinimumSize(active ? 960 : 520, 600) })
  ipcMain.handle(DESKTOP_IPC.localeBootstrap, async event => { authorized(event); await ready; return { languages: app.getPreferredSystemLanguages(), preference: await welcome.readLocalePreference() } })
  ipcMain.on(DESKTOP_IPC.localeChanged, (event, value) => { authorized(event); if (typeof value === 'string') { locale = resolveDesktopStartupLocale(value, app.getPreferredSystemLanguages()); menu() } })
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source) => { authorized(event); if (['light', 'dark', 'system'].includes(source)) nativeTheme.themeSource = source })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, event => { authorized(event); return { phase: 'idle' } })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, event => { authorized(event); return checkUpdates() })
  ipcMain.handle(DESKTOP_IPC.updatesChannelGet, event => { authorized(event); return { channel: 'stable', packagedChannel: 'stable', changing: false } })
  ipcMain.handle(DESKTOP_IPC.updatesChannelSet, event => { authorized(event); throw new Error('No community Linux update channel is configured') })
  // Upstream Platform view metadata only declares macOS/Windows. Never impersonate either platform.
  ipcMain.on(PLATFORM_IPC.bootstrap, event => { event.returnValue = null })
  ipcMain.handle(PLATFORM_IPC.open, event => { authorized(event); throw new Error('Embedded account pages require an upstream Linux Platform identifier; use the external account website') })
  ipcMain.handle(PLATFORM_IPC.bounds, event => { authorized(event) })
  ipcMain.handle(PLATFORM_IPC.close, event => { authorized(event) })

  window = new BrowserWindow({ width: 1280, height: 820, minWidth: 520, minHeight: 600, show: false, icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
    webPreferences: { preload: join(app.getAppPath(), 'lib/preload-app.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: true } })
  shortcuts.attach(window)
  guests.bind(window, (guest, name) => shortcuts.attachGuest(window, guest, name))
  window.webContents.setWindowOpenHandler(({ url }) => { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== new URL(productUrl).origin) event.preventDefault() })
  window.webContents.on('render-process-gone', (_event, detail) => { if (!quitting && detail.reason !== 'clean-exit') void fatal(new Error(`Renderer exited: ${detail.reason}`)) })
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  window.webContents.on('did-finish-load', () => {
    void window.webContents.insertCSS("html[data-platform='linux'] { --dsh-font-family-text-default: 'Noto Sans', sans-serif; --dsh-font-family-code-default: 'Liberation Mono', monospace; }")
  })
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }))
    tray.setToolTip(app.name)
    tray.setContextMenu(Menu.buildFromTemplate([{ label: m().openApplication, click: focus }, { label: m().quitApplication, role: 'quit' }]))
    tray.on('click', focus)
  } catch (error) { console.warn('Tray unavailable; relaunch dsh-desktop to restore the existing window.', error.message) }

  host = new DesktopHostProcess(node, runtime, profile.profile, undefined, process.env,
    error => { if (!quitting) void fatal(error) }, join(support, 'primary-runtime'),
    { pnpm: join(support, 'primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), nodeBin: join(support, 'bin') })
  removeDrag = installDesktopFileDrag(authorized, (address, signal) => host.resolveDragResource(address, signal))
  let hostReady
  ready = (async () => {
    hostReady = await host.start()
    if (!hostReady.injections) throw new Error('Host did not provide boot injections')
    hostUrl = hostReady.url
    await removeLegacyHostCookies(session.defaultSession.cookies, hostUrl)
    cookie = await authenticateWebHost(hostUrl)
    welcome = connectDesktopWelcome(hostUrl, cookie)
  })()
  await window.loadURL(productUrl)
  await ready
  const enter = async () => {
    entered = true
    window.show()
    if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close()
    welcomeWindow = undefined
    window.webContents.send(DESKTOP_IPC.enterWorkspace)
  }
  const state = await welcome.read()
  if (needsWelcome(state)) {
    welcomeWindow = await openWelcomeWindow(locale, {
      analytics: async () => {}, analyticsEnabled: async () => false, takeNotice: async () => undefined,
      startSignIn: () => welcome.account.start(desktopClientMetadata(locale.id)),
      cancelSignIn: id => welcome.account.cancel(id),
      copySignInLink: async id => {
        const state = await welcome.account.state()
        if (state.attempt?.id !== id || !state.attempt.authorizeUrl) throw new Error('Sign-in link unavailable')
        clipboard.writeText(state.attempt.authorizeUrl)
      },
      saveApiKey: async key => { const result = await welcome.save(key); if (result.ok) await enter(); return result }, skip: enter,
    })
    welcomeWindow.on('closed', () => { welcomeWindow = undefined; if (!entered) app.quit() })
  } else await enter()
}

start().catch(async error => {
  console.error(error)
  await app.whenReady()
  dialog.showErrorBox('DeepSeek Harness — community Linux', error.message)
  app.exit(1)
})

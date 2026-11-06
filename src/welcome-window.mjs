/** Welcome window with the Linux caption and opaque palette; upstream IPC contract preserved. */
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { welcomeWindowOptions } from '#upstream/welcome-window.ts'
import { WELCOME_IPC } from '#upstream/welcome-api.ts'

const LIGHT = '#f9fafb'
const DARK = '#18191c'

/**
 * Build the Linux welcome window options: opaque light/dark background and the integrated caption,
 * matching the shared Desktop layout instead of the transparent macOS material.
 * @param locale - shell-owned localized copy.
 * @returns window options for a fixed-size welcome window.
 */
export function linuxWelcomeOptions(locale) {
  const base = welcomeWindowOptions('linux', locale)
  return {
    ...base,
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK : LIGHT,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? LIGHT : '#0F1115', height: 42 },
  }
}

let disposeActiveHandlers

/**
 * Open the process's sole welcome window with desktop-owned operations.
 * @param locale - shell-owned localized copy.
 * @param operations - credential write and this-launch-only skip actions.
 * @returns the visible window; a failed load destroys it before rejecting.
 */
export async function openLinuxWelcomeWindow(locale, operations) {
  const window = new BrowserWindow(linuxWelcomeOptions(locale))
  disposeActiveHandlers?.()
  let active = true
  const updateCaption = () => {
    if (window.isDestroyed()) return
    window.setTitleBarOverlay({ symbolColor: nativeTheme.shouldUseDarkColors ? LIGHT : '#0F1115' })
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK : LIGHT)
  }
  nativeTheme.on('updated', updateCaption)
  const disposeHandlers = () => {
    if (!active) return
    active = false
    nativeTheme.off('updated', updateCaption)
    for (const channel of [WELCOME_IPC.analyticsEnabled, WELCOME_IPC.analytics, WELCOME_IPC.takeNotice, WELCOME_IPC.saveApiKey,
      WELCOME_IPC.skip, WELCOME_IPC.start, WELCOME_IPC.cancel, WELCOME_IPC.copyLink]) ipcMain.removeHandler(channel)
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  const assertSender = event => {
    if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop welcome: rejected action from an unowned frame')
    }
  }
  ipcMain.handle(WELCOME_IPC.analyticsEnabled, event => { assertSender(event); return operations.analyticsEnabled() })
  ipcMain.handle(WELCOME_IPC.analytics, async (event, eventName, attributes) => {
    assertSender(event)
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) throw new Error('desktop welcome: invalid analytics attributes')
    if (eventName === 'auth_page_click' && 'button_name' in attributes && Object.keys(attributes).length === 1
      && (attributes.button_name === 'sign_in' || attributes.button_name === 'api-key')) {
      await operations.analytics?.(eventName, { button_name: attributes.button_name })
    } else if ((eventName === 'auth_page_view' || eventName === 'api_key_save_click') && Object.keys(attributes).length === 0) {
      await operations.analytics?.(eventName, {})
    } else throw new Error('desktop welcome: invalid analytics event')
  })
  ipcMain.handle(WELCOME_IPC.takeNotice, async event => { assertSender(event); return operations.takeNotice() })
  ipcMain.handle(WELCOME_IPC.saveApiKey, async (event, value) => {
    assertSender(event)
    if (typeof value !== 'string' || !/^[\x21-\x7e]+$/u.test(value)) return { ok: false }
    return operations.saveApiKey(value)
  })
  ipcMain.handle(WELCOME_IPC.skip, async event => { assertSender(event); await operations.skip() })
  ipcMain.handle(WELCOME_IPC.start, async event => { assertSender(event); return operations.startSignIn() })
  ipcMain.handle(WELCOME_IPC.cancel, async (event, id) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.cancelSignIn(id)
  })
  ipcMain.handle(WELCOME_IPC.copyLink, async (event, id) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.copySignInLink(id)
  })
  window.once('closed', disposeHandlers)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => { event.preventDefault() })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'welcome.html'))
  } catch (error) {
    disposeHandlers()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  if (active && !window.isDestroyed()) {
    window.show()
    void operations.analytics?.('auth_page_view', {})
  }
  return window
}

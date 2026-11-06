/** Linux caption composition: the shared Windows layout, without modifying upstream sources. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from '#upstream/ipc.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '#upstream/windows-layout.ts'
import { installWindowsMenu } from '#upstream/preload-menu.ts'

/**
 * Linux has no Windows shell, but the product's caption layout is platform-neutral CSS keyed by
 * `data-windows-titlebar`. This preload supplies that marker, the caption height, the Linux font
 * defaults, the caption menus, and measured palette colors for the native overlay controls.
 * It never changes `data-platform`, which stays `linux`.
 */
function install(): void {
  const root = document.documentElement as HTMLElement | null
  if (root === null) return
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${WINDOWS_TITLEBAR_HEIGHT}px`)
  root.style.setProperty('--dsh-font-family-text-default', "'Noto Sans', 'Noto Sans CJK SC', sans-serif")
  root.style.setProperty('--dsh-font-family-code-default', "'Liberation Mono', 'Noto Sans Mono', monospace")
  const menu = installWindowsMenu()
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
  document.body.append(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('Desktop caption requires a 2D canvas context')
  const nativeColor = (color: string): string => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`
  }
  let previous = ''
  const send = (): void => {
    const style = getComputedStyle(probe)
    const values = [root.lang, nativeColor(style.backgroundColor), nativeColor(style.color)]
    const current = JSON.stringify(values)
    if (current === previous) return
    previous = current
    menu.update()
    ipcRenderer.send(DESKTOP_IPC.windowsAppearance, ...values)
  }
  const observer = new MutationObserver(send)
  observer.observe(root, { attributes: true, attributeFilter: ['lang', 'data-fullscreen'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  document.head.addEventListener('load', send, true)
  ipcRenderer.on(DESKTOP_IPC.windowFullscreen, (_event, fullscreen: boolean) => {
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
    send()
  })
  window.addEventListener('pagehide', () => {
    observer.disconnect()
    menu.dispose()
    probe.remove()
    document.head.removeEventListener('load', send, true)
  }, { once: true })
  send()
}

// Only the product document, and only its top frame: guests and iframes keep the platform defaults.
if (process.isMainFrame === true && location.protocol === 'dsh-app:' && location.hostname === 'app') {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}

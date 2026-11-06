# Parity with the Windows Desktop

Reference: upstream Desktop `0.2.2-rc.1` at commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, whose Windows shell is `apps/desktop`.

Status vocabulary: **verified** (exercised on this build), **present** (shipped code path exists, not exercised here), **gap** (behaviour differs), **blocked** (needs an upstream change), **n/a** (Windows-only concept).

| Capability | Status | Notes |
|---|---|---|
| Electron main/preload/renderer composition | verified | Same upstream bundles; `npm run test:gui` |
| Private Host over Node IPC | verified | Upstream `dsh-desktop-host` entry, unmodified |
| Web UI served from `dsh-app://app/` | verified | Includes boot injections and authenticated forwarding |
| Welcome window, API key, skip | verified | Real welcome window from upstream |
| First-use default workspace | verified | Created under `$XDG_DOCUMENTS_DIR/deepseek-harness` |
| Profile creation under `profiles/desktop` | verified | Upstream `DesktopProjectManager` |
| Exclusive profile ownership | verified | App lock plus a PID-recorded owner lock |
| Window close hides, tray restores | verified | Tray icon from the packaged artwork |
| Quit and shutdown | verified | Graceful quit releases the profile lock; the active-task prompt is present but not exercised here |
| Tray, relaunch focus | verified | Tray icon from packaged artwork; second instance focuses |
| Light/dark palettes, theme source IPC | verified | Screenshots at 1280 and 620 CSS px |
| Responsive layout and narrow window | verified | 620 px screenshot |
| Sidebar Browser (`webview`, leases) | present | Upstream path enabled; not scripted end to end here |
| File drag, clipboard image, file actions | present | Upstream adapters installed; not scripted |
| Native directory picker | present | Upstream picker; falls back to Host browse without zenity/kdialog |
| Microphone permission handling | present | Upstream Electron handler on the default session |
| Shortcuts service and menu interception | present | Upstream service with Linux dispatch path |
| DevTools toggle, no auto-open | verified | DevTools closed at startup |
| Office/Python primary runtime | verified | Payload smoke: Office versions, DOCX/XLSX/PPTX round trips |
| External plugin CLI | verified | Bundled `dsh` CLI via `dsh-desktop plugin`; app must be closed |
| Embedded account/Platform pages | blocked | Upstream maps only `darwin`/`win32` to `desktop-mac`/`desktop-win`; Linux is not impersonated |
| Update channels, in-app install | gap | Linux installs are updated by their npm package; no official feed |
| macOS vibrancy, Dock, traffic lights | n/a | Platform-specific |
| Windows NSIS installer, task dialog, tray ICO | n/a | Platform-specific |
| Windows `session-end` shutdown detection | gap | Linux uses `powerMonitor` shutdown only |
| Computer Use helper | n/a | Ships only for macOS |
| ARM64 payload | gap | Only x86_64 is built and qualified here |

## Not claimed

Passing the smoke test does not establish: every distribution, every compositor, HiDPI scaling on every desktop, enterprise or AppArmor user-namespace policy, real account sign-in, model turns, external plugin compatibility beyond the CLI path, or the embedded Platform pages.

## Why the account pages are blocked

`platformClientHeaders` in the upstream account package accepts `'darwin' | 'win32' | null`. Reporting `desktop-linux` would require an upstream change; reporting `desktop-win` would lie to a remote service about the platform. The carrier therefore exposes the external account website path the product already has and reports the limitation instead of degrading silently.

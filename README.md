# DeepSeek Harness Desktop for Linux

Community Electron carrier that runs the **complete upstream Desktop application** — window, private Host, Web UI, sidebar browser, plugins, Office payload — against an **unmodified DeepSeek Harness release**.

The upstream source tree is never patched. `upstream.lock.json` pins one commit; builds verify that commit and a clean tracked tree before and after, and compose only upstream modules that are exported today.

This is not an official Linux release. It does not replace your `dsh` command, does not write to `~/.bashrc`, and does not use the Windows or macOS update feeds.

## Status

Working today on Arch Linux x86_64 (GNOME/Wayland and X11): build, Electron + Host startup, Welcome, workspace, first-use default workspace, the shared Windows caption layout with Application/Edit menus and measured palette, light/dark themes, narrow window, tray, quit confirmation, fatal recovery, bundled CLI plugin add/list/remove, and a real packaged install. Measured on this machine: payload 1.3 GB, release archive 393 MB, install 7.4 s.

Not yet qualified: other distributions, ARM64, the embedded account/Platform pages, and several Windows-only behaviours listed in [docs/parity.md](docs/parity.md). Those gaps are reported, not silently substituted.

## Requirements

- Linux glibc x86_64, a graphical session.
- Node.js ≥ 24.9 and pnpm for building from source.
- `pnpm` for `dsh-desktop plugin` operations, provided by the bundled payload at runtime.
- Electron's usual shared libraries (GTK 3, NSS, Mesa, libxkbcommon, ALSA). `dsh-desktop doctor` lists unresolved `ldd` entries.

## Build from source

```sh
npm install --ignore-scripts
npm run build:upstream     # clone pinned commit, pnpm install, build artifacts, native addons
npm run build              # assemble dist/payload
npm test
npm run test:gui           # real Electron + real Host, isolated HOME
```

`build:upstream` clones into `.cache/upstream` and refuses to run if that checkout is not the pinned commit with a clean tracked tree.

## Run the payload without installing

```sh
node bin/dsh-desktop.mjs --payload dist/payload
```

`--payload` runs a verified directory directly. It still uses the normal `DSH_HOME`, so chats and credentials are shared with `dsh web`; the Desktop profile stays separate at `$DSH_HOME/profiles/desktop`.

## Package a release and install

```sh
node scripts/package.mjs --archive <release.tar.gz>   # records digest and byte size
node bin/dsh-desktop.mjs install --archive <release.tar.gz>
```

Installation is per-user: `$XDG_DATA_HOME/dsh-desktop-linux` (payloads and launcher), `$XDG_CACHE_HOME` (downloads), `$XDG_CONFIG_HOME` (Electron preferences). No root, no FUSE, no writes to another application's files.

An archive is verified (size, SHA-256, entry types, one containment root, no links escaping the payload, embedded release identity, and a content digest over the whole payload) and unpacked into a staging directory. Only then is the active release reference replaced. A failure leaves the previous release active. A lock file makes concurrent installs fail loudly instead of racing. The installer refuses to overwrite a desktop entry it does not own.

Release identity includes the payload digest, so a rebuilt archive with the same version and commit installs beside the old one and becomes active instead of silently reusing stale files. `dsh-desktop --version` prints the active release id and payload path; the previously active release is retained for rollback and older ones are pruned.

## Commands

```sh
dsh-desktop                       # launch or focus the running instance
dsh-desktop --version             # distribution and embedded Harness versions
dsh-desktop doctor                # read-only environment and install diagnostics
dsh-desktop plugin list|add|remove ...   # forwarded to the bundled Desktop CLI
dsh-desktop cli <dsh arguments>   # explicit escape to the bundled CLI
dsh-desktop install|update [--archive FILE --manifest FILE]
dsh-desktop uninstall --yes       # removes owned app files; keeps chats, credentials, profiles
```

`plugin` implicitly selects the reserved `desktop` profile and requires the app to be fully quit. Profile writes, version compatibility checks and the write lock stay with the upstream Desktop CLI; this project reimplements none of them.

## Data ownership

| Data | Location | Shared with Web / npm dsh |
|---|---|---|
| Chats and workspaces | `$DSH_HOME/sessions`, `$DSH_HOME/storages` | yes, same files |
| Local credentials | `$DSH_HOME/.credentials.yaml` | yes |
| Global overrides | `$DSH_HOME/cordis.patch.yml` | yes |
| Desktop profile, plugins | `$DSH_HOME/profiles/desktop` | no |
| Electron preferences, logs | `$XDG_CONFIG_HOME/dsh-desktop-linux` | no |
| Installed payload | `$XDG_DATA_HOME/dsh-desktop-linux` | no |

Provider configuration lives in the Desktop profile, so it is not inherited from the Web profile automatically. A credential is shared only where both profiles reference the same entry. One writer per session still applies: release the session in the other surface first.

## Sandbox

Desktop runs with Chromium sandboxing. The launcher passes `--disable-setuid-sandbox` so a rootless install uses the user-namespace sandbox and never needs a root-owned setuid helper; it does **not** pass `--no-sandbox`. Kernel namespace policy remains the host's. If a distribution blocks unprivileged user namespaces, the application reports the Chromium failure rather than degrading silently.

Arbitrary extra Electron arguments are rejected by the launcher, exactly so a habit like `--no-sandbox` cannot be added later.

## Parity with Windows

Status is per capability, verified on this build unless noted.

| Capability | Status | Evidence / gap |
|---|---|---|
| Electron shell, private Host, Web UI | verified | `npm run test:gui` |
| Welcome, API-key entry, skip, workspace entry | verified | GUI smoke |
| Shared chats/workspaces, separate Desktop profile | verified | install tests + same `DSH_HOME` roots |
| Desktop CLI and plugin profile plumbing | verified | bundled `cli.js` forwarding |
| Light/dark, narrow window, font defaults | verified | `npm run test:gui` writes screenshots to `artifacts/verification` (not committed) |
| Tray, relaunch focuses instance, quit confirmation | verified | Linux-specific composition |
| Sidebar browser (`webview` with leases) | present, unverified end-to-end | needs a scripted UI pass |
| Office/Python primary runtime | verified | payload smoke during build |
| Sandbox active | verified | `webPreferences` and argv assertions |
| Embedded account/Platform pages | **blocked upstream** | upstream maps only macOS/Windows to header values; no impersonation |
| Update channels and in-app update install | **not implemented** | updates come from the npm package managing this install |
| macOS/Windows-only shell features | not applicable | vibrancy, NSIS, Dock, `session-end` |

## Unchanged upstream

`npm run verify:upstream` confirms the pinned commit and clean tracked tree. The build never rewrites upstream sources, compiled bundles, or `process.platform`. The one line of Linux-specific CSS is injected into our own window at load time; it sets the shared font defaults already used by the repository's Linux package work.

## Release artefact

The packaged archive for this build is `dist/dsh-desktop-linux-0.1.0-fcc0ad462172.tar.gz` (393 MB, SHA-256 `89ae1f01c7d29dabf0131d7f6cbffaaad4d3c7e785e2709eed0c13d050ee250a`). It is a local build: no npm publication, no AUR package, no remote hosting.

## Troubleshooting

**The launcher opens an older build.** `dsh-desktop --version` prints `Release` and `Payload`. If they name a different directory than the archive just installed, the install did not activate; re-run it and check that it reports the new path. Builds made before content-addressed identities reused the version-named directory, so remove `~/.local/share/dsh-desktop-linux/releases/0.1.0-<commit>-x64` once.

**The window shows no caption buttons.** They are native overlay controls: a screenshot of the page cannot include them, and a compositor without server-side decorations may hide them. Launch from the desktop entry rather than a raw `electron` process.

**Nothing appears on Wayland.** Confirm `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` in the launching environment; the application reports the Chromium failure instead of falling back to `--no-sandbox`.

## Licence

MIT for this carrier. The payload redistributes DeepSeek Harness under its own MIT licence (`UPSTREAM-LICENSE` in the payload) and third-party components under their respective terms.

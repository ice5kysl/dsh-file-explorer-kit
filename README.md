# dsh-file-explorer-kit

> GitHub: <https://github.com/ice5kysl/dsh-file-explorer-kit> ｜ MIT License ｜ Target dsh: `@deepseek-ai/dsh` ≥ 0.1.1-rc.2 ｜ English · [简体中文](./README.zh-CN.md)

A **dsh (DeepSeek Harness) plugin** written to official conventions, in "bundle" form. It solves one pain point:

> Your workspace holds lots of files, and every time you want a quick look at the directory structure or a file's contents, you have to switch to Finder / File Explorer — that's a hassle.

This plugin lets you **browse workspace directories and preview files directly inside the session**, without leaving dsh Web:

- **A third session tab, "Files"** (Chat | Trajectory | Files; shown as 对话 | 轨迹 | 文件 in the Chinese UI): registers into the official `conversation.view` view ring, ordered after chat (order 0) and trajectory (order 10) at order 20, and the tab bar appears automatically; the tab label follows the interface language (文件 / Files);
- Opens rooted at the **current session's workspace directory**; directory breadcrumbs + a directory/file list (directories first, size / time, a toggle for hidden dotfiles), plus **jump to any absolute path**;
- Auto-refreshes while it is open (so you also see files the agent writes in the background); **switch away and back, and the last directory is remembered per session**;
- **Bilingual zh/en UI**: auto-detected from the browser language (zh → Chinese, anything else → English), and a 「中 / EN」 (Chinese / English) button in the top bar switches at any time and remembers the preference;
- Right-side preview: **Markdown rendered by default** (one-click `预览` (Preview) / `Raw` toggle; before rendering, content is parsed by marked and sanitized with DOMPurify to protect against XSS from malicious md files in the repo, and links inside the preview always open in a new tab), **images shown inline**, other **text with line numbers** (truncated with a notice when overly long), embedded PDF; binary files get a "Copy path / Open in file manager" action (via the official `ctx.workspaces.openPath`);
- All directory/file data flows through the host-side `/dsh-files` **read-only** endpoints; the plugin never modifies any file.

## Why host-side routes are needed (design notes; all based on the official docs/source)

The official browser contract only offers **directory-level browsing** (`ctx.workspaces.listDirectory` → `host.listDirectory`; `DirectoryListing.entries` contains only directory rows) — **there are no file rows and no RPC that reads file contents**. The conclusion we verified in `dsh-workspace-kit` — that "the client can only consume the `ctx.remote.*` generated at build time" — holds here as well. So previewing arbitrary workspace files is only possible through the official **`ctx.webServer.register`** route seam (`dsh-host-webserver`: `WebRoute { kind, path, handler }`; a named prefix takes priority over the fallback):

| Endpoint (GET) | Description |
|---|---|
| `/dsh-files/home` | The host account's home directory |
| `/dsh-files/list?path=<abs>` | Single-level directory: file + directory rows (kind/size/mtimeMs/hidden) + breadcrumbs, mirroring the official `DirectoryListing` semantics (missing path = home directory) |
| `/dsh-files/text?path=&maxBytes=` | Text preview head (utf-8 decoded, NUL sniffing to detect binary, truncation marker; 300 KB server-side cap) |
| `/dsh-files/raw?path=` | Raw byte stream (Content-Type guessed from the file extension, for `<img>`/PDF embedding) |

- Read-only, with no write endpoints; the client **never assembles paths itself** (every path comes from a server response or a workspace/session path provided by the framework).
- Every request passes a host-trust gate that mirrors the official `/api` trust fence: a loopback Host passes straight through; a non-loopback one needs a same-origin Origin marker. **This is not an authentication layer** — consistent with the official web server (binds 127.0.0.1 by default; keep the loopback binding when deploying).
- The routes are registered in the plugin's `apply` via `ctx.effect(() => ctx.webServer.register(...))` and are released automatically when the plugin's fiber unmounts.

## Quick install (personal dsh on this machine)

Prerequisites: `dsh` on PATH (`@deepseek-ai/dsh` ≥ 0.1.1-rc.2), Node 20+.

```bash
# 0. Get the source (or use a local directory directly)
git clone https://github.com/ice5kysl/dsh-file-explorer-kit && cd dsh-file-explorer-kit

# 1. Build (produces lib/index.js + lib/client.js; npm install's prepare hook
#    runs the build automatically)
npm install                # installs build-time deps (typescript/esbuild/@types/marked/dompurify/lucide-react, etc.)
npm run build

# 2. Install into your web profile (equivalent to the official dsh plugin add bundle)
bash scripts/install-personal.sh   # the script locates the plugin directory itself by walking up (run it straight from the repo root)
#    What the script actually runs: dsh plugin --profile web add <this plugin directory>
#    It appends this package to dsh.profile.bundles in ~/.dsh/profiles/web (after
#    dsh-web-app); the in-package cordis.patch.yml inserts the single Loader line.

# 3. Verify the composition (no restart needed)
dsh --profile web --dump-config | grep -n "file-explorer"

# 4. Restart the GUI to activate
#    Quit the current dsh web (Ctrl+C or kill the process), run dsh web again,
#    then refresh the browser at http://127.0.0.1:3080
```

Once it is active:

- Open any session and the title bar shows three tabs — **对话 | 轨迹 | 文件 (Chat | Trajectory | Files)**; clicking "Files" browses that session's workspace directory in the body area (single-click a directory row to enter it, single-click a file row to preview; ↑↓/↵/⌫ keyboard navigation works).
- The top bar holds one row: breadcrumbs + a "Show hidden / Refresh / 中EN (Chinese/English)" control + an absolute-path jump box; the preview panel offers "Copy path / Open in file manager".
- Switch to another session and come back, and the "Files" tab remembers the directory that session last browsed (in-memory only; not across refreshes).

> Compatible with dsh-workspace-kit: this plugin only takes an additive slot (a tab) in `conversation.view` and does no replacement-style shadowing, so both plugins can be enabled together.

## Package / distribute (optional)

```bash
npm pack          # produces dsh-file-explorer-kit-0.3.1.tgz (includes a prebuilt lib/; prepack builds automatically)
# On another machine: dsh plugin --profile web add ./dsh-file-explorer-kit-0.3.1.tgz
```

> npm package name: **dsh-file-explorer-kit** — the plain `dsh-file-explorer` name on npm belongs to an unrelated plugin (joejojoking-cloud), so always install as `dsh plugin add dsh-file-explorer-kit`, never as `dsh-file-explorer`.

## Development

```bash
npm run typecheck   # tsc --noEmit (host + browser sources)
npm run build       # esbuild: src/host → lib/index.js; src/client → lib/client.js
node scripts/smoke.mjs   # standalone smoke test of the host /dsh-files endpoints
```

Source layout:

```
src/host/     Host side: fs-server.ts (pure directory-scan / text-read functions),
              index.ts (apply: registers the /dsh-files prefix routes via
              ctx.effect + the host-trust gate)
src/client/   Browser side: FilesView.tsx (the file browser for the conversation.view
              tab), browse-memory.ts (remembers the last directory per session),
              files-api.ts (/dsh-files fetch client + types), actions.ts (openPath
              binding), locale.ts (zh/EN detection and L()), icons.tsx (lucide SVG
              row icons), index.ts (apply: conversation.view registration)
src/shared/   i18n.ts (pure localize/normalizeLocale, shared by host/client)
cordis.patch.yml    bundle layer: inserts the single Loader entry dsh-file-explorer-kit
```

## Compatibility / known limitations

- Target dsh: `@deepseek-ai/dsh` v0.1.1-rc.2 (`dsh web`, profile `web`). The browser face targets that release's `conversation.view` view-ring contract (tabs are auto-listed from the entries; the body renders only the active view per `only: <active id>`) and `ctx.workspaces.openPath`; re-validate against the upstream contract on version upgrades.
- The "Files" tab only appears **inside a session** (the no-session hero state has no tabs) — an inherent boundary of session-level views.
- Styling is inline (light theme) and does not follow the system theme — the same tradeoff as dsh-workspace-kit v1.
- Security boundary: the endpoints are read-only; `/dsh-files` keeps the official trust posture (it is not an authentication layer). If you deploy behind a container/proxy where the Host header is not loopback, keep the dsh web service on a loopback binding or extend the `trusted()` allowlist in `src/host/index.ts`.
- Integration with the LoopDSH platform's per-user instances is the same as for dsh-workspace-kit: see "Option A: idempotent pre-provisioning at harness startup" in `docs/plugins/loopdsh-integration.md` inside the LoopDSH repository.

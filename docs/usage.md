# Usage, route contract & security boundary (dsh-file-explorer-kit)

> 简体中文版见 [usage.zh-CN.md](./usage.zh-CN.md)。

This page collects the operational details that the README summarizes: how the plugin
works inside dsh Web, the exact `/dsh-files` HTTP contract, and the permission /
security boundary the host side enforces.

## How it works

The plugin is a standard Cordis **bundle** with two faces:

- **Host face** (`src/host/index.ts`): in `apply`, it registers a prefix route
  `/dsh-files` on `ctx.webServer` via `ctx.effect(() => ctx.webServer.register(...))`.
  The route is released automatically when the plugin fiber unmounts. All directory
  scanning and text reading happens here, in pure functions (`src/host/fs-server.ts`).
- **Browser face** (`src/client/index.ts`): registers a third session tab, "Files"
  (对话 | 轨迹 | 文件), into the official `conversation.view` view ring at order 20
  (after chat at 0 and trajectory at 10). The tab is rooted at the **current
  session's workspace directory** and talks to the host face only through the
  read-only `/dsh-files` endpoints.

Why host-side routes are needed at all: the official browser contract offers only
**directory-level browsing** (`ctx.workspaces.listDirectory` → `host.listDirectory`;
`DirectoryListing.entries` contains directory rows only) — there are no file rows and
no RPC that reads file contents. Previewing arbitrary workspace files is therefore
only possible through the official `ctx.webServer.register` route seam
(`dsh-host-webserver`: `WebRoute { kind, path, handler }`; a named prefix takes
priority over the fallback).

## Route contract (`/dsh-files`, all GET)

| Endpoint | Description |
|---|---|
| `/dsh-files/home` | The host account's home directory |
| `/dsh-files/list?path=<abs>` | Single-level directory listing: file + directory rows (`kind`/`size`/`mtimeMs`/`hidden`) + breadcrumbs, mirroring the official `DirectoryListing` semantics (missing `path` = home directory) |
| `/dsh-files/text?path=&maxBytes=` | Text preview head (utf-8 decoded, NUL sniffing to detect binary, truncation marker; 300 KB server-side cap) |
| `/dsh-files/raw?path=` | Raw byte stream (Content-Type guessed from the file extension, for `<img>`/PDF embedding) |

Error shape: failures return a JSON body `{ ok: false, error: { code, ... } }` —
`ENOENT` (missing file), `ENOTDIR` (directory passed to a file endpoint),
`invalid-path` (relative path rejected with HTTP 400).

The client **never assembles paths itself**: every `path` it sends comes from a
server response (list rows, breadcrumbs, home) or from a workspace/session path
provided by the framework.

## Permission & security boundary

- **Read-only by design.** There are no write endpoints; the plugin never modifies,
  moves, or deletes any file.
- **Host-trust gate.** Every request passes a gate that mirrors the official `/api`
  trust fence: a loopback `Host` header passes straight through; a non-loopback one
  needs a same-origin `Origin` marker. **This is not an authentication layer** —
  consistent with the official web server, which binds 127.0.0.1 by default. Keep the
  loopback binding when deploying; if you run behind a container/proxy where the
  `Host` header is not loopback, extend the `trusted()` allowlist in
  `src/host/index.ts`.
- **XSS hardening on the preview.** Markdown is parsed by marked and sanitized with
  DOMPurify before rendering (a malicious `.md` inside a repo must not inject script
  into the dsh GUI); links inside the preview always open in a new tab.

## Development

```bash
npm run typecheck   # tsc --noEmit (host + browser sources)
npm run build       # esbuild: src/host → lib/index.js; src/client → lib/client.js
npm test            # standalone smoke test of the host /dsh-files endpoints
```

The smoke test (`tests/smoke.test.mjs`) boots a tiny `node:http` server that mimics
the `ctx.webServer` route contract — no Cordis runtime needed — and exercises the
route registration, listing/breadcrumb semantics, text preview, error codes, the
relative-path rejection, raw streaming, and the host-trust gate end to end.

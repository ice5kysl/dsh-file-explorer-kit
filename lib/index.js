// src/host/index.ts
import { createReadStream } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute2 } from "node:path";

// src/host/fs-server.ts
import { readdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
var MAX_ENTRIES = 2e3;
var MAX_TEXT_BYTES = 3e5;
function buildCrumbs(dir) {
  const parsed = parse(dir);
  const root = parsed.root;
  if (!root) return [];
  const crumbs = [{ name: root, path: root, kind: "dir", size: 0, mtimeMs: 0, hidden: false }];
  if (dir === root) return crumbs;
  const rest = dir.slice(root.length);
  let acc = root;
  for (const segment of rest.split(sep)) {
    if (!segment) continue;
    acc = join(acc, segment);
    crumbs.push({ name: segment, path: acc, kind: "dir", size: 0, mtimeMs: 0, hidden: false });
  }
  return crumbs;
}
async function entryOf(dir, name2) {
  const path = join(dir, name2);
  const hidden = name2.startsWith(".");
  try {
    const info = await stat(path);
    return {
      name: name2,
      path,
      kind: info.isDirectory() ? "dir" : "file",
      size: info.isDirectory() ? 0 : info.size,
      mtimeMs: info.mtimeMs,
      hidden
    };
  } catch {
    return { name: name2, path, kind: "file", size: 0, mtimeMs: 0, hidden };
  }
}
async function listLevel(dir) {
  if (!isAbsolute(dir)) throw fsError("invalid-path", `not an absolute path: ${dir}`);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw fsErrorFrom(error);
  }
  const entries = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    if (dirent.isDirectory() || dirent.isFile() || dirent.isSymbolicLink()) {
      const row = await entryOf(dir, dirent.name);
      if (row) entries.push(row);
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });
  });
  return {
    path: dir,
    home: homedir(),
    parent: dirname(dir) === dir ? null : dirname(dir),
    crumbs: buildCrumbs(dir),
    entries,
    truncated
  };
}
var BINARY_SNIFF = 4096;
async function readTextHead(path, maxBytes) {
  if (!isAbsolute(path)) return { kind: "missing", size: 0, truncated: false, error: fsError("invalid-path", `not an absolute path: ${path}`) };
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return { kind: "missing", size: 0, truncated: false, error: fsErrorFrom(error) };
  }
  if (info.isDirectory()) return { kind: "missing", size: 0, truncated: false, error: fsError("ENOTDIR", "path is a directory") };
  if (!info.isFile()) return { kind: "missing", size: 0, truncated: false, error: fsError("EIO", "path is not a regular file") };
  const want = Math.min(maxBytes, info.size);
  const buffer = Buffer.alloc(want);
  let handle;
  try {
    handle = await open(path, "r");
    let read = 0;
    while (read < want) {
      const chunk = await handle.read(buffer, read, want - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    const head = buffer.subarray(0, Math.min(BINARY_SNIFF, read));
    if (read === 0) return { kind: "empty", size: 0, truncated: false };
    if (head.includes(0)) return { kind: "binary", size: info.size, truncated: info.size > read };
    return { kind: "text", size: info.size, truncated: info.size > read, text: buffer.subarray(0, read).toString("utf8") };
  } catch (error) {
    return { kind: "missing", size: 0, truncated: false, error: fsErrorFrom(error) };
  } finally {
    if (handle) await handle.close().catch(() => {
    });
  }
}
function fsError(code, message) {
  return { code, message };
}
function fsErrorFrom(error) {
  const raw = error;
  if (typeof raw.code === "string" && typeof raw.message === "string") return fsError(raw.code, raw.message);
  const code = typeof raw.code === "string" ? raw.code : "EIO";
  const message = typeof raw.message === "string" ? raw.message : String(error);
  if (code === "ENOENT") return fsError("ENOENT", message);
  if (code === "ENOTDIR") return fsError("ENOTDIR", message);
  if (code === "EACCES" || code === "EPERM") return fsError("EACCES", message);
  return fsError("EIO", message);
}
function contentTypeOf(path) {
  const ext = basename(path).toLowerCase().split(".").pop() ?? "";
  const table = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8"
  };
  return table[ext] ?? "application/octet-stream";
}

// src/host/index.ts
var name = "file-explorer";
var inject = ["webServer"];
var PREFIX = "/dsh-files";
function apply(raw) {
  const ctx = raw;
  const log = ctx.logger("file-explorer");
  log.info("dsh-file-explorer loaded (host /dsh-files routes)");
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, log)
  }));
  log.info("registered GET /dsh-files/{home,list,text,raw} (read-only)");
}
async function handleRequest(req, res, log) {
  if (!trusted(req)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: fsError("forbidden", "untrusted host/origin") }));
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: fsError("method-not-allowed", "only GET is served") });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.searchParams.get("path");
  try {
    if (url.pathname === `${PREFIX}/home` || url.pathname === `${PREFIX}/home/`) {
      sendJson(res, 200, { ok: true, home: homedir2() });
      return;
    }
    if (url.pathname === `${PREFIX}/list` || url.pathname === `${PREFIX}/list/`) {
      const listing = await listLevel(path && path.length > 0 ? path : homedir2());
      sendJson(res, 200, { ok: true, ...listing });
      return;
    }
    if (url.pathname === `${PREFIX}/text` || url.pathname === `${PREFIX}/text/`) {
      if (!path) throw fsError("invalid-path", "missing ?path=");
      const rawMax = url.searchParams.get("maxBytes");
      const maxBytes = Math.max(1, Math.min(Number(rawMax) || MAX_TEXT_BYTES, MAX_TEXT_BYTES));
      const head = await readTextHead(path, maxBytes);
      if (head.kind === "missing" || head.error) {
        const error = head.error ?? fsError("EIO", "read failed");
        sendJson(res, statusOf(error.code), { ok: false, error });
        return;
      }
      sendJson(res, 200, { ok: true, path, ...head });
      return;
    }
    if (url.pathname === `${PREFIX}/raw` || url.pathname === `${PREFIX}/raw/`) {
      if (!path || !isAbsolute2(path)) throw fsError("invalid-path", "missing or relative ?path=");
      await sendRaw(res, path);
      return;
    }
    if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
      sendJson(res, 200, {
        ok: true,
        plugin: "dsh-file-explorer",
        endpoints: ["/dsh-files/home", "/dsh-files/list?path=", "/dsh-files/text?path=&maxBytes=", "/dsh-files/raw?path="]
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: fsError("not-found", `unknown endpoint ${url.pathname}`) });
  } catch (error) {
    const wire = fsErrorFrom(error);
    log.info("request failed", url.pathname, wire.code);
    sendJson(res, statusOf(wire.code), { ok: false, error: wire });
  }
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function statusOf(code) {
  if (code === "invalid-path") return 400;
  if (code === "forbidden") return 403;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "not-found") return 404;
  return 500;
}
function sendRaw(res, path) {
  return new Promise((resolve) => {
    const stream = createReadStream(path);
    stream.once("error", (error) => {
      const wire = fsErrorFrom(error);
      sendJson(res, statusOf(wire.code), { ok: false, error: wire });
      resolve();
    });
    stream.once("open", () => {
      res.writeHead(200, { "content-type": contentTypeOf(path), "cache-control": "no-store" });
      stream.pipe(res);
    });
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}
function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end < 0 ? null : trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  const host = colon < 0 ? trimmed : trimmed.slice(0, colon);
  return host.toLowerCase() || null;
}
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
function trusted(req) {
  const host = hostnameOf(req.headers.host);
  if (host && isLoopbackHostname(host)) return true;
  const origin = req.headers.origin;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.toLowerCase() !== host) return false;
    const hostHeader = req.headers.host ?? "";
    if (hostHeader.includes(":")) {
      const portOfHost = hostnameOf(hostHeader) ? parsed.port || (parsed.protocol === "https:" ? "443" : "80") : "";
      const expected = hostHeader.slice(hostHeader.lastIndexOf(":") + 1);
      return portOfHost === expected || !expected && parsed.port === "";
    }
    return parsed.port === "";
  } catch {
    return false;
  }
}
export {
  apply,
  inject,
  name
};

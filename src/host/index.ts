/**
 * dsh-file-explorer — single Loader entry (package name `dsh-file-explorer`).
 *
 * Host face (this module): registers a read-only HTTP surface on the official
 * `ctx.webServer` route seam under `/dsh-files`:
 *
 * - `GET /dsh-files/list?path=<abs>`   — one directory level (dirs + files
 *   with size/mtime + breadcrumb ancestry), JSON.
 * - `GET /dsh-files/text?path=<abs>&maxBytes=` — utf-8 text head for preview
 *   (binary sniff + truncation flag), JSON.
 * - `GET /dsh-files/raw?path=<abs>`    — raw bytes with a guessed content
 *   type (images / pdf / svg) for <img> preview.
 * - `GET /dsh-files/home`              — host account home directory.
 *
 * Every request passes a host-trust gate mirroring the official /api fence:
 * loopback authorities are trusted; anything else needs a same-origin browser
 * marker. This is NOT an auth layer — same posture as the official web
 * server (bind 127.0.0.1 by default; keep the dsh web server loopback-bound
 * in deployments).
 *
 * Browser face (`./client`): the file-explorer panel + entry buttons (see
 * src/client). It consumes these routes with same-origin `fetch`.
 *
 * @module dsh-file-explorer
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { contentTypeOf, fsError, fsErrorFrom, listLevel, MAX_TEXT_BYTES, readTextHead } from './fs-server.ts'

export const name = 'file-explorer'

/** Required service: the web route-registration carrier (see dsh-host-webserver). */
export const inject = ['webServer'] as const

/** Minimal faces of the pieces this plugin consumes (typed locally). */
interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
}

interface HostCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  effect(fn: () => unknown): unknown
  webServer: WebServerLike
}

const PREFIX = '/dsh-files'

export function apply(raw: unknown): void {
  const ctx = raw as HostCtxLike
  const log = ctx.logger('file-explorer')
  log.info('dsh-file-explorer-kit loaded (host /dsh-files routes)')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, log),
  }))
  log.info('registered GET /dsh-files/{home,list,text,raw} (read-only)')
}

// ── request handling ─────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  log: { info(...parts: unknown[]): void },
): Promise<void> {
  if (!trusted(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: fsError('forbidden', 'untrusted host/origin') }))
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: fsError('method-not-allowed', 'only GET is served') })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.searchParams.get('path')
  try {
    if (url.pathname === `${PREFIX}/home` || url.pathname === `${PREFIX}/home/`) {
      sendJson(res, 200, { ok: true, home: homedir() })
      return
    }
    if (url.pathname === `${PREFIX}/list` || url.pathname === `${PREFIX}/list/`) {
      const listing = await listLevel(path && path.length > 0 ? path : homedir())
      sendJson(res, 200, { ok: true, ...listing })
      return
    }
    if (url.pathname === `${PREFIX}/text` || url.pathname === `${PREFIX}/text/`) {
      if (!path) throw fsError('invalid-path', 'missing ?path=')
      const rawMax = url.searchParams.get('maxBytes')
      const maxBytes = Math.max(1, Math.min(Number(rawMax) || MAX_TEXT_BYTES, MAX_TEXT_BYTES))
      const head = await readTextHead(path, maxBytes)
      if (head.kind === 'missing' || head.error) {
        const error = head.error ?? fsError('EIO', 'read failed')
        sendJson(res, statusOf(error.code), { ok: false, error })
        return
      }
      sendJson(res, 200, { ok: true, path, ...head })
      return
    }
    if (url.pathname === `${PREFIX}/raw` || url.pathname === `${PREFIX}/raw/`) {
      if (!path || !isAbsolute(path)) throw fsError('invalid-path', 'missing or relative ?path=')
      await sendRaw(res, path)
      return
    }
    if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-file-explorer-kit',
        endpoints: ['/dsh-files/home', '/dsh-files/list?path=', '/dsh-files/text?path=&maxBytes=', '/dsh-files/raw?path='],
      })
      return
    }
    sendJson(res, 404, { ok: false, error: fsError('not-found', `unknown endpoint ${url.pathname}`) })
  } catch (error) {
    const wire = fsErrorFrom(error)
    log.info('request failed', url.pathname, wire.code)
    sendJson(res, statusOf(wire.code), { ok: false, error: wire })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Map a wire error code to an HTTP status. */
function statusOf(code: string): number {
  if (code === 'invalid-path') return 400
  if (code === 'forbidden') return 403
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'not-found') return 404
  return 500
}

/** Stream a file's raw bytes; headers are only written once the file opens. */
function sendRaw(res: ServerResponse, path: string): Promise<void> {
  return new Promise((resolve) => {
    const stream = createReadStream(path)
    stream.once('error', (error: NodeJS.ErrnoException) => {
      const wire = fsErrorFrom(error)
      sendJson(res, statusOf(wire.code), { ok: false, error: wire })
      resolve()
    })
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': contentTypeOf(path), 'cache-control': 'no-store' })
      stream.pipe(res)
    })
    stream.once('end', () => resolve())
    stream.once('close', () => resolve())
  })
}

// ── host-trust gate (mirrors the official /api fence posture) ───────────────

/** Lowercased hostname of an HTTP Host header, brackets stripped. */
function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const trimmed = hostHeader.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end < 0 ? null : trimmed.slice(1, end).toLowerCase()
  }
  const colon = trimmed.lastIndexOf(':')
  const host = colon < 0 ? trimmed : trimmed.slice(0, colon)
  return host.toLowerCase() || null
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Decide whether one request may reach the file surface: loopback Host is
 * trusted outright (the official loopback arm); anything else must carry a
 * same-origin browser marker (the official browser-marker arm). Deployments
 * serving over extra LAN authorities should keep the web server bound to
 * loopback, or extend this gate with the deployment's trusted authorities.
 */
function trusted(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host)
  if (host && isLoopbackHostname(host)) return true
  const origin = req.headers.origin
  if (!origin || !host) return false
  try {
    const parsed = new URL(origin)
    if (parsed.hostname.toLowerCase() !== host) return false
    // Same-origin port must match too (default-port literals compare equal
    // against the Host header's explicit port after normalization by URL).
    const hostHeader = req.headers.host ?? ''
    if (hostHeader.includes(':')) {
      const portOfHost = hostnameOf(hostHeader) ? parsed.port || (parsed.protocol === 'https:' ? '443' : '80') : ''
      const expected = hostHeader.slice(hostHeader.lastIndexOf(':') + 1)
      return portOfHost === expected || (!expected && parsed.port === '')
    }
    return parsed.port === ''
  } catch {
    return false
  }
}

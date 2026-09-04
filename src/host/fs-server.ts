/**
 * dsh-file-explorer — host-side filesystem service (pure functions).
 *
 * The official client contract (`host.listDirectory`) only lists
 * directories, and there is no official read-file RPC an out-of-tree browser
 * face could consume, so this plugin ships its own tiny read-only surface on
 * the official `ctx.webServer` route seam (see src/host/index.ts). These
 * functions stay pure so they are easy to reason about and test:
 *
 * - `listLevel(dir)` — one directory level with breadcrumb ancestry, the
 *   shape mirroring the official `DirectoryListing` (name/path/hidden +
 *   crumbs) extended with `kind`/`size`/`mtimeMs` file rows the official
 *   browser cannot see.
 * - `readTextHead(path, maxBytes)` — utf-8 text head with a binary sniff and
 *   truncation flag.
 *
 * The client never joins path segments itself: every path it fetches comes
 * from these responses or from framework-provided workspace/session paths.
 *
 * @module dsh-file-explorer/fs-server
 */

import { readdir, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path'

/** Row kind of one listed entry. */
export type EntryKind = 'dir' | 'file'

/** One row of a directory listing (child entry or breadcrumb ancestor). */
export interface FsEntry {
  /** Base name shown in the browser row. */
  name: string
  /** Absolute host path — clients never join segments themselves. */
  path: string
  kind: EntryKind
  /** File size in bytes; 0 for directories. */
  size: number
  /** Last modification epoch ms; 0 when unknown. */
  mtimeMs: number
  /** Dot-prefixed (POSIX convention); the client owns whether to show it. */
  hidden: boolean
}

/** One directory level plus its breadcrumb ancestry. */
export interface FsListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Host account home directory (the "Home" jump target). */
  home: string
  /** Absolute path of the parent directory; null at a filesystem root. */
  parent: string | null
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target.
   */
  crumbs: FsEntry[]
  /** Direct children, directories first then files, name-sorted. */
  entries: FsEntry[]
  /** True when the backend cut `entries` at the complete-result bound. */
  truncated: boolean
}

/** Wire error shape every endpoint shares. */
export interface FsError {
  code: string
  message: string
}

/** Listing bound; beyond this the backend stops and sets `truncated`. */
export const MAX_ENTRIES = 2000

/** Text preview byte cap applied on the host (client may ask for less). */
export const MAX_TEXT_BYTES = 300_000

/**
 * Breadcrumb chain for an absolute path, from the filesystem root to the
 * directory itself (inclusive). Root crumb carries the root spelling as its
 * name (`/` on POSIX, `C:\` on Windows).
 */
export function buildCrumbs(dir: string): FsEntry[] {
  const parsed = parse(dir)
  const root = parsed.root
  if (!root) return []
  const crumbs: FsEntry[] = [{ name: root, path: root, kind: 'dir', size: 0, mtimeMs: 0, hidden: false }]
  if (dir === root) return crumbs
  const rest = dir.slice(root.length)
  let acc = root
  for (const segment of rest.split(sep)) {
    if (!segment) continue
    acc = join(acc, segment)
    crumbs.push({ name: segment, path: acc, kind: 'dir', size: 0, mtimeMs: 0, hidden: false })
  }
  return crumbs
}

/** Classify one readdir dirent, following symlinks for kind/size. */
async function entryOf(dir: string, name: string): Promise<FsEntry | null> {
  const path = join(dir, name)
  const hidden = name.startsWith('.')
  try {
    const info = await stat(path) // follows symlinks
    return {
      name,
      path,
      kind: info.isDirectory() ? 'dir' : 'file',
      size: info.isDirectory() ? 0 : info.size,
      mtimeMs: info.mtimeMs,
      hidden,
    }
  } catch {
    // Unreadable / broken symlink: surface as a zero-size file row so the
    // user can still see it exists; preview/open will report the error.
    return { name, path, kind: 'file', size: 0, mtimeMs: 0, hidden }
  }
}

/**
 * List one directory level. Throws an {@link FsError}-shaped object for
 * missing (`ENOENT`), non-directory (`ENOTDIR`) and unreadable (`EACCES`)
 * targets, mirroring the official `directory-unreadable` business code.
 */
export async function listLevel(dir: string): Promise<FsListing> {
  if (!isAbsolute(dir)) throw fsError('invalid-path', `not an absolute path: ${dir}`)
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw fsErrorFrom(error)
  }
  const entries: FsEntry[] = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    // Symlinks are followed by entryOf's stat; every other dirent is direct.
    if (dirent.isDirectory() || dirent.isFile() || dirent.isSymbolicLink()) {
      const row = await entryOf(dir, dirent.name)
      if (row) entries.push(row)
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true })
  })
  return {
    path: dir,
    home: homedir(),
    parent: dirname(dir) === dir ? null : dirname(dir),
    crumbs: buildCrumbs(dir),
    entries,
    truncated,
  }
}

export interface TextHead {
  /** True when the file is not utf-8 text (NUL byte sniff) or unreadable. */
  kind: 'text' | 'binary' | 'empty' | 'missing'
  /** Bytes read before any cap. */
  size: number
  /** True when the file is longer than the returned head. */
  truncated: boolean
  /** utf-8 decoded head (kind === 'text' only). */
  text?: string
  /** Present only on failure (kind === 'missing'). */
  error?: FsError
}

const BINARY_SNIFF = 4096

/**
 * Read the utf-8 head of a file for preview. Never reads past `maxBytes`
 * from the file; a file whose head contains a NUL byte is reported binary.
 */
export async function readTextHead(path: string, maxBytes: number): Promise<TextHead> {
  if (!isAbsolute(path)) return { kind: 'missing', size: 0, truncated: false, error: fsError('invalid-path', `not an absolute path: ${path}`) }
  let handle
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    if (info.isDirectory()) return { kind: 'missing', size: 0, truncated: false, error: fsError('ENOTDIR', 'path is a directory') }
    const want = Math.min(maxBytes, info.size)
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const chunk = await handle.read(buffer, read, want - read, read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    const head = buffer.subarray(0, Math.min(BINARY_SNIFF, read))
    if (read === 0) return { kind: 'empty', size: 0, truncated: false }
    if (head.includes(0)) return { kind: 'binary', size: info.size, truncated: info.size > read }
    return { kind: 'text', size: info.size, truncated: info.size > read, text: buffer.subarray(0, read).toString('utf8') }
  } catch (error) {
    return { kind: 'missing', size: 0, truncated: false, error: fsErrorFrom(error) }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Build an FsError for the client. */
export function fsError(code: string, message: string): FsError {
  return { code, message }
}

/** Map a thrown value to the wire shape with an HTTP-ish code. */
export function fsErrorFrom(error: unknown): FsError {
  const raw = error as { code?: unknown; message?: unknown }
  // Already wire-shaped (our own FsError) — pass through verbatim.
  if (typeof raw.code === 'string' && typeof raw.message === 'string') return fsError(raw.code, raw.message)
  const code = typeof raw.code === 'string' ? raw.code : 'EIO'
  const message = typeof raw.message === 'string' ? raw.message : String(error)
  if (code === 'ENOENT') return fsError('ENOENT', message)
  if (code === 'ENOTDIR') return fsError('ENOTDIR', message)
  if (code === 'EACCES' || code === 'EPERM') return fsError('EACCES', message)
  return fsError('EIO', message)
}

/** Extension → content type for the raw byte endpoint. */
export function contentTypeOf(path: string): string {
  const ext = basename(path).toLowerCase().split('.').pop() ?? ''
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
  }
  return table[ext] ?? 'application/octet-stream'
}

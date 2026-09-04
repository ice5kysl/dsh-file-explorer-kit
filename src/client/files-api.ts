/**
 * dsh-file-explorer — browser-side fetch client for the host /dsh-files
 * surface (same-origin, mirror of src/host/fs-server.ts wire shapes).
 *
 * The host routes live on the same web server that serves the GUI, so a
 * plain same-origin `fetch` works without extra credentials — identical to
 * how the official client talks to `/api`.
 *
 * @module dsh-file-explorer/files-api
 */

export type EntryKind = 'dir' | 'file'

export interface FsEntry {
  name: string
  path: string
  kind: EntryKind
  size: number
  mtimeMs: number
  hidden: boolean
}

export interface FsListing {
  path: string
  home: string
  parent: string | null
  crumbs: FsEntry[]
  entries: FsEntry[]
  truncated: boolean
}

export interface FsError {
  code: string
  message: string
}

export interface ListResponse {
  ok: true
  path: string
  home: string
  parent: string | null
  crumbs: FsEntry[]
  entries: FsEntry[]
  truncated: boolean
}

export interface TextResponse {
  ok: true
  path: string
  kind: 'text' | 'binary' | 'empty'
  size: number
  truncated: boolean
  text?: string
}

export class ApiError extends Error {
  readonly code: string
  constructor(error: FsError) {
    super(error.message)
    this.code = error.code
  }
}

async function getJson<T>(query: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/dsh-files/${query}`, { headers: { accept: 'application/json' } })
  } catch {
    throw new ApiError({ code: 'network', message: '无法连接本机 dsh web 服务（/dsh-files 不可达）' })
  }
  let body: { ok?: boolean; error?: FsError } | null = null
  try {
    body = await response.json()
  } catch {
    // non-JSON body (e.g. the SPA fallback HTML) — treat as endpoint missing
  }
  if (!response.ok || body === null || body.ok !== true) {
    const error = body?.error ?? { code: 'http', message: `HTTP ${response.status}` }
    throw new ApiError(error)
  }
  return body as T
}

/** List one absolute directory path. */
export function fetchList(path: string): Promise<ListResponse> {
  return getJson<ListResponse>(`list?path=${encodeURIComponent(path)}`)
}

/** Read a text preview head (server caps the byte count). */
export function fetchText(path: string, maxBytes = 300_000): Promise<TextResponse> {
  return getJson<TextResponse>(`text?path=${encodeURIComponent(path)}&maxBytes=${maxBytes}`)
}

/** Raw byte URL for an <img> preview (same-origin). */
export function rawUrl(path: string): string {
  return `/dsh-files/raw?path=${encodeURIComponent(path)}`
}

/** Host account home directory. */
export async function fetchHome(): Promise<string> {
  const response = await getJson<{ ok: true; home: string }>('home')
  return response.home
}

/** Human byte size, e.g. `1.2 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** Short date-time for a file row, e.g. `2024-09-04 16:42`. */
export function formatMtime(mtimeMs: number): string {
  if (!mtimeMs) return ''
  const date = new Date(mtimeMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'py', 'rb', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  'xml', 'svg', 'graphql', 'proto', 'dockerfile', 'makefile', 'gitignore', 'env', 'editorconfig', 'properties',
])

export interface FileKind {
  kind: 'image' | 'text' | 'other'
  ext: string
}

/** Classify a file name for the preview strategy (extension-based). */
export function classifyFile(name: string): FileKind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot < 0 ? lower : lower.slice(dot + 1)
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', ext }
  if (TEXT_EXTENSIONS.has(ext) || ext === '') return { kind: 'text', ext }
  return { kind: 'other', ext }
}

/**
 * Icon glyph id for one entry row (rendered as an SVG by icons.tsx; kept
 * here as a pure string classifier so files-api stays framework-free).
 */
export type EntryGlyphId = 'dir' | 'image' | 'markdown' | 'config' | 'code' | 'text' | 'binary'

/** Row glyph id for an entry. */
export function entryGlyph(entry: FsEntry): EntryGlyphId {
  if (entry.kind === 'dir') return 'dir'
  const { kind, ext } = classifyFile(entry.name)
  if (kind === 'image') return 'image'
  if (kind === 'text') {
    if (['md', 'markdown'].includes(ext)) return 'markdown'
    if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return 'config'
    if (['go', 'ts', 'tsx', 'js', 'py', 'rs', 'java', 'c', 'cpp', 'sh'].includes(ext)) return 'code'
    return 'text'
  }
  return 'binary'
}

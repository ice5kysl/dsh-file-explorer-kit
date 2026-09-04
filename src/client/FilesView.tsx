/**
 * dsh-file-explorer — the「文件」session view tab (browser face).
 *
 * Registers into the official `conversation.view` list slot (session scope),
 * so the session header grows a third tab — 对话 | 轨迹 | 文件 — right after
 * the shipped chat and trajectory entries. While the tab is active the
 * session body shows a Finder-style browser:
 *
 * - root jump chips (this session's workspace / registered workspaces /
 *   home) + breadcrumbs + absolute-path jump box,
 * - a current-folder listing (dirs first, size + mtime), hidden-file toggle,
 *   auto-refresh while the tab is focused (the agent keeps writing files),
 * - a preview pane: images inline, markdown rendered by default with a
 *   预览/Raw 切换 (sanitized via DOMPurify), other text with line numbers
 *   (capped), PDF inline, binary files offer copy-path / open-in-Finder.
 *
 * The view unmounts when the user switches tab or session; the last browsed
 * directory per session is remembered in memory (see browse-memory.ts) so a
 * remount restores the position. All data flows come from the host
 * `/dsh-files` surface; the client never joins path segments itself.
 *
 * @module dsh-file-explorer/files-view
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  ApiError,
  classifyFile,
  entryIcon,
  fetchHome,
  fetchList,
  fetchText,
  formatMtime,
  formatSize,
  rawUrl,
  type FsEntry,
  type FsListing,
  type TextResponse,
} from './files-api.ts'
import { browseMemoryGet, browseMemorySet } from './browse-memory.ts'
import { canOpenPath, openPathExternal } from './actions.ts'

/** Selector-shaped hooks the shell's standard kit passes to session views. */
export interface FilesViewProps {
  sessionId?: string
  useSessions?: <T>(selector: (state: any) => T) => T
  useWorkspaces?: <T>(selector: (state: any) => T) => T
}

/** Workspace list row read off the framework feed (loosely typed). */
interface WorkspaceRowLike {
  workspaceId?: string
  title?: string
  path?: string
}

type LoadState = 'idle' | 'loading' | 'error'

interface PreviewState {
  kind: 'image' | 'pdf' | 'markdown' | 'text' | 'binary' | 'empty' | 'error'
  entry: FsEntry
  url?: string
  text?: string
  /** DOMPurify-sanitized markdown HTML (kind 'markdown' only). */
  html?: string
  truncated?: boolean
  error?: string
}

/** Markdown render mode chosen by the user. */
type MarkdownViewMode = 'preview' | 'raw'

const TEXT_PREVIEW_BYTES = 300_000
const MAX_TEXT_LINES = 4000
const REFRESH_MS = 3000
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

export function FilesView(props: FilesViewProps): JSX.Element | null {
  const { sessionId, useSessions, useWorkspaces } = props
  const memoryKey = sessionId ?? 'files-view'

  // ── state (path restores from per-session memory on remount) ─────────────
  const [path, setPath] = useState<string | undefined>(() => browseMemoryGet(memoryKey))
  const [listing, setListing] = useState<FsListing | undefined>(undefined)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadError, setLoadError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<FsEntry | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)
  const [jumpInput, setJumpInput] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [preview, setPreview] = useState<PreviewState | undefined>(undefined)
  /** 预览/Raw 切换（仅 markdown 文件；默认渲染预览）。 */
  const [mdView, setMdView] = useState<MarkdownViewMode>('preview')

  // Standard-kit hooks may be absent at first render — treat as optional.
  const sessionsState = typeof useSessions === 'function' ? useSessions((state: any) => state) : undefined
  const workspacesState = typeof useWorkspaces === 'function' ? useWorkspaces((state: any) => state) : undefined

  const listElRef = useRef<HTMLDivElement>(null)

  // ── helpers reading framework feeds (pure) ───────────────────────────────
  function computeDefaultRoot(): string | undefined {
    if (sessionId) {
      const cwd: string | undefined = sessionsState?.byId?.[sessionId]?.cwd
      if (cwd) return cwd
    }
    const sid: string | undefined = sessionId ?? sessionsState?.current
    if (sid) {
      const cwd: string | undefined = sessionsState?.byId?.[sid]?.cwd
      if (cwd) return cwd
    }
    const items: readonly WorkspaceRowLike[] = Array.isArray(workspacesState?.items) ? workspacesState.items : []
    const recentId: string | undefined = workspacesState?.recentWorkspaceId
    if (recentId) {
      const recent = items.find((item) => item.workspaceId === recentId)
      if (recent?.path) return recent.path
    }
    const first = items[0]
    if (first?.path) return first.path
    return undefined
  }

  // ── resolve the root once per mount (memory → session cwd → home) ────────
  useEffect(() => {
    if (path !== undefined) return
    let cancelled = false
    const remembered = browseMemoryGet(memoryKey)
    if (remembered) {
      setPath(remembered)
      return
    }
    const root = computeDefaultRoot()
    if (root) {
      setPath(root)
      return
    }
    fetchHome()
      .then((home) => {
        if (!cancelled) setPath(home)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadState('error')
        setLoadError(`无法确定起始目录：${messageOf(error)}`)
      })
    return () => {
      cancelled = true
    }
    // computeDefaultRoot is recreated per render; this effect runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── remember the last browsed directory per session ──────────────────────
  useEffect(() => {
    if (path !== undefined) browseMemorySet(memoryKey, path)
  }, [path, memoryKey])

  // ── load the listing for the current path (manual + auto refresh) ────────
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoadState('loading')
    setLoadError('')
    fetchList(path)
      .then((res) => {
        if (cancelled) return
        setListing(res)
        setLoadState('idle')
        setSelected(undefined)
        setCursor(0)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadState('error')
        setLoadError(messageOf(error))
      })
    return () => {
      cancelled = true
    }
  }, [path, refreshTick])

  // Auto-refresh while the tab is mounted and the page has focus (the agent
  // writes files in the background while you browse).
  const loadStateRef = useRef({ loading: false })
  loadStateRef.current = { loading: loadState === 'loading' }
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hasFocus() && !loadStateRef.current.loading) setRefreshTick((tick) => tick + 1)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  // ── preview for the selected file ────────────────────────────────────────
  useEffect(() => {
    const entry = selected
    setMdView('preview')
    if (!entry || entry.kind !== 'file') {
      setPreview(undefined)
      return
    }
    let cancelled = false
    const { kind, ext } = classifyFile(entry.name)
    if (kind === 'image') {
      setPreview({ kind: 'image', entry, url: rawUrl(entry.path) })
      return
    }
    if (ext === 'pdf') {
      setPreview({ kind: 'pdf', entry, url: rawUrl(entry.path) })
      return
    }
    if (kind === 'other') {
      setPreview({ kind: 'binary', entry })
      return
    }
    setPreview(undefined)
    fetchText(entry.path, TEXT_PREVIEW_BYTES)
      .then((result: TextResponse) => {
        if (cancelled) return
        if (result.kind === 'empty') setPreview({ kind: 'empty', entry })
        else if (result.kind === 'binary') setPreview({ kind: 'binary', entry })
        else if (isMarkdown(ext)) {
          const html = renderMarkdownSafe(result.text ?? '')
          setPreview(
            html
              ? { kind: 'markdown', entry, text: result.text, html, truncated: result.truncated }
              : { kind: 'text', entry, text: result.text, truncated: result.truncated },
          )
        } else {
          setPreview({ kind: 'text', entry, text: result.text, truncated: result.truncated })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreview({ kind: 'error', entry, error: messageOf(error) })
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  // ── visible rows (dirs first, hidden filtered on demand) ─────────────────
  const entries = listing?.entries ?? []
  const visible = showHidden ? entries : entries.filter((entry) => !entry.hidden)

  // Clamp the keyboard cursor when the visible set shrinks.
  useEffect(() => {
    const max = Math.max(0, visible.length - 1)
    if (visible.length > 0 && cursor > max) setCursor(max)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, cursor])

  const currentPath = path ?? ''
  const activeEntry = visible[cursor]

  function navigate(target: string): void {
    setPath(target)
    setJumpInput('')
    setActionNote('')
  }

  function activateEntry(entry: FsEntry): void {
    setActionNote('')
    if (entry.kind === 'dir') navigate(entry.path)
    else {
      setSelected(entry)
      const index = visible.indexOf(entry)
      if (index >= 0) setCursor(index)
    }
  }

  function handleJump(): void {
    const target = jumpInput.trim()
    if (!target) return
    const looksAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
    if (!looksAbsolute) {
      setActionNote('请输入绝对路径（如 /Users/… 或 C:\\…）')
      return
    }
    navigate(target)
  }

  function copyPath(entry: FsEntry): void {
    navigator.clipboard?.writeText(entry.path)
      .then(() => setActionNote(`已复制：${entry.path}`))
      .catch(() => setActionNote('复制失败'))
  }

  function openInFinder(entry: FsEntry): void {
    setActionNote('正在打开…')
    openPathExternal(entry.path)
      .then(() => setActionNote('已在系统文件管理器中打开'))
      .catch((error: unknown) => setActionNote(messageOf(error)))
  }

  const crumbs = listing?.crumbs ?? []
  const home = listing?.home

  return (
    <div style={styles.root}>
      {/* ── header: 快速跳转行 + 面包屑/工具行（固定行高，内容只横向滚动） ── */}
      <div style={styles.header}>
        <div style={styles.lineRow}>
          <div style={styles.roots}>
            <RootChip label="🏠 主目录" onClick={() => home && navigate(home)} disabled={!home} />
            {quickRootChips(workspacesState, sessionsState, sessionId, navigate)}
          </div>
          <div style={styles.lineSpacer} />
          <button
            type="button"
            style={{ ...styles.toolButton, ...(showHidden ? styles.toolButtonActive : {}) }}
            onClick={() => setShowHidden((value) => !value)}
            title="显示/隐藏点开头文件（.git、node_modules 等）"
          >
            {showHidden ? '隐藏点文件' : '显示隐藏'}
          </button>
          <button type="button" style={styles.toolButton} onClick={() => setRefreshTick((tick) => tick + 1)} title="刷新当前目录">
            ⟳ 刷新
          </button>
        </div>
        <div style={styles.lineRow}>
          <div style={styles.crumbs}>
            {crumbs.length === 0 && <span style={styles.crumbPath}>{currentPath || '…'}</span>}
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} style={styles.crumbWrap}>
                {index > 0 && <span style={styles.crumbSep}>/</span>}
                <button
                  type="button"
                  style={styles.crumb}
                  onClick={() => navigate(crumb.path)}
                  title={crumb.path}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
          <div style={styles.lineSpacer} />
          <input
            style={styles.jumpInput}
            placeholder="绝对路径…"
            value={jumpInput}
            onChange={(event) => setJumpInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleJump()
            }}
            aria-label="跳转路径"
          />
          <button type="button" style={styles.toolButton} onClick={handleJump} title="跳转到输入的绝对路径">
            跳转
          </button>
        </div>
      </div>

      {/* ── body: listing + preview ───────────────────────────────────── */}
      <div style={styles.body}>
        <div
          ref={listElRef}
          style={styles.listPane}
          role="listbox"
          aria-label="目录与文件"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const max = visible.length - 1
              if (max < 0) return
              const delta = event.key === 'ArrowDown' ? 1 : -1
              const next = Math.max(0, Math.min(cursor + delta, max))
              setCursor(next)
              const entry = visible[next]
              if (entry && entry.kind === 'file') setSelected(entry)
            } else if (event.key === 'Enter' && activeEntry) {
              event.preventDefault()
              activateEntry(activeEntry)
            } else if (event.key === 'Backspace' && listing?.parent) {
              event.preventDefault()
              navigate(listing.parent)
            }
          }}
        >
          <div style={styles.listStatus}>
            {loadState === 'loading' && <span style={styles.statusText}>加载中…</span>}
            {loadState === 'error' && (
              <span style={{ ...styles.statusText, color: '#c0392b' }}>{loadError}（可点 ⟳ 重试）</span>
            )}
            {loadState === 'idle' && visible.length === 0 && (
              <span style={styles.statusText}>{listing?.truncated ? '目录过大，仅显示前 2000 项' : '（空目录）'}</span>
            )}
            {loadState === 'idle' && visible.length > 0 && listing?.truncated && (
              <span style={styles.statusText}>共 {entries.length}+ 项（仅显示前 2000）</span>
            )}
          </div>
          <div style={styles.listInner}>
            {visible.map((entry) => {
              const index = visible.indexOf(entry)
              const isActive = index === cursor
              const isSelectedFile = selected?.path === entry.path && entry.kind === 'file'
              return (
                <div
                  key={entry.path}
                  role="option"
                  aria-selected={isActive || isSelectedFile}
                  style={{
                    ...styles.row,
                    ...(isActive ? styles.rowActive : {}),
                    ...(isSelectedFile ? styles.rowSelectedFile : {}),
                  }}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => activateEntry(entry)}
                  onDoubleClick={() => {
                    if (entry.kind === 'dir') navigate(entry.path)
                  }}
                  title={entry.path}
                >
                  <span style={styles.rowIcon}>{entryIcon(entry)}</span>
                  <span style={styles.rowName}>{entry.name}</span>
                  <span style={styles.rowMeta}>
                    {entry.kind === 'dir' ? '目录' : formatSize(entry.size)}
                  </span>
                  <span style={styles.rowMeta2}>{formatMtime(entry.mtimeMs)}</span>
                  {entry.kind === 'file' && (
                    <button
                      type="button"
                      style={styles.miniAction}
                      title="复制路径"
                      onClick={(event) => {
                        event.stopPropagation()
                        copyPath(entry)
                      }}
                    >
                      ⧉
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div style={styles.listFooter}>
            <span style={styles.statusText}>↑↓ 选择 · ↵ 打开 · ⌫ 上级 · 切回「对话」tab 继续聊天</span>
          </div>
        </div>

        {/* preview pane */}
        <div style={styles.previewPane}>
          {preview && (
            <div style={styles.previewHeader}>
              <span style={styles.previewName} title={preview.entry.path}>
                {entryIcon(preview.entry)} {preview.entry.name}
              </span>
              <span style={styles.previewMeta}>{formatSize(preview.entry.size)}</span>
              {preview.kind === 'markdown' && (
                <span style={styles.segmented} role="group" aria-label="预览模式">
                  <button
                    type="button"
                    style={{ ...styles.segButton, ...(mdView === 'preview' ? styles.segButtonActive : {}) }}
                    onClick={() => setMdView('preview')}
                    title="渲染后的 Markdown"
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    style={{ ...styles.segButton, ...(mdView === 'raw' ? styles.segButtonActive : {}) }}
                    onClick={() => setMdView('raw')}
                    title="带行号的原始 Markdown 文本"
                  >
                    Raw
                  </button>
                </span>
              )}
              <span style={styles.previewSpacer} />
              {preview.kind !== 'error' && (
                <button type="button" style={styles.previewAction} onClick={() => copyPath(preview.entry)}>
                  复制路径
                </button>
              )}
              {preview.kind !== 'error' && canOpenPath() && (
                <button type="button" style={styles.previewAction} onClick={() => openInFinder(preview.entry)}>
                  在 Finder 中打开
                </button>
              )}
            </div>
          )}
          {actionNote && <div style={styles.actionNote}>{actionNote}</div>}
          <div style={styles.previewBody}>
            {!selected && (
              <div style={styles.previewEmpty}>
                <div style={styles.previewEmptyIcon}>👀</div>
                <div>选择左侧文件预览内容</div>
                <div style={styles.previewEmptyHint}>当前目录：{currentPath}</div>
              </div>
            )}
            {preview?.kind === 'image' && preview.url && (
              <img src={preview.url} alt={preview.entry.name} style={styles.image} />
            )}
            {preview?.kind === 'pdf' && preview.url && (
              <iframe src={preview.url} title={preview.entry.name} style={styles.pdfFrame} />
            )}
            {preview?.kind === 'markdown' && mdView === 'preview' && (
              <MarkdownPreview html={preview.html ?? ''} truncated={Boolean(preview.truncated)} />
            )}
            {preview?.kind === 'markdown' && mdView === 'raw' && (
              <TextView text={preview.text ?? ''} truncated={Boolean(preview.truncated)} />
            )}
            {preview?.kind === 'text' && <TextView text={preview.text ?? ''} truncated={Boolean(preview.truncated)} />}
            {(preview?.kind === 'binary' || preview?.kind === 'empty') && (
              <div style={styles.previewEmpty}>
                <div style={styles.previewEmptyIcon}>{preview.kind === 'empty' ? '📄' : '🔒'}</div>
                <div>{preview.kind === 'empty' ? '空文件' : '二进制文件，无法文本预览'}</div>
                <div style={styles.previewEmptyHint}>
                  可用「在 Finder 中打开」查看，或复制路径后在会话里让模型读取。
                </div>
              </div>
            )}
            {preview?.kind === 'error' && (
              <div style={styles.previewEmpty}>
                <div style={styles.previewEmptyIcon}>⚠️</div>
                <div>{preview.error ?? '预览失败'}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** True for markdown extensions whose content can be rendered as HTML. */
function isMarkdown(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext)
}

/**
 * Markdown → sanitized HTML. Any parse failure returns undefined and the
 * caller falls back to the raw text view. Raw HTML in the source (including
 * script / iframe / event handlers / javascript: URLs) is stripped by
 * DOMPurify before it ever reaches dangerouslySetInnerHTML.
 */
function renderMarkdownSafe(text: string): string | undefined {
  try {
    const html = marked.parse(text, { gfm: true, breaks: false }) as string
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  } catch {
    return undefined
  }
}

/** One quick-root chip in the header. */
function RootChip(props: { label: string; onClick: () => void; disabled?: boolean }): JSX.Element | null {
  const { label, onClick, disabled } = props
  if (disabled) return null
  return (
    <button type="button" style={styles.rootChip} onClick={onClick} title={label}>
      {label}
    </button>
  )
}

/**
 * Quick-root chips for the workspace-root jump row: registered workspaces
 * (deduped against the current session workspace, capped for width) plus the
 * session workspace itself when it is not one of them. 「🏠 主目录」is rendered
 * separately before these.
 */
function quickRootChips(
  workspacesState: any,
  sessionsState: any,
  sessionId: string | undefined,
  navigate: (path: string) => void,
): JSX.Element[] {
  const items: readonly WorkspaceRowLike[] = Array.isArray(workspacesState?.items) ? workspacesState.items : []
  const sid: string | undefined = sessionId ?? sessionsState?.current
  const sessionCwd: string | undefined = sid ? sessionsState?.byId?.[sid]?.cwd : undefined
  const chips: JSX.Element[] = []
  const covered = new Set<string>()
  for (const item of items) {
    if (!item.path) continue
    covered.add(item.path)
    if (chips.length >= 8) continue
    chips.push(
      <RootChip
        key={String(item.workspaceId)}
        label={`📂 ${item.title ?? '?'}`}
        onClick={() => navigate(item.path as string)}
      />,
    )
  }
  if (sessionCwd && !covered.has(sessionCwd)) {
    const title = (sid ? sessionsState?.byId?.[sid]?.displayTitle : undefined) ?? '当前会话'
    chips.push(
      <RootChip key={`session-${sid ?? ''}`} label={`💬 ${String(title).slice(0, 30)}`} onClick={() => navigate(sessionCwd)} />,
    )
  }
  return chips
}

/** Text preview with line numbers. */
function TextView(props: { text: string; truncated: boolean }): JSX.Element {
  const lines = props.text.split(/\r?\n/)
  const shown = lines.length > MAX_TEXT_LINES ? lines.slice(0, MAX_TEXT_LINES) : lines
  return (
    <div style={styles.textWrap}>
      {props.truncated && (
        <div style={styles.textTruncatedNote}>⚠️ 文件较大，仅预览前 {TEXT_PREVIEW_BYTES / 1024} KB</div>
      )}
      {lines.length > MAX_TEXT_LINES && (
        <div style={styles.textTruncatedNote}>⚠️ 内容过长，仅显示前 {MAX_TEXT_LINES} 行</div>
      )}
      <pre style={styles.textPre}>
        {shown.map((line, index) => (
          <div key={index} style={styles.textLine}>
            <span style={styles.textLineNo}>{index + 1}</span>
            <span style={styles.textLineBody}>{line || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

/** Rendered markdown preview (already sanitized HTML) with scoped typography. */
function MarkdownPreview(props: { html: string; truncated: boolean }): JSX.Element {
  return (
    <div style={styles.mdWrap}>
      {props.truncated && (
        <div style={styles.textTruncatedNote}>⚠️ 文件较大，仅渲染前 {TEXT_PREVIEW_BYTES / 1024} KB</div>
      )}
      <style>{MD_CSS}</style>
      <div className="dfe-md" dangerouslySetInnerHTML={{ __html: props.html }} />
    </div>
  )
}

/**
 * Scoped typography for rendered markdown (`.dfe-md ...`). Colors match the
 * plugin's light inline palette; the container scrolls inside the preview pane.
 */
const MD_CSS = `
.dfe-md { padding: 14px 18px 24px; font-size: 14px; line-height: 1.7; color: #2b3446; overflow-wrap: break-word; }
.dfe-md > :first-child { margin-top: 0; }
.dfe-md > :last-child { margin-bottom: 0; }
.dfe-md h1, .dfe-md h2, .dfe-md h3, .dfe-md h4, .dfe-md h5, .dfe-md h6 { margin: 1.2em 0 0.5em; line-height: 1.35; color: #1c2333; font-weight: 650; }
.dfe-md h1 { font-size: 22px; border-bottom: 1px solid rgba(28,35,51,0.10); padding-bottom: 0.3em; }
.dfe-md h2 { font-size: 18px; border-bottom: 1px solid rgba(28,35,51,0.08); padding-bottom: 0.25em; }
.dfe-md h3 { font-size: 16px; }
.dfe-md h4, .dfe-md h5, .dfe-md h6 { font-size: 14px; }
.dfe-md p { margin: 0.6em 0; }
.dfe-md a { color: #2d66f7; text-decoration: none; }
.dfe-md a:hover { text-decoration: underline; }
.dfe-md ul, .dfe-md ol { margin: 0.6em 0; padding-left: 1.7em; }
.dfe-md li { margin: 0.2em 0; }
.dfe-md li > ul, .dfe-md li > ol { margin: 0.2em 0; }
.dfe-md blockquote { margin: 0.8em 0; padding: 2px 14px; border-left: 3px solid rgba(45,102,247,0.45); color: #5a6478; background: rgba(28,35,51,0.03); border-radius: 0 6px 6px 0; }
.dfe-md code { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; background: rgba(28,35,51,0.07); padding: 1px 5px; border-radius: 5px; color: #b8336a; }
.dfe-md pre { margin: 0.8em 0; background: #f5f7fa; border: 1px solid rgba(28,35,51,0.08); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.dfe-md pre code { background: transparent; padding: 0; color: #2b3446; font-size: 12.5px; line-height: 1.6; }
.dfe-md table { border-collapse: collapse; margin: 0.8em 0; display: block; max-width: 100%; overflow-x: auto; }
.dfe-md th, .dfe-md td { border: 1px solid rgba(28,35,51,0.14); padding: 5px 10px; font-size: 13px; }
.dfe-md th { background: #f2f4f8; font-weight: 600; }
.dfe-md hr { border: none; border-top: 1px solid rgba(28,35,51,0.12); margin: 1.2em 0; }
.dfe-md img { max-width: 100%; border-radius: 8px; }
.dfe-md .dfe-md-tasklist { list-style: none; padding-left: 0.4em; }
`

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    color: '#1c2333',
    overflow: 'hidden',
  },
  header: {
    borderBottom: '1px solid rgba(28, 35, 51, 0.10)',
    padding: '8px 12px 6px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    flexShrink: 0,
    overflow: 'hidden',
  },
  lineRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 26,
    minWidth: 0,
    flexShrink: 0,
  },
  lineSpacer: {
    width: 6,
    flexShrink: 0,
  },
  // 单行、固定高度；overflow-y 必须显式 hidden（visible+auto 会被规范解析成
  // 双轴 auto，导致滚动条把行撑高变形）。
  roots: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
    height: 26,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
  },
  rootChip: {
    fontSize: 12,
    lineHeight: '22px',
    height: 22,
    padding: '0 10px',
    borderRadius: 11,
    border: '1px solid rgba(28, 35, 51, 0.14)',
    background: '#f7f8fa',
    color: '#3c4659',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 190,
    flexShrink: 0,
  },
  jumpInput: {
    width: 170,
    boxSizing: 'border-box',
    height: 24,
    padding: '0 9px',
    fontSize: 12,
    borderRadius: 7,
    border: '1px solid rgba(28, 35, 51, 0.18)',
    outline: 'none',
    color: 'inherit',
    background: '#ffffff',
    flexShrink: 0,
  },
  toolButton: {
    flexShrink: 0,
    fontSize: 12,
    lineHeight: '22px',
    height: 22,
    padding: '0 9px',
    borderRadius: 7,
    border: '1px solid rgba(28, 35, 51, 0.16)',
    background: '#ffffff',
    color: '#3c4659',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  toolButtonActive: {
    background: 'rgba(45, 102, 247, 0.10)',
    borderColor: 'rgba(45, 102, 247, 0.5)',
    color: '#2d66f7',
  },
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    height: 26,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    gap: 2,
    fontSize: 12,
    color: '#8a93a6',
  },
  crumbPath: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: '#5a6478',
  },
  crumbWrap: {
    display: 'flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  crumbSep: {
    margin: '0 4px',
    color: '#c0c6d2',
  },
  crumb: {
    border: 'none',
    background: 'transparent',
    color: '#5a6478',
    fontSize: 12,
    cursor: 'pointer',
    padding: '2px 2px',
    borderRadius: 4,
    whiteSpace: 'nowrap',
  },
  body: {
    flex: 1,
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  listPane: {
    width: 360,
    flexShrink: 0,
    borderRight: '1px solid rgba(28, 35, 51, 0.10)',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    outline: 'none',
  },
  listStatus: {
    padding: '6px 12px 0',
    fontSize: 11,
    color: '#8a93a6',
  },
  statusText: {
    fontSize: 11,
    color: '#8a93a6',
  },
  listInner: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 6px 6px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 8px',
    borderRadius: 7,
    cursor: 'pointer',
    fontSize: 13,
  },
  rowActive: {
    background: 'rgba(45, 102, 247, 0.10)',
  },
  rowSelectedFile: {
    background: 'rgba(45, 102, 247, 0.06)',
  },
  rowIcon: {
    flexShrink: 0,
    fontSize: 13,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  rowMeta: {
    flexShrink: 0,
    fontSize: 11,
    color: '#8a93a6',
    minWidth: 48,
    textAlign: 'right',
  },
  rowMeta2: {
    flexShrink: 0,
    fontSize: 11,
    color: '#b4bac6',
    minWidth: 96,
    textAlign: 'right',
  },
  miniAction: {
    flexShrink: 0,
    border: 'none',
    background: 'transparent',
    color: '#8a93a6',
    cursor: 'pointer',
    fontSize: 12,
    padding: '0 2px',
    borderRadius: 4,
  },
  listFooter: {
    padding: '5px 12px',
    borderTop: '1px solid rgba(28, 35, 51, 0.08)',
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px',
    borderBottom: '1px solid rgba(28, 35, 51, 0.08)',
    minHeight: 36,
  },
  previewName: {
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewMeta: {
    fontSize: 11,
    color: '#8a93a6',
    whiteSpace: 'nowrap',
  },
  segmented: {
    display: 'inline-flex',
    borderRadius: 8,
    border: '1px solid rgba(28, 35, 51, 0.16)',
    overflow: 'hidden',
    flexShrink: 0,
  },
  segButton: {
    fontSize: 12,
    lineHeight: '22px',
    padding: '0 10px',
    border: 'none',
    background: '#ffffff',
    color: '#5a6478',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  segButtonActive: {
    background: 'rgba(45, 102, 247, 0.10)',
    color: '#2d66f7',
    fontWeight: 600,
  },
  mdWrap: {
    flex: 1,
    minHeight: 0,
  },
  previewSpacer: {
    flex: 1,
  },
  previewAction: {
    flexShrink: 0,
    fontSize: 12,
    padding: '2px 10px',
    borderRadius: 8,
    border: '1px solid rgba(28, 35, 51, 0.16)',
    background: '#ffffff',
    color: '#3c4659',
    cursor: 'pointer',
  },
  actionNote: {
    padding: '4px 14px',
    fontSize: 11,
    color: '#2d66f7',
    borderBottom: '1px solid rgba(28, 35, 51, 0.06)',
  },
  previewBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    background: '#fbfcfe',
  },
  previewEmpty: {
    margin: 'auto',
    textAlign: 'center',
    color: '#7a8499',
    fontSize: 13,
    padding: 24,
    lineHeight: 1.9,
  },
  previewEmptyIcon: {
    fontSize: 34,
    marginBottom: 6,
  },
  previewEmptyHint: {
    fontSize: 12,
    color: '#a2aab8',
    maxWidth: 360,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    margin: 'auto',
  },
  pdfFrame: {
    flex: 1,
    width: '100%',
    border: 'none',
  },
  textWrap: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  },
  textTruncatedNote: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    fontSize: 11,
    color: '#8a6d1a',
    background: '#fff7e0',
    borderBottom: '1px solid #f0e2b6',
    padding: '4px 12px',
  },
  textPre: {
    margin: 0,
    padding: '8px 0 20px',
    fontSize: 12,
    lineHeight: '18px',
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
  },
  textLine: {
    display: 'flex',
    whiteSpace: 'pre',
  },
  textLineNo: {
    minWidth: 52,
    textAlign: 'right',
    paddingRight: 12,
    color: '#b4bac6',
    userSelect: 'none',
    flexShrink: 0,
  },
  textLineBody: {
    color: '#2b3446',
    whiteSpace: 'pre',
  },
}

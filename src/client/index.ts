/**
 * dsh-file-explorer — browser (client) face.
 *
 * One registration on the official additive seam:
 *
 * `conversation.view` (list/session) — a「文件」view tab registered after the
 * shipped chat (order 0) and trajectory (order 10) tabs, so the session
 * header reads 对话 | 轨迹 | 文件. While the tab is active the session body
 * becomes the file browser; switching tabs or sessions unmounts it, and the
 * per-session last directory is remembered in memory for the next visit.
 *
 * The same Loader entry carries the host face (`lib/index.js`, the /dsh-files
 * routes), so this module ships as the package's `./client` export and only
 * ever runs in the browser cordis tree.
 *
 * @module dsh-file-explorer/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { setOpenPathImpl } from './actions.ts'
import { L } from './locale.ts'
import { FilesView } from './FilesView.tsx'

export const name = 'file-explorer'
export const inject = ['slots', 'workspaces'] as const

/** Minimal service faces this plugin consumes (typed locally at the boundary). */
interface SlotsLike {
  /** Run `cb` for the lifetime of the slot declaration (re-runs after redeclare). */
  inject(slot: string, cb: () => unknown): void
  /** Register one component into a declared slot. */
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface WorkspacesLike {
  /** Open a filesystem path with the Host OS default application. */
  openPath(path: string): Promise<void>
}

interface ClientCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  slots: SlotsLike
  workspaces: WorkspacesLike
}

export function apply(raw: Context): void {
  const ctx = raw as unknown as ClientCtxLike
  const log = ctx.logger('file-explorer:client')

  // The view's "在 Finder 中打开" action rides the official openPath
  // capability; slot components get no ctx, so stash the bound action here.
  setOpenPathImpl((path) => ctx.workspaces.openPath(path))

  // The「文件」view tab: order 20 renders right after trajectory (10); the
  // header tab strip lists conversation.view entries automatically, and the
  // body renders only the active entry (官方 `only: <active id>` 机制).
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'files',
        order: 20,
        label: () => L('文件', 'Files'),
      },
      FilesView,
    ),
  )

  log.info('File explorer registered as session view tab (对话 | 轨迹 | 文件)')
}

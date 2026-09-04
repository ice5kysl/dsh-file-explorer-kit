/**
 * dsh-file-explorer — shared open-in-host actions holder.
 *
 * `ctx.workspaces.openPath` (the official “open a filesystem path with the
 * Host OS default application” capability) lives on the client runtime face;
 * slot components receive no ctx, so `apply()` stashes the bound action here
 * and the panel calls it through {@link openPathExternal}.
 *
 * @module dsh-file-explorer/actions
 */

let openPathImpl: ((path: string) => Promise<void>) | undefined

/** Install the runtime's openPath action (called once from apply()). */
export function setOpenPathImpl(impl: (path: string) => Promise<void>): void {
  openPathImpl = impl
}

/** Whether this deployment can hand paths to a native desktop. */
export function canOpenPath(): boolean {
  return openPathImpl !== undefined
}

/**
 * Open a path with the Host OS default application (Finder / Explorer /
 * xdg-open hand-off). Rejects when the runtime lacks the capability.
 */
export function openPathExternal(path: string): Promise<void> {
  if (!openPathImpl) return Promise.reject(new Error('当前部署无法打开系统文件管理器'))
  return openPathImpl(path)
}

/**
 * dsh-file-explorer — per-session browse memory (browser face).
 *
 * The「文件」view tab unmounts whenever the user switches to 对话/轨迹 or to
 * another session, so this tiny module keeps the last browsed directory per
 * session id (in-memory only; nothing is persisted across page loads). A
 * remount of the same session restores its position instead of resetting to
 * the workspace root every time.
 *
 * @module dsh-file-explorer/browse-memory
 */

const memory = new Map<string, string>()

/** Last directory browsed for `key` (session id), if any. */
export function browseMemoryGet(key: string): string | undefined {
  return memory.get(key)
}

/** Remember the directory browsed for `key`. */
export function browseMemorySet(key: string, path: string): void {
  memory.set(key, path)
}

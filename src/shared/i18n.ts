/**
 * Shared locale plumbing for dsh-file-explorer.
 *
 * Pure helpers only — no `node` or `dom` globals here, so this module can be
 * imported from both the node and the browser side of the bundle and each
 * side supplies its own locale detection (currently only the browser client
 * face renders user-facing copy; see `src/client/locale.ts`).
 *
 * Supported locales: `zh` (简体中文) and `en` (English). Every user-facing
 * string is written in both languages at the call site:
 *
 *   L('中文原文', 'English original', { n: 3 })
 *
 * Placeholders use `{name}` and are interpolated by `localize`.
 *
 * @module dsh-file-explorer/i18n-core
 */

export type Locale = 'zh' | 'en'

export interface Vars {
  readonly [name: string]: string | number | undefined
}

/** Pick the localized template and substitute `{name}` placeholders. */
export function localize(locale: Locale, zh: string, en: string, vars?: Vars): string {
  const template = locale === 'zh' ? zh : en
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : raw,
  )
}

/** Normalize a raw tag ('zh-CN', 'en-US', …) to one of the supported locales. */
export function normalizeLocale(raw: string | undefined | null): Locale {
  const tag = (raw ?? '').toLowerCase()
  if (tag.startsWith('zh')) return 'zh'
  return 'en'
}

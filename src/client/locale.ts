/**
 * Browser-side (client) locale detection for dsh-file-explorer.
 *
 * Resolution order:
 *   1. persisted preference `dsh.file-explorer.locale` = `zh` | `en`
 *      (see `setLocalePreference`; the「文件」tab header carries a 中/EN
 *      toggle that writes this);
 *   2. `navigator.language(s)` starting with `zh` → Chinese;
 *   3. default: English.
 *
 * `L()` re-reads the current locale on every call, so UI re-renders after a
 * `setLocalePreference()` switch reflect the new language immediately.
 *
 * @module dsh-file-explorer/client-locale
 */

import { localize, normalizeLocale, type Locale, type Vars } from '../shared/i18n.ts'

export const LOCALE_STORAGE_KEY = 'dsh.file-explorer.locale'

let explicit: Locale | null = null

/** Resolve the effective locale for this browser context. */
export function detectLocale(): Locale {
  if (explicit) return explicit
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    // Storage unavailable (privacy mode etc.) — fall through to navigator.
  }
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const tags = nav?.languages && nav.languages.length > 0
    ? [...nav.languages]
    : nav?.language ? [nav.language] : []
  for (const tag of tags) {
    const locale = normalizeLocale(tag)
    if (locale === 'zh') return locale
  }
  return 'en'
}

/** Persist an explicit language preference (affects the whole browser). */
export function setLocalePreference(locale: Locale): void {
  explicit = locale
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Non-fatal: preference simply won't persist.
  }
}

/** Resolve the current locale again (used by the language toggle). */
export function getLocale(): Locale {
  return detectLocale()
}

/**
 * Localized string helper for browser-side copy.
 *
 * @param zh Chinese text (may contain `{name}` placeholders)
 * @param en English text (may contain `{name}` placeholders)
 * @param vars optional placeholder values
 */
export function L(zh: string, en: string, vars?: Vars): string {
  return localize(detectLocale(), zh, en, vars)
}

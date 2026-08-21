/**
 * Browser-half dictionaries: the plugin's locale namespace.
 *
 * P2 ships the data only; P3 registers it through `ctx.locale.register` in
 * the client apply and reads the tab label through the bound translator.
 * @module dsh-session-fork/src/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-session-fork'

/** The plugin dictionary key set (source of truth for both locales). */
export type ForkLocaleKey = 'view.branches'

/** Simplified Chinese dictionary. */
export const zh: Record<ForkLocaleKey, string> = {
  'view.branches': '分支',
}

/** English dictionary. */
export const en: Record<ForkLocaleKey, string> = {
  'view.branches': 'Branches',
}

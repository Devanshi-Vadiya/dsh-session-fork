/**
 * Browser-half dictionaries: the plugin's locale namespace, registered in
 * the client apply and read through the bound translator (tab label and
 * view states).
 * @module dsh-session-fork/src/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-session-fork'

/** The plugin dictionary key set (source of truth for both locales). */
export type ForkLocaleKey =
  | 'view.branches'
  | 'state.loading'
  | 'state.error'
  | 'state.empty'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The branches graph tab label and its states. */
    'dsh-session-fork': ForkLocaleKey
  }
}

/** Simplified Chinese dictionary. */
export const zh: Record<ForkLocaleKey, string> = {
  'view.branches': '分支',
  'state.loading': '加载分支图…',
  'state.error': '分支图加载失败',
  'state.empty': '还没有分支。试试 /branch create <name>',
}

/** English dictionary. */
export const en: Record<ForkLocaleKey, string> = {
  'view.branches': 'Branches',
  'state.loading': 'Loading branch graph…',
  'state.error': 'Failed to load the branch graph',
  'state.empty': 'No branches yet. Try /branch create <name>',
}

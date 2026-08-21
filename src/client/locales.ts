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
  | 'state.retry'
  | 'state.empty'
  | 'state.dangling'
  | 'events.loading'
  | 'events.error'
  | 'fork.title'
  | 'fork.description'
  | 'fork.placeholder'
  | 'fork.cancel'
  | 'fork.confirm'
  | 'fork.close'
  | 'fork.invalid'

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
  'state.retry': '重试',
  'state.empty': '还没有分支。试试 /branch create <name>',
  'state.dangling': '悬空分支(会话已缺失):',
  'events.loading': '加载事件…',
  'events.error': '事件加载失败:',
  'fork.title': 'Fork 到命名分支',
  'fork.description': '分支名将成为新会话的标题,且在本工作区内唯一。',
  'fork.placeholder': '分支名',
  'fork.cancel': '取消',
  'fork.confirm': 'Fork',
  'fork.close': '关闭',
  'fork.invalid': '无效的分支名:',
}

/** English dictionary. */
export const en: Record<ForkLocaleKey, string> = {
  'view.branches': 'Branches',
  'state.loading': 'Loading branch graph…',
  'state.error': 'Failed to load the branch graph',
  'state.retry': 'Retry',
  'state.empty': 'No branches yet. Try /branch create <name>',
  'state.dangling': 'Dangling branches (session missing):',
  'events.loading': 'Loading events…',
  'events.error': 'Failed to load events: ',
  'fork.title': 'Fork to a named branch',
  'fork.description': 'The branch name becomes the new session\u2019s title and must be unique in this workspace.',
  'fork.placeholder': 'Branch name',
  'fork.cancel': 'Cancel',
  'fork.confirm': 'Fork',
  'fork.close': 'Close',
  'fork.invalid': 'Invalid branch name: ',
}

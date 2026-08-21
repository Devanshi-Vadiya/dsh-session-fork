/**
 * Structural declarations of the vscode SCM history shapes the vendored
 * graph core (scm-history.ts) relies on.
 *
 * Transcribed from microsoft/vscode @ 611c5dfed2fb34ec3e5619bb6e77fdbd1e9d9541,
 * src/vs/workbench/contrib/scm/common/history.ts — kept shape-compatible
 * with upstream. vscode-only field types (URI, ThemeIcon, IMarkdownString)
 * are elided to `unknown` because no copied region reads them.
 * @module dsh-session-fork/src/client/vendor/vscode/types
 */

/** Upstream history.ts:13 — id of the (never-enabled) incoming-changes node. */
export const SCMIncomingHistoryItemId = 'scm-graph-incoming-changes'

/** Upstream history.ts:14 — id of the (never-enabled) outgoing-changes node. */
export const SCMOutgoingHistoryItemId = 'scm-graph-outgoing-changes'

/** Upstream ISCMHistoryItemRef — a branch/tag-style ref displayed on a graph row. */
export interface ISCMHistoryItemRef {
  readonly id: string
  readonly name: string
  readonly revision?: string
  readonly category?: string
  readonly description?: string
  readonly color?: string
  /** Upstream: URI | { light: URI; dark: URI } | ThemeIcon — elided. */
  readonly icon?: unknown
}

/** Upstream ISCMHistoryItem — one commit/row of the graph. */
export interface ISCMHistoryItem {
  readonly id: string
  readonly parentIds: string[]
  readonly subject: string
  readonly message: string
  readonly displayId?: string
  readonly author?: string
  readonly authorEmail?: string
  /** Upstream: URI | { light: URI; dark: URI } | ThemeIcon — elided. */
  readonly authorIcon?: unknown
  readonly timestamp?: number
  /** Upstream ISCMHistoryItemStatistics { files, insertions, deletions }. */
  readonly statistics?: { readonly files: number; readonly insertions: number; readonly deletions: number }
  readonly references?: ISCMHistoryItemRef[]
  /** Upstream: IMarkdownString | Array<IMarkdownString> — elided. */
  readonly tooltip?: unknown
}

/** Upstream ISCMHistoryItemGraphNode — one column of the swimlane layout. */
export interface ISCMHistoryItemGraphNode {
  readonly id: string
  readonly color: string
}

/** Upstream ISCMHistoryItemViewModel — one row's layout state. */
export interface ISCMHistoryItemViewModel {
  readonly historyItem: ISCMHistoryItem
  readonly inputSwimlanes: ISCMHistoryItemGraphNode[]
  readonly outputSwimlanes: ISCMHistoryItemGraphNode[]
  readonly kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes'
}

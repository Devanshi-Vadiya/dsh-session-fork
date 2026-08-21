/**
 * Branch graph view: one `conversation.view` tab entry rendering the
 * workspace's session branches with the vendored vscode SCM history
 * swimlane renderer — one row per turn, the turn's user message as the row
 * label, forked branches right-jumping to new lanes, and the current
 * session's latest turn as the HEAD double ring.
 *
 * P4 polish on top: theme-following palette (dark-theme override in the CSS
 * module), colored ref pills whose dot carries the branch's lane color, a
 * bold `current` treatment on the HEAD row, fade-in full-text tooltip on
 * ellipsized labels, a loading skeleton, and a retry affordance in the
 * error state.
 * @module dsh-session-fork/src/client/BranchGraphView
 */

import { useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { rowLaneColor, toGraphHistoryModel, type GraphPayloadDto, type GraphRpcResult } from './graph-model.ts'
import { NS } from './locales.ts'
import {
  renderSCMHistoryItemGraph,
  toISCMHistoryItemViewModelArray,
} from './vendor/vscode/scm-history.js'
import { asCssVariable } from './vendor/vscode/shims.js'
import type { ISCMHistoryItemViewModel } from './vendor/vscode/types.js'
import css from './BranchGraphView.module.css'

/** Session-bound capabilities the view reads (see the registration in index.ts). */
export interface BranchGraphInjected {
  /** Load the workspace branch graph anchored at one session. */
  loadGraph(signal?: AbortSignal): Promise<GraphRpcResult<GraphPayloadDto>>
  /** Load the workspace's dangling branch names (registry liveness view). */
  loadDangling(signal?: AbortSignal): Promise<GraphRpcResult<readonly string[]>>
}

type ViewProps = ConvViewProps & InjectFace<BranchGraphInjected> & PropsLocale<typeof NS>

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly rows: readonly ISCMHistoryItemViewModel[] }

/** One graph row: the rendered swimlane SVG plus the turn's label and ref pills. */
function GraphRow({ viewModel }: { readonly viewModel: ISCMHistoryItemViewModel }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = container.current
    if (host === null) return
    host.replaceChildren(renderSCMHistoryItemGraph(viewModel))
    return () => { host.replaceChildren() }
  }, [viewModel])
  const references = viewModel.historyItem.references ?? []
  const dotColor = asCssVariable(rowLaneColor(viewModel) ?? 'scmGraph.historyItemRefColor')
  return (
    <div className={viewModel.kind === 'HEAD' ? `${css.historyItem} ${css.current}` : css.historyItem}>
      <div className={css.graphContainer} ref={container} />
      <span className={css.label} data-full={viewModel.historyItem.subject}>
        {viewModel.historyItem.subject}
      </span>
      {references.map(ref => (
        <span key={ref.id} className={css.ref}>
          <span className={css.refDot} style={{ background: dotColor }} />
          {ref.name}
        </span>
      ))}
    </div>
  )
}

/** The branches graph tab body: loads over RPC, then renders the lanes. */
export function BranchGraphView({ sessionId, loadGraph, loadDangling, t }: ViewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [dangling, setDangling] = useState<readonly string[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading' })
    setDangling([])
    loadGraph(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.ok) {
          setState({ kind: 'error', message: result.error.message })
          return
        }
        const model = toGraphHistoryModel(result.value)
        setState({
          kind: 'ready',
          rows: toISCMHistoryItemViewModelArray([...model.items], undefined, model.headRef),
        })
      },
      (error: unknown) => {
        // The RPC carrier throwing is still a view state, never a crash.
        if (controller.signal.aborted) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    // The dangling view is best-effort: a failing registry call must never
    // take the graph down (the graph endpoint already omits dead sessions).
    loadDangling(controller.signal).then(
      (result) => {
        if (controller.signal.aborted || !result.ok) return
        setDangling(result.value)
      },
      () => { /* best-effort */ },
    )
    return () => { controller.abort() }
  }, [sessionId, loadGraph, loadDangling, attempt])

  if (state.kind === 'loading') {
    return (
      <div className={css.graph} aria-busy="true">
        {t('state.loading')}
        <div className={css.skeletonRow} />
        <div className={css.skeletonRow} />
        <div className={css.skeletonRow} />
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className={css.state}>
        {t('state.error')}
        <span className={css.errorDetail}>{state.message}</span>
        <button type="button" className={css.retry} onClick={() => { setAttempt(attempt + 1) }}>
          {t('state.retry')}
        </button>
      </div>
    )
  }
  if (state.rows.length === 0 && dangling.length === 0) {
    return <div className={css.state}>{t('state.empty')}</div>
  }
  return (
    <div className={css.graph}>
      {state.rows.map(row => <GraphRow key={row.historyItem.id} viewModel={row} />)}
      {dangling.length > 0 && (
        <div className={css.danglingSection}>
          {t('state.dangling')}
          {dangling.map(name => (
            <span key={name} className={css.danglingRef}>{name}</span>
          ))}
        </div>
      )}
    </div>
  )
}

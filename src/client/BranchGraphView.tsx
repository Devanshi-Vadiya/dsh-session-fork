/**
 * Branch graph view: one `conversation.view` tab entry rendering the
 * workspace's session branches with the vendored vscode SCM history
 * swimlane renderer — one row per turn, the turn's user message as the row
 * label, forked branches right-jumping to new lanes, and the current
 * session's latest turn as the HEAD double ring.
 * @module dsh-session-fork/src/client/BranchGraphView
 */

import { useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { toGraphHistoryModel, type GraphPayloadDto, type GraphRpcResult } from './graph-model.ts'
import { NS } from './locales.ts'
import {
  renderSCMHistoryItemGraph,
  toISCMHistoryItemViewModelArray,
} from './vendor/vscode/scm-history.js'
import type { ISCMHistoryItemViewModel } from './vendor/vscode/types.js'
import css from './BranchGraphView.module.css'

/** Session-bound capabilities the view reads (see the registration in index.ts). */
export interface BranchGraphInjected {
  /** Load the workspace branch graph anchored at one session. */
  loadGraph(signal?: AbortSignal): Promise<GraphRpcResult<GraphPayloadDto>>
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
  return (
    <div className={css.historyItem}>
      <div className={css.graphContainer} ref={container} />
      <span className={css.label} title={viewModel.historyItem.subject}>
        {viewModel.historyItem.subject}
      </span>
      {references.map(ref => (
        <span key={ref.id} className={css.ref}>{ref.name}</span>
      ))}
    </div>
  )
}

/** The branches graph tab body: loads over RPC, then renders the lanes. */
export function BranchGraphView({ sessionId, loadGraph, t }: ViewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading' })
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
    return () => { controller.abort() }
  }, [sessionId, loadGraph])

  if (state.kind === 'loading') {
    return <div className={css.state}>{t('state.loading')}</div>
  }
  if (state.kind === 'error') {
    return (
      <div className={css.state}>
        {t('state.error')}
        <span className={css.errorDetail}>{state.message}</span>
      </div>
    )
  }
  if (state.rows.length === 0) {
    return <div className={css.state}>{t('state.empty')}</div>
  }
  return (
    <div className={css.graph}>
      {state.rows.map(row => <GraphRow key={row.historyItem.id} viewModel={row} />)}
    </div>
  )
}

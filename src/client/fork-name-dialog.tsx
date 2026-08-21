/**
 * The fork-name dialog: a full-viewport Modal the intercepted fork flow
 * opens to collect the mandatory branch name (issue #3).
 * @module dsh-session-fork/src/client/fork-name-dialog
 *
 * Split in two halves:
 * - a framework-free controller (the open/busy/error/draft state machine
 *   plus the `requestName` promise bridge) — unit-testable without React;
 * - a thin React component rendering the official Modal + Button atoms,
 *   driven by the controller through useSyncExternalStore.
 *
 * The dialog stays open until the user cancels or a submission is fully
 * accepted: a failed submission (client-side gate or host-side rejection)
 * renders its message in the error row (the official rename dialog's
 * `role="alert"` pattern) and lets the user retry with another name.
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ForkNameDialog.module.css'

/** Result of one submission attempt: accepted (child id) or rejected (message). */
export type ForkSubmitOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly message: string }

/** Controller-facing dialog snapshot (immutable; replaced on every change). */
export interface ForkDialogState {
  readonly phase: 'closed' | 'open'
  readonly busy: boolean
  readonly error: string | null
  readonly draft: string
}

/** Translator: locale keys owned by this plugin (see locales.ts). */
export type ForkTranslate = (key: ForkDialogLocaleKey) => string

/** The locale keys the dialog component reads. */
export type ForkDialogLocaleKey =
  | 'fork.title'
  | 'fork.description'
  | 'fork.placeholder'
  | 'fork.cancel'
  | 'fork.confirm'
  | 'fork.close'

/** Framework-free state machine + promise bridge behind the dialog. */
export interface ForkNameDialogController {
  /** Subscribe to snapshot changes (useSyncExternalStore contract). */
  subscribe(listener: () => void): () => void
  /** Current immutable snapshot. */
  getSnapshot(): ForkDialogState
  /**
   * Open the dialog and wait for a name. Each confirm runs `submit`; an
   * accepted submission resolves the promise with the child session id,
   * a rejected one shows the message and keeps the dialog open. Cancel
   * (or a second concurrent request) resolves `undefined`.
   */
  requestName(submit: (name: string) => Promise<ForkSubmitOutcome>): Promise<{ sessionId: string } | undefined>
  /** Draft text changed (component input). */
  changeDraft(draft: string): void
  /** Confirm pressed: run the pending submission (no-op while busy/closed). */
  confirm(): void
  /** Cancel/Escape/mask pressed: settle with `undefined` and close. */
  cancel(): void
}

/** Build one controller. One dialog at a time; a second request settles `undefined`. */
export function createForkNameDialog(): ForkNameDialogController {
  const listeners = new Set<() => void>()
  let state: ForkDialogState = { phase: 'closed', busy: false, error: null, draft: '' }
  let pending: {
    readonly submit: (name: string) => Promise<ForkSubmitOutcome>
    readonly settle: (value: { sessionId: string } | undefined) => void
  } | null = null

  const setState = (next: ForkDialogState): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const close = (value: { sessionId: string } | undefined): void => {
    const request = pending
    pending = null
    setState({ phase: 'closed', busy: false, error: null, draft: '' })
    request?.settle(value)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
    requestName(submit) {
      if (pending !== undefined && pending !== null) return Promise.resolve(undefined)
      return new Promise(resolve => {
        pending = { submit, settle: resolve }
        setState({ phase: 'open', busy: false, error: null, draft: '' })
      })
    },
    changeDraft(draft) {
      if (state.phase !== 'open' || state.busy) return
      setState({ ...state, draft })
    },
    confirm() {
      const request = pending
      if (request === null || state.phase !== 'open' || state.busy) return
      setState({ ...state, busy: true, error: null })
      void request.submit(state.draft).then(outcome => {
        // A cancel may have landed while the submission was in flight;
        // the dialog is already closed and settled — drop the outcome.
        if (pending === null || state.phase !== 'open') return
        if (outcome.ok) {
          close({ sessionId: outcome.sessionId })
        } else {
          setState({ ...state, busy: false, error: outcome.message })
        }
      }, error => {
        if (pending === null || state.phase !== 'open') return
        setState({
          ...state,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
    cancel() {
      if (pending === null) return
      close(undefined)
    },
  }
}

/**
 * The dialog component. Registered once into the `shell.overlay` slot by
 * the plugin apply; renders nothing unless a request is open. All copy
 * arrives localized through `t`; all chrome is the official Modal/Button.
 * @param props.controller - the shared controller instance.
 * @param props.t - bound locale translator.
 * @returns the Modal tree (null when closed).
 */
export function ForkNameDialog({ controller, t }: {
  controller: ForkNameDialogController
  t: ForkTranslate
}): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <Modal
      open={state.phase === 'open'}
      onClose={controller.cancel}
      title={t('fork.title')}
      closeLabel={t('fork.close')}
      description={t('fork.description')}
      footer={(
        <>
          <Button variant="outline" disabled={state.busy} onClick={controller.cancel}>
            {t('fork.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={state.busy || state.draft.length === 0}
            onClick={controller.confirm}
          >
            {t('fork.confirm')}
          </Button>
        </>
      )}
    >
      <input
        className={css.input}
        value={state.draft}
        autoFocus
        disabled={state.busy}
        placeholder={t('fork.placeholder')}
        aria-label={t('fork.title')}
        onChange={(e) => { controller.changeDraft(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !state.busy && state.draft.length > 0) controller.confirm()
        }}
      />
      {state.error !== null && (
        <div className={css.error} role="alert">{state.error}</div>
      )}
    </Modal>
  )
}

/**
 * Browser half of dsh-session-fork: the client plugin entry, materialized
 * by the dsh client module system from the package's `./client` export.
 *
 * P3 registers the branches graph tab: one `conversation.view` entry (after
 * the chat and trajectory tabs, order 20) whose body loads the workspace's
 * branch graph over the plugin's host RPC channel and renders it with the
 * vendored vscode SCM history swimlane renderer. Rendering only — no
 * switch/fork interactions (v0.0.2 scope, see docs/ROADMAP.md).
 * @module dsh-session-fork/src/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the 'shell.overlay' hole (declared by ui-layout's AppFrame
// registration) must be in the program for the overlay register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { BranchGraphView, type BranchGraphInjected } from './BranchGraphView.tsx'
import { createForkNameDialog, ForkNameDialog, type ForkTranslate } from './fork-name-dialog.tsx'
import {
  installForkIntercept,
  type ForkEndpointResult,
  type SessionsServiceLike,
} from './fork-intercept.js'
import { validateBranchName } from '../branch-name.js'
import {
  RPC_CHANNEL,
  type GraphPayloadDto,
  type GraphRpcResult,
  type RegistryBranchDto,
} from './graph-model.ts'
import { en, NS, zh } from './locales.ts'

/**
 * Structural slice of the client connection service: the generic RPC caller
 * (`ctx.connection.rpc.call`, see packages/client/connection in the harness
 * checkout). Declared locally so the value-import surface stays empty.
 */
interface ConnectionLike {
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<GraphRpcResult>
  }
}

/** Required services: the slot system, the locale service, the wire, and the shared sessions service. */
export const inject = ['slots', 'locale', 'connection', 'sessions'] as const

/** A connection-less host still renders the tab, in its error state. */
function graphUnavailable(): GraphRpcResult<never> {
  return {
    ok: false,
    error: { code: 'internal', message: 'connection service unavailable' },
  }
}

/**
 * Wait until the host-broadcast child is locally addressable (the RPC
 * response and the session-added frame race). Bounded polling — on
 * exhaustion the caller opens best-effort; the sidebar row is the
 * fallback surface.
 */
async function waitForAddressable(sessions: SessionsServiceLike, sessionId: string): Promise<void> {
  const ATTEMPTS = 40
  const DELAY_MS = 25
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (sessions.binding(sessionId) !== undefined) return
    await new Promise(resolve => { setTimeout(resolve, DELAY_MS) })
  }
}

/**
 * Client plugin body: register the dictionaries and the branches tab. The
 * tab registration rides the slot service's inject wrapper (it waits on the
 * conversation view declaration and leaves with this plugin's fiber), so
 * plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-fork: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionLike | undefined
  const sessions = ctx.get('sessions') as SessionsServiceLike

  // Issue #3: intercept the official fork entries (sidebar row menu +
  // turn-tail branch button) and route them through the name dialog and
  // the host-side `fork` endpoint. Without the connection service (a
  // non-web host) the patch stays off and official behavior is untouched.
  if (connection !== undefined) {
    const dialog = createForkNameDialog()
    installForkIntercept({
      sessions,
      requestName: dialog.requestName,
      validateName: validateBranchName,
      formatInvalidName: (reason) => `${t('fork.invalid')}${reason}`,
      callFork: (payload) =>
        connection.rpc.call(RPC_CHANNEL, 'fork', payload) as Promise<ForkEndpointResult>,
      waitForSession: (sessionId) => waitForAddressable(sessions, sessionId),
    })
    // The dialog mounts as a root-scope overlay entry: the shell's own
    // full-app overlay hole (declared by ui-layout's AppFrame), rendering
    // nothing unless a fork request is open.
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'fork-name-dialog',
      locale: NS,
      inject: () => ({ controller: dialog, t: t as ForkTranslate }),
    }, ForkNameDialog))
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'branches',
    order: 20,
    locale: NS,
    label: () => t('view.branches'),
    inject: (sessionId: SessionId): BranchGraphInjected => ({
      loadGraph: (signal?: AbortSignal): Promise<GraphRpcResult<GraphPayloadDto>> => {
        if (connection === undefined) return Promise.resolve(graphUnavailable())
        const result: Promise<GraphRpcResult> =
          connection.rpc.call(RPC_CHANNEL, 'graph', { sessionId }, signal)
        return result as Promise<GraphRpcResult<GraphPayloadDto>>
      },
      // The registry snapshot rides along for the dangling-branch section
      // (a branch whose session vanished renders distinctly, not hidden).
      loadDangling: (signal?: AbortSignal): Promise<GraphRpcResult<readonly string[]>> => {
        if (connection === undefined) return Promise.resolve(graphUnavailable())
        const call: Promise<GraphRpcResult> =
          connection.rpc.call(RPC_CHANNEL, 'registry', { sessionId }, signal)
        return call.then((result): GraphRpcResult<readonly string[]> => {
          if (!result.ok) return result
          const value = result.value as { branches: readonly RegistryBranchDto[] }
          return {
            ok: true,
            value: value.branches
              .filter(branch => branch.dangling)
              .map(branch => branch.name),
          }
        })
      },
    }),
  }, BranchGraphView))
}

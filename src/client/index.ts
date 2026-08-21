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
import { BranchGraphView, type BranchGraphInjected } from './BranchGraphView.tsx'
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

/** Required services: the slot system, the locale service, and the wire. */
export const inject = ['slots', 'locale', 'connection'] as const

/** A connection-less host still renders the tab, in its error state. */
function graphUnavailable(): GraphRpcResult<never> {
  return {
    ok: false,
    error: { code: 'internal', message: 'connection service unavailable' },
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

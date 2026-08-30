/**
 * The agent-facing tool surface (issue #5): one tool per `/branch`-family
 * operation, every tool delegating to the SAME pure executor cores the
 * slash commands run — zero command logic is duplicated here, only
 * argument schemas, source resolution, and result translation.
 * @module dsh-session-fork/src/tools
 *
 * Design contract (agreed 2026-08-26):
 *
 * - The tool entry point is the modern answer to "AI assists the human in
 *   operating branches": the slash commands stay the human surface, the
 *   tools are the model surface, and both drive one execution core.
 * - `exec.agent` is the calling agent; every "current session" semantic
 *   (fork source, adopt target, squash source) resolves to it, so a tool
 *   called from ANY session — main or future subagent — operates on that
 *   caller's own branch, exactly like the command operates on the typer's.
 * - Registrations are host-side through `ctx.tools.register` (official
 *   first-party pattern; cf. dsh tool-skill / tool-agent-team) and are
 *   disposed with the plugin fiber.
 * - Results are one canonical shape — `{ok, message}` — with `message`
 *   carrying the exact executor texts (the same wording the human sees),
 *   so the model and the user share one vocabulary.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeBranchAction } from './command.js'
import type { BranchCommandDeps, BranchCommandResult } from './command.js'
import { dispatchSquash } from './squash-midturn.js'
import type { SquashHandoffDeps } from './squash-midturn.js'
import type { DetachedRunner } from './squash-midturn.js'
import type { SquashChildAgent } from './squash-command.js'
import { executeRebasedIntoAction } from './rebased-into-command.js'
import type { RebasedIntoAgent, RebasedIntoCommandDeps } from './rebased-into-command.js'

/**
 * The host capabilities the tool surface needs, injected by src/index.ts.
 * Every member mirrors a construction the command handlers already build —
 * this seam exists so the tool layer stays pure and unit-testable.
 */
export interface BranchToolPorts {
  /**
   * `/branch` execution deps for one calling session — the exact shape the
   * command handler builds (`BranchCommandDeps`).
   */
  command(currentSessionId: string, workspaceKey: string): BranchCommandDeps
  /**
   * Resolve one registered branch name to its session id within a workspace.
   * `null` when no such branch is registered (unknown-branch refusals).
   */
  branchSessionId(workspaceKey: string, name: string): Promise<string | null>
  /**
   * Live-first agent resolution for an explicit transfer source, cold
   * sources resuming through the vendored kernel. `null` when the session
   * does not exist at all.
   */
  resolveSourceAgent(sessionId: string): Promise<Agent | null>
  /**
   * Squash executor deps minus the per-call source/signal/commandId — the
   * exact shape the `/squash` command handler builds around
   * `dispatchSquash` (src/squash-midturn.ts).
   */
  squashBase(workspaceKey: string): Omit<SquashHandoffDeps, 'childAgent' | 'signal' | 'commandId'>
  /**
   * Rebased-into executor deps minus the source agent — the exact shape the
   * `/rebased into` command handler builds.
   */
  rebasedBase(workspaceKey: string): Omit<RebasedIntoCommandDeps, 'sourceAgent'>
  /** The host's detached-continuation tracker (plugin dispose drains it). */
  readonly trackDetached: DetachedRunner
}

/**
 * The one canonical tool result. `message` is the executor's own text —
 * success text or error text — never rephrased here.
 */
export interface BranchToolValue {
  readonly ok: boolean
  readonly message: string
}

/** Translate one executor result into the canonical tool value. */
export function commandResultToToolValue(result: BranchCommandResult): BranchToolValue {
  return result.kind === 'success'
    ? { ok: true, message: result.text ?? 'ok' }
    : { ok: false, message: result.text }
}

/** The JSON Schema of {@link BranchToolValue} (defineTool output contract). */
const BRANCH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
} as const

/**
 * JSON-output helper mirroring the first-party idiom (dsh
 * tool-agent-team's `jsonOutput`): render the canonical value as one text
 * block. Output schemas are mandatory on ToolDefinitions.
 */
function jsonOutput(): {
  schema: typeof BRANCH_RESULT_SCHEMA
  render: (args: unknown, value: BranchToolValue) => [{ type: 'text'; text: string }]
} {
  return {
    schema: BRANCH_RESULT_SCHEMA,
    render: (_args: unknown, value: BranchToolValue) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/**
 * The calling agent, or a refusal value. Tools only ever run on behalf of
 * one agent; the registry guarantees `exec.agent` in agent-driven calls
 * (the tool-agent-team `callingAgent` pattern).
 */
const CALLER_MISSING: BranchToolValue = {
  ok: false,
  message: 'no calling agent: this tool runs only inside an agent session',
}

/** Resolve the calling session of one tool call, or refuse canonically. */
function callerOf(exec: ToolRunContext): Caller | BranchToolValue {
  const agent = exec.agent
  if (agent === undefined) return CALLER_MISSING
  return { sessionId: agent.session.id, workspaceKey: agent.session.header.cwd ?? '', exec }
}

/** Whether a caller resolution refused. */
function isRefusal(value: Caller | BranchToolValue): value is BranchToolValue {
  return 'ok' in value
}

/** One tool's caller facts, already resolved. */
interface Caller {
  readonly sessionId: string
  readonly workspaceKey: string
  readonly exec: ToolRunContext
}

/**
 * Run one `/branch` action for the calling session. The shared body of the
 * registry-operation tools: resolve the caller, build the command deps the
 * command handler would build, execute, translate.
 */
async function runBranchAction(
  action: Parameters<typeof executeBranchAction>[0],
  caller: Caller,
  ports: BranchToolPorts,
): Promise<BranchToolValue> {
  return commandResultToToolValue(
    await executeBranchAction(action, ports.command(caller.sessionId, caller.workspaceKey)),
  )
}

/** Shared branches vocabulary for the tool descriptions (issue #28-lite). */
const BRANCH_IS
  = 'A branch is a named, persistent fork of a conversation in the dsh-session-fork registry. '

/**
 * The tool definitions of the branch surface (issue #5). Pure construction
 * over injected ports — host wiring happens in src/index.ts.
 */
export function branchToolDefinitions(ports: BranchToolPorts): ToolDefinition[] {
  const branchList = defineTool({
    name: 'branch_list',
    description:
      'List this workspace\'s registered branches (name, session, fork origin, dangling flag). '
      + BRANCH_IS
      + 'Read-only; the model-facing view of /branch list.',
    parameters: {},
    output: jsonOutput(),
    async execute(_args, exec) {
      const caller = callerOf(exec)
      return 'ok' in caller
        ? caller
        : await runBranchAction({ kind: 'list' }, caller, ports)
    },
  })

  const branchCreate = defineTool({
    name: 'branch_create',
    description:
      'Fork the CURRENT conversation into a new named branch. '
      + BRANCH_IS
      + 'The seed is this conversation\'s history up to the last completed turn — the current in-flight turn is not included. '
      + 'The new branch appears in the branch registry and the branch tab, and its session title becomes the branch name. '
      + 'The model-facing form of /branch create.',
    parameters: {
      name: { type: 'string', required: true, description: 'The new branch\'s name (unique per workspace).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      return 'ok' in caller
        ? caller
        : await runBranchAction({ kind: 'create', name: args.name }, caller, ports)
    },
  })

  const branchAdopt = defineTool({
    name: 'branch_adopt',
    description:
      'Register the CURRENT session as a root branch under the given name (no fork — this very conversation becomes a branch). '
      + BRANCH_IS
      + 'The session title becomes the branch name. The model-facing form of /branch adopt.',
    parameters: {
      name: { type: 'string', required: true, description: 'The root branch\'s name (unique per workspace).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      return 'ok' in caller
        ? caller
        : await runBranchAction({ kind: 'adopt', name: args.name }, caller, ports)
    },
  })

  const branchRename = defineTool({
    name: 'branch_rename',
    description:
      'Rename a registered branch ref (old name → new name; the registry key only — session data is untouched). '
      + BRANCH_IS
      + 'The model-facing form of /branch rename.',
    parameters: {
      from: { type: 'string', required: true, description: 'The branch\'s current name.' },
      to: { type: 'string', required: true, description: 'The branch\'s new name (unique per workspace).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      return 'ok' in caller
        ? caller
        : await runBranchAction({ kind: 'rename', from: args.from, to: args.to }, caller, ports)
    },
  })

  const branchRemove = defineTool({
    name: 'branch_remove',
    description:
      'Remove a branch ref — the registry record only, NEVER session data (the conversation stays openable as a plain session). '
      + 'Destructive to the ref, so it mirrors /branch rm --yes: pass confirm=true or the call is refused with no side effects.',
    parameters: {
      name: { type: 'string', required: true, description: 'The branch ref to remove.' },
      confirm: {
        type: 'boolean',
        required: true,
        description: 'Must be true for the removal to run (the --yes parity).',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      if ('ok' in caller) return caller
      if (args.confirm !== true) {
        return {
          ok: false,
          message: 'removal requires an explicit confirmation: call again with confirm=true '
            + '(removes only the branch ref, never session data)',
        }
      }
      return await runBranchAction({ kind: 'rm', name: args.name, confirmed: true }, caller, ports)
    },
  })

  return [branchList, branchCreate, branchAdopt, branchRename, branchRemove]
}

/**
 * Resolve an explicit transfer `from` argument: branch name → session id →
 * agent. Never throws; unknown branch and missing session each return their
 * canonical refusal (wording shared with the executors' unknown-branch text).
 */
async function resolveTransferSource(
  from: string,
  caller: Caller,
  ports: BranchToolPorts,
): Promise<Agent | BranchToolValue> {
  const sessionId = await ports.branchSessionId(caller.workspaceKey, from)
  if (sessionId === null) {
    return { ok: false, message: `no branch named '${from}' in this workspace` }
  }
  const agent = await ports.resolveSourceAgent(sessionId)
  if (agent === null) {
    return { ok: false, message: `the session behind branch '${from}' no longer exists` }
  }
  return agent
}

/** Whether a transfer-source resolution refused. */
function isSourceRefusal(
  value: Agent | BranchToolValue,
): value is BranchToolValue {
  return 'ok' in value
}

/**
 * The transfer tools (squash_into / rebased_into). Source defaults to the
 * calling agent's own branch; an explicit `from` names any registered branch,
 * resolved live-first with cold sources resuming through the vendored kernel.
 */
export function transferToolDefinitions(ports: BranchToolPorts): ToolDefinition[] {
  const squashInto = defineTool({
    name: 'squash_into',
    description:
      'Squash the source branch\'s conversation into the target branch as ONE summary checkpoint (official compaction form; the target reads it as established background). '
      + 'Source defaults to the current branch; an explicit from names any registered branch. '
      + 'A RUNNING source takes the turn handoff: its turn is terminated (official cancel shape, inbox kept), the squash completes at idle, and the source is reactivated with the report — mid-turn self-squash is supported. '
      + 'The model-facing form of /squash into.',
    parameters: {
      into: { type: 'string', required: true, description: 'The target branch that receives the summary.' },
      from: {
        type: 'string',
        description: 'The source branch being squashed (default: the current branch).',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      if ('ok' in caller) return caller
      let childAgent: SquashHandoffDeps['childAgent']
      if (args.from === undefined) {
        childAgent = exec.agent as SquashChildAgent
      } else {
        const source = await resolveTransferSource(args.from, caller, ports)
        if (isSourceRefusal(source)) return source
        childAgent = source as SquashChildAgent
      }
      return commandResultToToolValue(
        await dispatchSquash(
          args.into,
          { childAgent, signal: exec.signal, ...ports.squashBase(caller.workspaceKey) },
          ports.trackDetached,
        ),
      )
    },
  })

  const rebasedInto = defineTool({
    name: 'rebased_into',
    description:
      'Transfer the source branch\'s own conversation VERBATIM (no summary) into the target branch\'s inbox — the target claims it at its nearest step boundary; a busy target is never a problem. '
      + 'Source defaults to the current branch, but a RUNNING source is refused (no handoff exists for rebased-into yet) — name an idle branch through from instead. '
      + 'The model-facing form of /rebased into.',
    parameters: {
      into: { type: 'string', required: true, description: 'The target branch whose inbox receives the transcript.' },
      from: {
        type: 'string',
        description: 'The source branch being transferred (default: the current branch; must be idle).',
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const caller = callerOf(exec)
      if ('ok' in caller) return caller
      let sourceAgent: RebasedIntoAgent = exec.agent as RebasedIntoAgent
      if (args.from !== undefined) {
        const source = await resolveTransferSource(args.from, caller, ports)
        if (isSourceRefusal(source)) return source
        sourceAgent = source as RebasedIntoAgent
      }
      return commandResultToToolValue(
        await executeRebasedIntoAction(
          { kind: 'rebased-into', target: args.into },
          { sourceAgent, ...ports.rebasedBase(caller.workspaceKey) },
        ),
      )
    },
  })

  return [squashInto, rebasedInto]
}

/**
 * Register every branch tool on one register callback (host: the dsh tools
 * service). Returns the combined disposer for the plugin's effect chain.
 */
export function registerBranchTools(
  register: (tool: ToolDefinition) => () => unknown,
  ports: BranchToolPorts,
): () => void {
  const disposers = [...branchToolDefinitions(ports), ...transferToolDefinitions(ports)]
    .map(tool => register(tool))
  return () => { for (const dispose of disposers) dispose() }
}

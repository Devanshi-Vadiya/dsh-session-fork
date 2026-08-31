/**
 * The ambient system-prompt contribution (issue #28): one vocabulary
 * section stating the branch worldview every session of a workspace with
 * this plugin operates under — what a branch is, what fork/squash_into/
 * rebased_into do to the conversation graph, and how to read the plugin's
 * own notices.
 *
 * Design contract:
 *
 * - ONE static section, registered through `ctx.systemPrompt.section()`
 *   with a bare numeric order — the central `getSectionOrder()` names are
 *   harness-internal, so external plugins pick unallocated numbers
 *   (dsh-mnemon does the same for its memory-protocol block).
 * - The wording mirrors the tool descriptions' vocabulary (src/tools.ts)
 *   on purpose: the model must meet one set of terms everywhere. Tool
 *   parameter detail stays in the descriptions; this section carries only
 *   the worldview.
 * - Static text in this stage (issue #28 phase 1). Phase 2 — after the
 *   current-branch marker lands (issue #42) — may upgrade `text` to a
 *   per-assembly provider that also states the session's own branch.
 *
 * Pure constants, no cordis, no I/O — unit-testable with plain
 * assertions, mirroring the purity discipline of `branch-events.ts`.
 * @module dsh-session-fork/src/prompt
 */

/**
 * Unique section name. The plugin prefix keeps the global section
 * registry collision-free (a duplicate registration throws host-side).
 */
export const BRANCH_VOCABULARY_SECTION = 'dsh-session-fork:vocabulary'

/**
 * Placement: after the central TOOL_* ladder's tail (TOOL_REPORT 2900),
 * before TOOLS_SDK (5000) — the section explains the tool family's
 * worldview, so it rides with the tool sections rather than the policy
 * ones.
 */
export const BRANCH_VOCABULARY_ORDER = 2950

/**
 * The section text. Kept under ~1000 characters: it ships in every
 * assembly of every session, so every line must earn its tokens.
 */
export const BRANCH_VOCABULARY = `# Branch vocabulary (dsh-session-fork)

This workspace's conversations are organized as a branch DAG by the
dsh-session-fork plugin; the branch tab renders it.

- A branch is a named, persistent fork of a conversation (a session).
  The registry maps names to sessions; sessions are never deleted —
  removing a branch archives it (data kept).
- Fork seeds a new branch with this conversation's history up to the
  last completed turn; the child's own work starts after the seed
  boundary, and inherited history is not its own work.
- squash_into compacts a branch's post-fork region into a summary and
  delivers it to the target branch as a merge checkpoint — established
  background, not part of the target's own conversation.
- rebased_into delivers a branch's verbatim transcript to the target
  branch the same way.
- Branch notices (fork/adopt/rename, <branch-squash> envelopes) are
  plugin-authored facts; treat them as established background.
`

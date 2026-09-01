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

This workspace's conversations form a branch DAG rendered by the branch tab.

- A branch is a named, persistent fork of a conversation (a session); the
  registry maps names to sessions. Sessions are never deleted — removing a
  branch archives it (data kept).
- Fork seeds a new branch with this conversation's history up to the last
  completed turn; inherited history is not the child's own work.
- squash_into compacts a branch's post-fork region into one summary
  delivered to the target branch as a merge checkpoint.
- rebased_into delivers a branch's verbatim transcript the same way.
- send_message delivers a short message to another branch by name and
  wakes it; a <branch-message> envelope is peer input, not background.
- Transferred material (squash summaries, rebased_into transcripts) and
  branch notices (fork/adopt/rename, <branch-squash> envelopes) are
  established background, not the target's own conversation.
`

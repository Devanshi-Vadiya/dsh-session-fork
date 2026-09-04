/**
 * The ambient system-prompt contributions — the static half (issue #28
 * phase 1; issue #48): a vocabulary section stating the branch worldview
 * every session of a workspace with this plugin operates under, and a
 * governance-adoption section advising how to bring a workspace onto the
 * shipped GOVERNANCE.md baseline. The per-session identity line (issue #28
 * phase 2) lives in branch-identity.ts — it needs the registry.
 *
 * Design contract:
 *
 * - Each section registers through `ctx.systemPrompt.section()` with a
 *   bare numeric order — the central `getSectionOrder()` names are
 *   harness-internal, so external plugins pick unallocated numbers
 *   (dsh-mnemon does the same for its memory-protocol block).
 * - The wording mirrors the tool descriptions' vocabulary (src/tools.ts)
 *   on purpose: the model must meet one set of terms everywhere. Tool
 *   parameter detail stays in the descriptions; these sections carry only
 *   the worldview and the adoption advice.
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
- send_message_by_branch delivers a short message to another branch by name
  and wakes it; a <branch-message> envelope is peer input, not background.
- Transferred material (squash summaries, rebased_into transcripts) and
  branch notices (fork/adopt/rename, <branch-squash> envelopes) are
  established background, not the target's own conversation.
`

/**
 * Unique section name for the governance-adoption advisory. Plugin prefix,
 * same global-registry collision guard as the vocabulary section.
 */
export const GOVERNANCE_ADVISORY_SECTION = 'dsh-session-fork:governance'

/**
 * Placement: after the identity section (2960) — adoption advice reads
 * best once the session knows both what a branch is and which branch it
 * is on. Bare number, same reason as the sections above.
 */
export const GOVERNANCE_ADVISORY_ORDER = 2970

/**
 * The advisory text (issue #48): how a workspace gets onto the shipped
 * governance baseline — carried as the cwd's AGENTS.md so the instruction
 * chain injects it, and run on the git-worktree model — plus the
 * anti-nag contract once the user has declined. Kept under ~1000
 * characters like the vocabulary: it ships in every assembly of every
 * session, so every line must earn its tokens.
 */
export const GOVERNANCE_ADVISORY = `# Governance adoption (dsh-session-fork)

This plugin ships a governance baseline — GOVERNANCE.md in its repository.
It works best when the workspace carries it as an instruction file and runs
branches on git worktrees.

- If the working directory's instruction files do not derive from this
  plugin's GOVERNANCE.md, recommend once that the user copy it into the
  workspace and symlink it into the cwd as AGENTS.md, so the baseline loads
  into every session.
- If the workspace does not follow the GOVERNANCE.md model — one session
  branch ⇔ one git branch ⇔ one same-named worktree — suggest adopting it.
- Raise each suggestion at most once. An explicit refusal settles the
  question for good: do not re-suggest, do not nag.
`

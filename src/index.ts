/**
 * dsh-fork: git-style conversation branching for DeepSeek Harness.
 * @module dsh-fork
 *
 * Stage 1 — loadable plugin skeleton only. Branch registry, commands,
 * and UI land in later milestones (see docs/ROADMAP.md).
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-fork'

/** No service dependencies yet; later stages will inject dsh services. */
export const inject: string[] = []

export function apply(ctx: Context) {
  ctx.logger.debug('dsh-fork: skeleton loaded (no features registered yet)')
}

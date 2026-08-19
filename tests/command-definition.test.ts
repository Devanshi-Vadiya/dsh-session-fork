/**
 * Wiring test for the `/branch` CommandDefinition: the registered
 * definition must carry a non-empty `input` hint. Without it the web
 * client's admission (ui-commands matchEnter) treats the command as
 * bare-only and `/branch main` would be sent as a normal message instead
 * of reaching the handler.
 * @module dsh-fork/tests/command-definition.test
 */

import { describe, expect, test } from 'bun:test'
import { branchCommandDefinition } from '../src/index.js'

describe('branchCommandDefinition', () => {
  test('registers under the name "branch"', () => {
    expect(branchCommandDefinition.name).toBe('branch')
  })

  test('exposes a non-empty input hint so argued slash-lines reach the handler', () => {
    const hint = branchCommandDefinition.input?.hint
    expect(typeof hint).toBe('string')
    expect(hint?.length ?? 0).toBeGreaterThan(0)
  })

  test('hint mentions every documented subcommand', () => {
    const hint = branchCommandDefinition.input?.hint ?? ''
    for (const sub of ['adopt', 'list', 'rm', 'rename', 'create']) {
      expect(hint).toContain(sub)
    }
  })
})

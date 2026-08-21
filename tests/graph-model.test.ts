/**
 * Tests for the client-side graph model: mapping the host's graph payload
 * onto the vendored vscode history shapes (pure, no React, no DOM).
 * @module dsh-session-fork/tests/graph-model.test
 */

import { describe, expect, test } from 'bun:test'
import { toGraphHistoryModel, type GraphPayloadDto } from '../src/client/graph-model.ts'
import type { ISCMHistoryItem } from '../src/client/vendor/vscode/types.ts'

describe('toGraphHistoryModel', () => {
  test('maps nodes onto history items with refs and the HEAD marker', () => {
    const payload: GraphPayloadDto = {
      nodes: [
        { id: 's-b:2', parentIds: ['s-b:1'], subject: 'second', refs: [{ id: 'exp', name: 'exp' }] },
        { id: 's-b:1', parentIds: ['s-a:1'], subject: 'first' },
      ],
      head: 's-b:2',
    }
    const model = toGraphHistoryModel(payload)
    expect(model.items).toEqual([
      {
        id: 's-b:2',
        parentIds: ['s-b:1'],
        subject: 'second',
        message: 'second',
        references: [{ id: 'exp', name: 'exp', revision: 's-b:2' }],
      },
      { id: 's-b:1', parentIds: ['s-a:1'], subject: 'first', message: 'first' },
    ] satisfies ISCMHistoryItem[])
    expect(model.headRef).toEqual({ id: 'HEAD', name: 'HEAD', revision: 's-b:2' })
  })

  test('no head means no HEAD marker (no double ring anywhere)', () => {
    const model = toGraphHistoryModel({ nodes: [{ id: 'n', parentIds: [], subject: 's' }], head: null })
    expect(model.headRef).toBeUndefined()
  })

  test('empty refs stay absent from the item shape', () => {
    const model = toGraphHistoryModel({
      nodes: [{ id: 'n', parentIds: [], subject: 's', refs: [] }],
      head: null,
    })
    expect('references' in (model.items[0] as object)).toBe(false)
  })

  test('the mapped model feeds the vendored layout without DOM access', async () => {
    // End-to-end sanity: the pure layout half of the vendored renderer
    // accepts the mapped items (rendering itself needs DOM, see
    // tests/vendor-graph.test.ts).
    const { toISCMHistoryItemViewModelArray } = await import('../src/client/vendor/vscode/scm-history.ts')
    const model = toGraphHistoryModel({
      nodes: [
        { id: 'c2', parentIds: ['c1'], subject: 'later' },
        { id: 'c1', parentIds: [], subject: 'earlier' },
      ],
      head: 'c2',
    })
    const rows = toISCMHistoryItemViewModelArray([...model.items], undefined, model.headRef)
    expect(rows[0]?.kind).toBe('HEAD')
    expect(rows[1]?.kind).toBe('node')
  })
})

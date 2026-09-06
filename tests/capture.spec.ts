/**
 * dsh-striatum — capture 单元测试:从 tool/result 事件提取 diffs。
 */
import { describe, expect, it } from 'vitest'
import { diffsOfEvent } from '../src/host/capture.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function toolResultEvent(meta: unknown): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: 1 as never,
    data: {
      turn: 1,
      step: 2,
      message: { role: 'user', content: [], source: { kind: 'tool', callId: 'c1' as never } } as never,
      ...(meta === undefined ? {} : { meta }),
    },
  } as unknown as SessionEvent<'tool/result'>
}

describe('diffsOfEvent', () => {
  it('extracts valid diffs from meta.diffs', () => {
    const ev = toolResultEvent({
      diffs: [
        { path: '/w/a.go', oldText: 'old', newText: 'new' },
        { path: '/w/b.go', oldText: null, newText: 'fresh' },
      ],
    })
    expect(diffsOfEvent(ev)).toEqual([
      { path: '/w/a.go', oldText: 'old', newText: 'new' },
      { path: '/w/b.go', oldText: null, newText: 'fresh' },
    ])
  })

  it('returns [] when meta.diffs absent (read/grep etc.)', () => {
    expect(diffsOfEvent(toolResultEvent(undefined))).toEqual([])
    expect(diffsOfEvent(toolResultEvent({}))).toEqual([])
    expect(diffsOfEvent(toolResultEvent({ diffs: [] }))).toEqual([])
  })

  it('skips malformed entries but keeps valid ones', () => {
    const ev = toolResultEvent({
      diffs: [
        { path: '/w/a.go', oldText: 'o', newText: 'n' },
        { path: 42, oldText: 'x', newText: 'y' }, // bad path
        { path: '/w/b.go', oldText: 'o', newText: 7 }, // bad newText
        'garbage',
      ],
    })
    expect(diffsOfEvent(ev)).toEqual([{ path: '/w/a.go', oldText: 'o', newText: 'n' }])
  })
})

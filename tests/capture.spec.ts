/**
 * dsh-striatum — capture 单元测试:
 *  - diffsOfEvent:从 tool/result 提取 diffs(旧);
 *  - mutationPathOf:从 write/edit 参数提取路径;
 *  - changesOfResult:result diffs → 登记输入;write create(无 diffs)→ 按
 *    sourceEventSeqs 回查 call 补登。
 */
import { describe, expect, it } from 'vitest'
import { changesOfResult, diffsOfEvent, mutationPathOf } from '../src/host/capture.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

function toolResultEvent(
  meta: unknown,
  opts: { seq?: number; turn?: number; step?: number; callSeq?: number } = {},
): SessionEvent<'tool/result'> {
  const { seq = 5, turn = 1, step = 2, callSeq = 4 } = opts
  const event = {
    type: 'tool/result',
    seq,
    data: {
      turn,
      step,
      message: { role: 'user', content: [], source: { kind: 'tool', callId: 'c1' as never } } as never,
      ...(meta === undefined ? {} : { meta }),
    },
  } as unknown as SessionEvent<'tool/result'>
  // 模拟 surface replace 的 sourceEventSeqs 引用(call seq)
  if (callSeq !== undefined) {
    ;(event as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs = [callSeq]
  }
  return event
}

/** 构造一个日志下标=seq 的迷你 session(真实 Session 契约:seq == log 下标)。 */
function sessionWith(events: Array<SessionEvent<'tool/call' | 'tool/result'>>): Session {
  const log: unknown[] = []
  for (const event of events) {
    const index = event.seq
    while (log.length <= index) log.push(undefined)
    log[index] = event
  }
  return {
    id: 'sess-1',
    eventAt: (seq: number) => log[seq],
    snapshotEvents: () => log as SessionEvent[],
  } as unknown as Session
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

describe('mutationPathOf', () => {
  it('extracts file_path from write/edit args', () => {
    expect(mutationPathOf('write', JSON.stringify({ file_path: '/w/a.go', content: 'x' }))).toBe('/w/a.go')
    expect(mutationPathOf('edit', JSON.stringify({ file_path: '/w/a.go', old_string: 'a', new_string: 'b' }))).toBe('/w/a.go')
  })

  it('returns null for non-mutators / malformed', () => {
    expect(mutationPathOf('read', '{}')).toBeNull()
    expect(mutationPathOf('bash', '{}')).toBeNull()
    expect(mutationPathOf('write', 'not json')).toBeNull()
    expect(mutationPathOf('write', JSON.stringify({}))).toBeNull()
    expect(mutationPathOf('write', JSON.stringify({ file_path: '' }))).toBeNull()
  })
})

describe('changesOfResult', () => {
  const callEvent = (seq: number, name: string, filePath: string): SessionEvent<'tool/call'> =>
    ({
      type: 'tool/call',
      seq,
      data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify({ file_path: filePath, content: 'y' }) },
    }) as unknown as SessionEvent<'tool/call'>

  it('maps result diffs to ChangeInput with seq', () => {
    const call = callEvent(4, 'edit', '/w/a.go')
    const result = toolResultEvent({
      diffs: [{ path: '/w/a.go', oldText: 'o', newText: 'n' }],
    }, { seq: 5, callSeq: 4 })
    const changes = changesOfResult(sessionWith([call, result]), result)
    expect(changes).toEqual([{
      turn: 1, step: 2, seq: 5, path: '/w/a.go', oldText: 'o', newText: 'n',
    }])
  })

  it('create write (no diffs) falls back to the paired call path', () => {
    const call = callEvent(4, 'write', '/w/new.go')
    const result = toolResultEvent(undefined, { seq: 5, callSeq: 4 })
    const changes = changesOfResult(sessionWith([call, result]), result)
    expect(changes).toEqual([{
      turn: 1, step: 2, seq: 5, path: '/w/new.go', oldText: null, newText: '',
    }])
  })

  it('non-write result without diffs yields nothing', () => {
    const call = callEvent(4, 'bash', '/w/ignored')
    const result = toolResultEvent(undefined, { seq: 5, callSeq: 4 })
    expect(changesOfResult(sessionWith([call, result]), result)).toEqual([])
  })

  it('create write with no citable call yields nothing (malformed log)', () => {
    const result = toolResultEvent(undefined, { seq: 5, callSeq: 99 }) // call seq missing
    expect(changesOfResult(sessionWith([result]), result)).toEqual([])
  })
})

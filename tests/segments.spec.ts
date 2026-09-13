/**
 * dsh-striatum — segmentsOf 单测:整文件画布与改动块的编排。
 *
 * 这里防的是"接受一块后画面错位/内容缺失"那类 bug —— 片段与文件行必须严格
 * 对齐、不重叠、不丢行。
 */
import { describe, expect, it } from 'vitest'
import type { HunkView } from '../src/shared/wire.ts'
import { contentLines, segmentsOf } from '../src/client/segments.ts'

/** 造一个只用于定位的 hunk(内容字段对编排无影响)。 */
function hunk(index: number, newStart: number, newLines: number): HunkView {
  return { index, newStart, newLines, lines: [], added: 1, removed: 1 }
}

/** 把片段还原成「画布上实际占用的行数」,用于核对不丢行。 */
function coveredLines(lines: readonly string[], segs: ReturnType<typeof segmentsOf>): string[] {
  const out: string[] = []
  for (const seg of segs) {
    if (seg.kind === 'plain') out.push(...seg.lines)
    else {
      // hunk 覆盖 new 侧区段 → 从原文取这些行
      const start = seg.hunk.newStart - 1
      out.push(...lines.slice(start, start + seg.hunk.newLines))
    }
  }
  return out
}

describe('contentLines', () => {
  it('treats empty text as zero lines', () => {
    expect(contentLines('')).toEqual([])
  })
  it('does not add a phantom line for a trailing newline', () => {
    expect(contentLines('a\nb\n')).toEqual(['a', 'b'])
  })
  it('keeps an interior blank line', () => {
    expect(contentLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})

describe('segmentsOf', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  const lines = contentLines(text.join('\n') + '\n')

  it('returns one plain segment when there are no hunks', () => {
    const segs = segmentsOf(lines, [])
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'plain', from: 0 })
    expect(coveredLines(lines, segs)).toEqual(lines)
  })

  it('splits a covered middle into a hunk between two plain segments', () => {
    // hunk 覆盖第 4..6 行(1-based)
    const segs = segmentsOf(lines, [hunk(0, 4, 3)])
    expect(segs.map(s => s.kind)).toEqual(['plain', 'hunk', 'plain'])
    expect(segs[0]).toMatchObject({ from: 0 })
    expect((segs[0] as { lines: string[] }).lines).toEqual(['line 1', 'line 2', 'line 3'])
    expect((segs[2] as { lines: string[] }).lines).toEqual(['line 7', 'line 8', 'line 9', 'line 10'])
    // 不丢行、不重复
    expect(coveredLines(lines, segs)).toEqual(lines)
  })

  it('handles a hunk at the very top', () => {
    const segs = segmentsOf(lines, [hunk(0, 1, 4)])
    expect(segs.map(s => s.kind)).toEqual(['hunk', 'plain'])
    expect(coveredLines(lines, segs)).toEqual(lines)
  })

  it('handles a hunk at the very bottom', () => {
    const segs = segmentsOf(lines, [hunk(0, 8, 3)])
    expect(segs.map(s => s.kind)).toEqual(['plain', 'hunk'])
    expect(coveredLines(lines, segs)).toEqual(lines)
  })

  it('orders multiple hunks and never overlaps them', () => {
    const segs = segmentsOf(lines, [hunk(1, 7, 2), hunk(0, 2, 2)])
    expect(segs.map(s => s.kind)).toEqual(['plain', 'hunk', 'plain', 'hunk', 'plain'])
    expect(coveredLines(lines, segs)).toEqual(lines)
  })

  it('drops an overlapping or out-of-range hunk instead of corrupting the canvas', () => {
    // 第二个块与第一个重叠 → 被跳过,画布仍完整
    const segs = segmentsOf(lines, [hunk(0, 2, 5), hunk(1, 4, 2)])
    expect(segs.filter(s => s.kind === 'hunk')).toHaveLength(1)
    expect(coveredLines(lines, segs)).toEqual(lines)
    // 完全越界 → 只剩普通段
    const segs2 = segmentsOf(lines, [hunk(0, 99, 1)])
    expect(segs2.map(s => s.kind)).toEqual(['plain'])
    expect(coveredLines(lines, segs2)).toEqual(lines)
  })

  it('covers the whole file even for a single full-file hunk (a created file)', () => {
    const segs = segmentsOf(lines, [hunk(0, 1, lines.length)])
    expect(segs).toHaveLength(1)
    expect(segs[0]!.kind).toBe('hunk')
    expect(coveredLines(lines, segs)).toEqual(lines)
  })
})

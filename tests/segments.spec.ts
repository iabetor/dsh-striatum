/**
 * dsh-striatum — segmentsOf 单测:整文件画布与改动块的编排。
 *
 * 这里防的是"接受一块后画面错位/内容缺失"那类 bug —— 片段与文件行必须严格
 * 对齐、不重叠、不丢行。
 */
import { describe, expect, it } from 'vitest'
import type { HunkView } from '../src/shared/wire.ts'
import { contentLines, PLAIN_FOLD_KEEP, segmentsOf, withFoldedPlain } from '../src/client/segments.ts'

/** 造一个只用于定位的 hunk(内容字段对编排无影响)。 */
function hunk(index: number, newStart: number, newLines: number): HunkView {
  return { index, oldStart: newStart, oldLines: newLines, newStart, newLines, lines: [], added: 1, removed: 1 }
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

/**
 * 折叠是**给 DOM 行数封顶**的手段:本视图画整份文件,万行文件全量进 DOM 会拖垮
 * 渲染。这里锁三件事:短段不动、长段只折叠中段(改动相邻的上下文永远可见)、
 * 展开后能还原成原样。
 */
describe('withFoldedPlain', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`)

  it('leaves a short segment untouched', () => {
    const segs = segmentsOf(big.slice(0, 50), [])
    const items = withFoldedPlain(segs, new Set())
    expect(items.map(i => i.kind)).toEqual(['plain'])
    expect((items[0] as { lines: string[] }).lines).toHaveLength(50)
  })

  it('folds a long segment into head, marker, and tail', () => {
    const segs = segmentsOf(big, [])
    const items = withFoldedPlain(segs, new Set())
    expect(items.map(i => i.kind)).toEqual(['plain', 'fold', 'plain'])
    const head = items[0] as Extract<typeof items[number], { kind: 'plain' }>
    const fold = items[1] as Extract<typeof items[number], { kind: 'fold' }>
    const tail = items[2] as Extract<typeof items[number], { kind: 'plain' }>
    expect(head.lines).toHaveLength(PLAIN_FOLD_KEEP)
    expect(tail.lines).toHaveLength(PLAIN_FOLD_KEEP)
    // 折叠掉的是中段,首尾之和 + 折叠数 = 原文行数(不丢不重)
    expect(head.lines.length + fold.hidden + tail.lines.length).toBe(big.length)
    // 段起点供展开时回写,不是缺口起点
    expect(fold.segmentFrom).toBe(0)
    // 尾部行号连续接上缺口之后
    expect(tail.lines[0]).toBe(`line ${big.length - PLAIN_FOLD_KEEP + 1}`)
  })

  it('restores the segment exactly when its start is in the expanded set', () => {
    const segs = segmentsOf(big, [])
    const items = withFoldedPlain(segs, new Set([0]))
    expect(items.map(i => i.kind)).toEqual(['plain'])
    expect((items[0] as Extract<typeof items[number], { kind: 'plain' }>).lines).toEqual(big)
  })

  it('keeps hunk-adjacent context visible by folding only the far segments', () => {
    // 改动在第 250 行:前后两段各 ~247 行,都超阈值 → 各自折叠,改动本身不受影响
    const segs = segmentsOf(big, [hunk(0, 250, 1)])
    const items = withFoldedPlain(segs, new Set())
    expect(items.map(i => i.kind)).toEqual(['plain', 'fold', 'plain', 'hunk', 'plain', 'fold', 'plain'])
    expect(items.filter(i => i.kind === 'hunk')).toHaveLength(1)
    // 折叠后总渲染行数远小于原文
    const rendered = items.reduce((n, i) => n + (i.kind === 'plain' ? i.lines.length : i.kind === 'fold' ? 1 : 0), 0)
    expect(rendered).toBeLessThan(big.length / 2)
  })
})

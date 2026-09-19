/**
 * dsh-striatum — 改动概览标尺的位置计算测试。
 *
 * 标尺要在长文件里标出改动位置,位置算错就会"点了跳不到"或标记叠在一起。
 */
import { describe, expect, it } from 'vitest'
import type { HunkView } from '../src/shared/wire.ts'
import { MIN_MARK_PERCENT, centerScrollTop, rulerMarks } from '../src/client/ruler.ts'

/** 造一个只关心定位字段的 hunk。 */
function hunk(index: number, newStart: number, added = 1, removed = 1): HunkView {
  return { index, oldStart: newStart, oldLines: removed + 3, newStart, newLines: added + 3, lines: [], added, removed }
}

describe('rulerMarks', () => {
  it('returns nothing without hunks or with a non-positive line count', () => {
    expect(rulerMarks(100, [])).toEqual([])
    expect(rulerMarks(0, [hunk(0, 1)])).toEqual([])
    expect(rulerMarks(-5, [hunk(0, 1)])).toEqual([])
  })

  it('maps the first and last lines to the top and bottom of the ruler', () => {
    const first = rulerMarks(100, [hunk(0, 1)])[0]!
    expect(first.topPercent).toBe(0)
    const last = rulerMarks(100, [hunk(0, 100)])[0]!
    expect(last.topPercent).toBeCloseTo(99, 5)
  })

  it('orders marks by position regardless of input order', () => {
    const marks = rulerMarks(100, [hunk(9, 80), hunk(1, 10), hunk(5, 50)])
    expect(marks.map(m => m.line)).toEqual([10, 50, 80])
    expect(marks.map(m => m.index)).toEqual([1, 5, 9])
  })

  it('gives a one-line hunk a visible minimum height', () => {
    // 1000 行文件里的单行改动:比例高度约 0.1%,但必须给到最小可见高度
    const marks = rulerMarks(1000, [hunk(0, 500, 1, 0)])
    expect(marks[0]!.heightPercent).toBe(MIN_MARK_PERCENT)
  })

  it('never lets a mark overflow past the ruler bottom', () => {
    const marks = rulerMarks(10, [hunk(0, 10, 50, 0)])
    expect(marks[0]!.topPercent + marks[0]!.heightPercent).toBeLessThanOrEqual(100)
  })

  it('classifies the tone from the add/remove counts', () => {
    expect(rulerMarks(10, [hunk(0, 1, 3, 0)])[0]!.tone).toBe('add')
    expect(rulerMarks(10, [hunk(0, 1, 0, 3)])[0]!.tone).toBe('del')
    expect(rulerMarks(10, [hunk(0, 1, 1, 1)])[0]!.tone).toBe('mix')
  })

  it('clamps a line number beyond the file into range', () => {
    const marks = rulerMarks(10, [hunk(0, 999)])
    expect(marks[0]!.line).toBe(10)
    expect(marks[0]!.topPercent).toBeLessThanOrEqual(100)
  })
})

describe('centerScrollTop', () => {
  it('centers the element in the viewport', () => {
    // 元素在 1000px 处、高 100;视口 400 → 目标 = 1000 - 150 = 850
    expect(centerScrollTop(1000, 100, 400, 5000)).toBe(850)
  })

  it('clamps at the top so it never scrolls above the content', () => {
    expect(centerScrollTop(10, 100, 400, 5000)).toBe(0)
  })

  it('clamps at the bottom so it never scrolls past the content', () => {
    // 内容 1000、视口 400 → 最大 scrollTop = 600
    expect(centerScrollTop(980, 100, 400, 1000)).toBe(600)
  })

  it('returns 0 when the content is shorter than the viewport', () => {
    expect(centerScrollTop(50, 20, 400, 200)).toBe(0)
  })
})

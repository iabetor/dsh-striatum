/**
 * dsh-striatum — hunkRows 单测:改动块的逐行渲染计划与高亮下标。
 *
 * 这里防的是**高亮取错行**那类 bug:一行代码看着"有颜色",但取的是别的行的
 * token。写这段时确实踩到过 —— 旧侧下标若只在 `del` 时递增,而 `context` 排在
 * `del` 之前(3 行上下文的常态),删除行就会取到上下文行的高亮。
 */
import { describe, expect, it } from 'vitest'
import type { HunkLineView, HunkView } from '../src/shared/wire.ts'
import { hunkHeaderOf, hunkRows, oldSideLines } from '../src/client/segments.ts'

/** 造一个带真实 lines 的改动块。 */
function hunkOf(lines: HunkLineView[], newStart = 1, oldStart = newStart): HunkView {
  return {
    index: 0,
    oldStart,
    oldLines: lines.filter(l => l.kind !== 'add').length,
    newStart,
    newLines: lines.filter(l => l.kind !== 'del').length,
    lines,
    added: lines.filter(l => l.kind === 'add').length,
    removed: lines.filter(l => l.kind === 'del').length,
  }
}

const ctx = (text: string): HunkLineView => ({ kind: 'context', text })
const del = (text: string): HunkLineView => ({ kind: 'del', text })
const add = (text: string): HunkLineView => ({ kind: 'add', text })

describe('oldSideLines', () => {
  it('keeps context and del in file order, dropping add', () => {
    const hunk = hunkOf([ctx('A'), del('B'), add('C'), ctx('D')])
    expect(oldSideLines(hunk)).toEqual(['A', 'B', 'D'])
  })

  it('is empty for a pure insertion', () => {
    expect(oldSideLines(hunkOf([ctx('A'), add('B')]))).toEqual(['A'])
  })
})

describe('hunkRows', () => {
  it('numbers new-side lines from newStart and leaves del unnumbered', () => {
    const rows = hunkRows(hunkOf([ctx('A'), del('B'), add('C'), ctx('D')], 10))
    expect(rows.map(r => r.newLineNo)).toEqual([10, null, 11, 12])
  })

  it('marks each line kind with its diff marker', () => {
    const rows = hunkRows(hunkOf([ctx('A'), del('B'), add('C')]))
    expect(rows.map(r => r.marker)).toEqual([' ', '-', '+'])
    expect(rows.map(r => r.kind)).toEqual(['context', 'del', 'add'])
  })

  it('assigns del rows an old-side index that matches oldSideLines', () => {
    // 关键回归:context 排在 del 前面时,oldIndex 必须把 context 也算进去,
    // 否则删除行会取到上下文行的高亮(颜色错位,肉眼不易察觉)。
    const hunk = hunkOf([ctx('A'), ctx('B'), del('OLD-C'), add('NEW-C'), ctx('D')])
    const old = oldSideLines(hunk)
    const rows = hunkRows(hunk)
    for (const row of rows) {
      if (row.kind !== 'del') continue
      expect(old[row.oldIndex!]).toBe(row.text)
    }
  })

  it('points every del row at its own text, for several dels', () => {
    const hunk = hunkOf([ctx('A'), del('X'), del('Y'), add('Z'), ctx('B'), del('W')])
    const old = oldSideLines(hunk)
    const rows = hunkRows(hunk)
    const dels = rows.filter(r => r.kind === 'del')
    expect(dels.map(r => old[r.oldIndex!])).toEqual(['X', 'Y', 'W'])
  })

  it('leaves oldIndex null for non-del lines', () => {
    const rows = hunkRows(hunkOf([ctx('A'), del('B'), add('C')]))
    expect(rows.map(r => r.oldIndex)).toEqual([0, 1, null])
  })

  it('keeps the new-side line number continuous across a del/add pair', () => {
    // 替换一行:del 不占新侧号,add 接替该号位。
    const rows = hunkRows(hunkOf([ctx('A'), del('B'), add('B2'), ctx('C')], 5))
    expect(rows.map(r => r.newLineNo)).toEqual([5, null, 6, 7])
  })

  it('handles a pure insertion at the file start', () => {
    const rows = hunkRows(hunkOf([add('NEW'), ctx('A')], 1))
    expect(rows.map(r => r.newLineNo)).toEqual([1, 2])
    expect(rows.map(r => r.oldIndex)).toEqual([null, 0])
  })

  it('preserves row order and text verbatim', () => {
    const lines = [ctx('keep 1'), del('gone'), add('fresh'), ctx('keep 2')]
    const rows = hunkRows(hunkOf(lines))
    expect(rows.map(r => r.text)).toEqual(lines.map(l => l.text))
  })

  /**
   * 双侧行号栏(官方 ReviewTab 观感)。旧侧自 oldStart 起算,context 与 del
   * 各占一号、add 不占;新侧自 newStart 起算,context 与 add 各占一号、del 不占。
   * 两侧起点可以不同 —— 官方那套 `@@ -a,b +c,d @@` 正是靠这个。
   */
  it('numbers both sides independently from their own start lines', () => {
    const hunk = hunkOf([ctx('A'), del('B'), add('B2'), ctx('C')], 5, 9)
    const rows = hunkRows(hunk)
    expect(rows.map(r => r.oldLineNo)).toEqual([9, 10, null, 11])
    expect(rows.map(r => r.newLineNo)).toEqual([5, null, 6, 7])
  })

  it('leaves the old gutter empty for an add and the new gutter empty for a del', () => {
    const rows = hunkRows(hunkOf([del('gone'), add('fresh')], 3, 7))
    expect(rows.map(r => [r.oldLineNo, r.newLineNo])).toEqual([[7, null], [null, 3]])
  })

  it('gives a pure insertion no old-side numbers at all', () => {
    // 旧侧栏整体留空;context 行仍从 oldStart 起算。
    const rows = hunkRows(hunkOf([add('NEW'), ctx('A')], 1, 1))
    expect(rows.map(r => r.oldLineNo)).toEqual([null, 1])
  })
})

describe('hunkHeaderOf', () => {
  it('renders the unified-diff @@ header from both sides', () => {
    const hunk = { ...hunkOf([ctx('A'), del('B'), add('B2')], 5, 9), oldLines: 2, newLines: 3 }
    expect(hunkHeaderOf(hunk)).toBe('@@ -9,2 +5,3 @@')
  })

  it('renders a pure insertion with an empty old side and oldStart 1', () => {
    // 实测 `diff` 库的行为:''→'x\ny\n' 给的是 -1,0,不是 git 新建文件的 -0,0。
    const hunk = { ...hunkOf([add('NEW')], 1, 1), oldLines: 0, newLines: 1 }
    expect(hunkHeaderOf(hunk)).toBe('@@ -1,0 +1,1 @@')
  })
})

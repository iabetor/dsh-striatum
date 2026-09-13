/**
 * dsh-striatum — hunk 计算与 keep/undo 语义测试。
 *
 * 核心模型:不持久化 hunk,每次从 (baseline, current) 现算。accept 前移 baseline,
 * revert 改写 current。这里验证它在多块、漂移、失败等场景下都成立。
 */
import { describe, expect, it } from 'vitest'
import { acceptHunk, hunkTotals, hunksOf, revertHunk } from '../src/host/hunks.ts'

/** 造一个 n 行文件。 */
function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
}

/** 替换某一整行(1-based)。 */
function replaceLine(text: string, n: number, replacement: string): string {
  const arr = text.split('\n')
  arr[n - 1] = replacement
  return arr.join('\n')
}

describe('hunksOf', () => {
  it('returns nothing for identical sides', () => {
    expect(hunksOf('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('splits well-separated changes into separate hunks (context=3)', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')
    const hunks = hunksOf(base, cur)
    expect(hunks).toHaveLength(2)
    expect(hunks.map(h => h.index)).toEqual([0, 1])
  })

  it('merges nearby changes into one hunk', () => {
    const base = lines(20)
    // 相隔 3 行 → 在 context=3 下会被合并为一块
    const cur = replaceLine(replaceLine(base, 5, 'line 5 CHANGED'), 9, 'line 9 CHANGED')
    expect(hunksOf(base, cur)).toHaveLength(1)
  })

  it('treats a new file (empty baseline) as all-add, with no phantom removal', () => {
    const hunks = hunksOf('', 'a\nb\nc\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.added).toBe(3)
    expect(hunks[0]!.removed).toBe(0)
    // 空基线 → 没有删除行,全部是 add(不产生 del:'' 那种幻影行)
    expect(hunks[0]!.lines.every(l => l.kind === 'add')).toBe(true)
  })

  it('reports each hunk position in the current file (for whole-file overlay)', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')
    const hunks = hunksOf(base, cur)
    expect(hunks).toHaveLength(2)
    // 第 3 行在 new 侧仍是第 3 行;第 18 行仍是第 18 行(等长替换)
    expect(hunks[0]!.newStart).toBe(1) // hunk 含前后上下文,故从第 1 行起
    expect(hunks[1]!.newStart).toBe(15)
    // 逐行内容里必须出现 del/add 各一行
    expect(hunks[0]!.lines.filter(l => l.kind === 'del').map(l => l.text)).toEqual(['line 3'])
    expect(hunks[0]!.lines.filter(l => l.kind === 'add').map(l => l.text)).toEqual(['line 3 CHANGED'])
  })

  it('counts +/- lines per hunk', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'
    const cur = replaceLine(base, 2, 'B').replace('line', 'line') // b -> B
    const hunks = hunksOf(base, cur)
    const t = hunkTotals(hunks)
    expect(t.added).toBe(1)
    expect(t.removed).toBe(1)
  })
})

describe('acceptHunk', () => {
  it('advances the baseline by exactly one hunk, keeping the other pending', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')
    expect(hunksOf(base, cur)).toHaveLength(2)

    const next = acceptHunk(base, cur, 0)
    expect(next).not.toBeNull()
    // 接受第 1 块后:基线含 CHANGED(第3行),但仍与 current 差第 18 行 → 剩 1 块
    expect(next).toContain('line 3 CHANGED')
    expect(hunksOf(next!, cur)).toHaveLength(1)
  })

  it('accepting every hunk makes the baseline equal the current content', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')

    let b = base
    // 每接受一块,剩余块索引会重排,所以总是接受第 0 块
    for (let guard = 0; guard < 10 && hunksOf(b, cur).length > 0; guard++) {
      const next = acceptHunk(b, cur, 0)
      expect(next).not.toBeNull()
      b = next!
    }
    expect(b).toBe(cur)
    expect(hunksOf(b, cur)).toEqual([])
  })

  it('returns null for an out-of-range index', () => {
    const base = lines(20)
    const cur = replaceLine(base, 3, 'line 3 CHANGED')
    expect(acceptHunk(base, cur, 5)).toBeNull()
  })
})

describe('revertHunk', () => {
  it('restores only the targeted hunk on disk', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')

    const next = revertHunk(base, cur, 0)
    expect(next).not.toBeNull()
    // 第 3 行复原,第 18 行的改动保留
    expect(next!.split('\n')[2]).toBe('line 3')
    expect(next!.split('\n')[17]).toBe('line 18 CHANGED')
  })

  it('reverting every hunk returns the file to the baseline', () => {
    const base = lines(20)
    let cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')

    for (let guard = 0; guard < 10 && hunksOf(base, cur).length > 0; guard++) {
      const next = revertHunk(base, cur, 0)
      expect(next).not.toBeNull()
      cur = next!
    }
    expect(cur).toBe(base)
  })

  it('keep-then-revert: an accepted hunk survives a later revert of the rest', () => {
    const base = lines(20)
    const cur = replaceLine(replaceLine(base, 3, 'line 3 CHANGED'), 18, 'line 18 CHANGED')

    // 接受第 1 块(基线前移),再撤销剩下的
    const accepted = acceptHunk(base, cur, 0)
    expect(accepted).not.toBeNull()
    const after = revertHunk(accepted!, cur, 0)
    expect(after).not.toBeNull()
    // 已接受的第 3 行保留,未接受的第 18 行被撤销
    expect(after).toContain('line 3 CHANGED')
    expect(after!.split('\n')[17]).toBe('line 18')
  })

  it('external drift re-derives a fresh hunk instead of going stale', () => {
    // 因为每次从 (baseline, current) 现算,不存在"过期 hunk":外部把第 3 行改成
    // 别的内容后,hunk 是"line 3 → line 3 SOMETHING ELSE",撤销它即回到 line 3。
    const base = lines(20)
    const cur = replaceLine(base, 3, 'line 3 CHANGED')
    const drifted = replaceLine(cur, 3, 'line 3 SOMETHING ELSE')
    const next = revertHunk(base, drifted, 0)
    expect(next).not.toBeNull()
    expect(next!.split('\n')[2]).toBe('line 3')
  })

  it('returns null when there is nothing left to revert', () => {
    // baseline 与 current 相同时没有任何块 → 索引无效
    const base = lines(20)
    expect(revertHunk(base, base, 0)).toBeNull()
  })

  it('returns null for an out-of-range index', () => {
    const base = lines(20)
    const cur = replaceLine(base, 3, 'line 3 CHANGED')
    expect(revertHunk(base, cur, 9)).toBeNull()
  })
})

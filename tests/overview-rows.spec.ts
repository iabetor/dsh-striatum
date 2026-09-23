/**
 * dsh-striatum — 总览条行内文案的判定。
 *
 * `spansMultipleTurns` 决定逐行要不要标「第 N 轮」。这个判断容易写错成"看单个文件
 * 涉及几轮",而正确的问法是"这批改动总共涉及几轮" —— 一个文件只涉及一轮、但另一个
 * 文件涉及另一轮时,第一行同样需要标出轮次。
 *
 * 从 overview-rows.ts 导入而非组件:组件会拉进官方 ui-primitives,而它在 Node
 * 测试环境解析不到传递依赖(浏览器侧由 shell 提供,不影响运行)。
 */
import { describe, expect, it } from 'vitest'
import { spansMultipleTurns } from '../src/client/overview-rows.ts'

describe('spansMultipleTurns', () => {
  it('is false when every file belongs to one turn', () => {
    // 截图里的情形:9 个文件全在第 21 轮 → 不该逐行重复「第 21 轮」。
    expect(spansMultipleTurns([{ turns: [21] }, { turns: [21] }, { turns: [21] }])).toBe(false)
  })

  it('is false for a single file touched in one turn', () => {
    expect(spansMultipleTurns([{ turns: [7] }])).toBe(false)
  })

  it('is true when different files belong to different turns', () => {
    // 关键:每个文件各自只有一轮,但这批改动跨了两轮。
    expect(spansMultipleTurns([{ turns: [20] }, { turns: [21] }])).toBe(true)
  })

  it('is true when one file itself spans several turns', () => {
    expect(spansMultipleTurns([{ turns: [19, 21] }])).toBe(true)
  })

  it('is false for an empty list', () => {
    expect(spansMultipleTurns([])).toBe(false)
  })
})

/**
 * dsh-striatum — StatBadge 的渲染测试。
 *
 * 断言**渲染出的文本**,而不是内部状态:这个组件的全部价值就在于"屏幕上出现
 * `+3 -1`",内部有个 `added` 字段并不说明这一点。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { StatBadge, totalStats } from '../src/client/StatBadge.tsx'
import { zh } from '../src/client/locales.ts'

/** 用真实中文字典做占位符替换,顺带验证键确实存在。 */
function t(key: string, params?: Record<string, unknown>): string {
  const raw = (zh as Record<string, string>)[key]
  if (raw === undefined) throw new Error(`missing locale key: ${key}`)
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

/** 渲染成纯文本(去掉标签,只留可读内容)。 */
function textOf(props: Parameters<typeof StatBadge>[0]): string {
  const html = renderToStaticMarkup(createElement(StatBadge, props) as never)
  return html.replace(/<[^>]*>/g, '')
}

describe('StatBadge', () => {
  it('renders additions and removals', () => {
    expect(textOf({ added: 3, removed: 1, t: t as never })).toBe('+3-1')
  })

  it('renders a zero side rather than hiding it', () => {
    // +69 -0 是有信息量的("只加不减"),不能把 0 藏掉。
    expect(textOf({ added: 69, removed: 0, t: t as never })).toBe('+69-0')
  })

  it('renders nothing when neither number is known', () => {
    // 关键:宁可没有统计,也不显示 +0 -0 把"不知道"谎报成"没改动"。
    expect(textOf({ added: undefined, removed: undefined, t: t as never })).toBe('')
  })

  it('uses the same colors as the diff view for add and remove', () => {
    const html = renderToStaticMarkup(createElement(StatBadge, { added: 1, removed: 2, t: t as never }) as never)
    expect(html).toContain('#27ae60') // 新增:绿
    expect(html).toContain('#c0392b') // 删除:红
  })
})

describe('totalStats', () => {
  it('sums the files that have numbers', () => {
    expect(totalStats([{ added: 3, removed: 1 }, { added: 69, removed: 0 }]))
      .toEqual({ added: 72, removed: 1, uncounted: 0 })
  })

  it('reports uncounted files instead of silently treating them as zero', () => {
    // 读不到的文件没有数字;当成 0 会让合计偏小而不自知,所以要回报个数。
    expect(totalStats([{ added: 3, removed: 1 }, {}]))
      .toEqual({ added: 3, removed: 1, uncounted: 1 })
  })

  it('reports every file as uncounted when none has numbers', () => {
    expect(totalStats([{}, {}])).toEqual({ added: 0, removed: 0, uncounted: 2 })
  })

  it('returns a zero sum for an empty list', () => {
    expect(totalStats([])).toEqual({ added: 0, removed: 0, uncounted: 0 })
  })
})

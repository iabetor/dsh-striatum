/**
 * dsh-striatum — 预览头部与换行开关的渲染测试。
 *
 * 断言**渲染出的内容**:头部是视觉特性,"有个 state 字段"不说明屏幕上出现了东西。
 * 组件本身不导出,故经 ChangesBody 的完整渲染覆盖(与浏览器同一条路径)。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChangesBody } from '../src/client/ChangesBody.tsx'
import { zh } from '../src/client/locales.ts'

/** 用真实中文字典替换占位符,顺带验证键确实存在。 */
function t(key: string, params?: Record<string, unknown>): string {
  const raw = (zh as Record<string, string>)[key]
  if (raw === undefined) throw new Error(`missing locale key: ${key}`)
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

/** 渲染一个只读文件(无改动);fetchChanges 在 effect 里,SSR 不会跑。 */
function renderPlain(text: string): string {
  const lines = text.split('\n').length - 1
  return renderToStaticMarkup(createElement(ChangesBody, {
    resourceAddress: 'dsh-resource://file/session/s1//work/a.ts',
    content: { kind: 'text', text, pages: [{ offset: 0, text, lines }], eof: true },
    t: t as never,
  }) as never)
}

describe('预览头部', () => {
  it('renders the wrap toggle on a plain file', () => {
    const html = renderPlain('const a = 1\n')
    expect(html).toContain('data-striatum-header')
    expect(html).toContain('换行')
  })

  it('renders the toggle as a pressed-state switch, like the official tool', () => {
    const html = renderPlain('const a = 1\n')
    // 默认不换行 → aria-pressed 为 false。
    expect(html).toContain('aria-pressed="false"')
  })

  it('shows the filename it can derive from the resource address', () => {
    const html = renderPlain('const a = 1\n')
    // view 为 null(未跟踪)时退回地址里的路径,头部不该空着。
    expect(html).toContain('a.ts')
  })
})

describe('换行两态', () => {
  it('defaults to no-wrap so long lines scroll instead of reflowing', () => {
    // 与官方 ReviewTab 默认一致:代码长行折行会打乱缩进层次。
    const long = `const x = ${'1'.repeat(400)}\n`
    const html = renderPlain(long)
    expect(html).toContain('white-space:pre')
    expect(html).not.toContain('white-space:pre-wrap')
  })
})

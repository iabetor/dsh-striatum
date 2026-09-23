/**
 * dsh-striatum — FileLink 的截断契约。
 *
 * 这是**回归测试**:早先文件名被塞进官方 Button 的胶囊里,而官方 `.button` 是
 * `display:inline-flex; justify-content:center`,没有 `min-width:0` /
 * `overflow:hidden` / `white-space:nowrap` —— 它是给定长短标签用的。长路径因此
 * 撑开盒子并溢出,相邻项互相叠字(浏览器里实测到)。
 *
 * 断言的是**渲染出的样式**:截断要靠三层同时成立,少任何一层都只剩溢出而没有
 * 省略号,而"某个 style 对象里有 ellipsis"并不说明它真的作用在文本层上。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { FileLink } from '../src/client/FileLink.tsx'

const LONG = 'dsh-striatum/src/client/TurnTailStrip.tsx'

function render(display = LONG): string {
  return renderToStaticMarkup(createElement(FileLink, {
    display,
    path: `/w/${display}`,
    onOpen: () => {},
  }) as never)
}

/** 只读形态(总览条用:打开动作由旁边的「查看 diff」承担)。 */
function renderReadOnly(display = LONG): string {
  return renderToStaticMarkup(createElement(FileLink, {
    display,
    path: `/w/${display}`,
  }) as never)
}

describe('FileLink', () => {
  it('renders the display path as visible text', () => {
    expect(render()).toContain(LONG)
  })

  it('keeps the full path in the tooltip, not in the visible text', () => {
    // 显示短路径、悬停给全路径 —— 信息不丢,但行内不被撑开。
    expect(render()).toContain('title="/w/dsh-striatum/src/client/TurnTailStrip.tsx"')
  })

  it('truncates on a dedicated text layer', () => {
    const html = render()
    // 取文本层那个 span 的**完整**开标签(style 在 data 属性之前,不能从 data 起截)。
    const at = html.indexOf('data-striatum-file-name')
    const span = html.slice(html.lastIndexOf('<span', at), at)
    // 第三层:文本自己的三件套,缺一不可。
    expect(span).toContain('overflow:hidden')
    expect(span).toContain('text-overflow:ellipsis')
    expect(span).toContain('white-space:nowrap')
  })

  it('lets the button itself shrink so the ellipsis can engage', () => {
    const html = render()
    const at = html.indexOf('data-striatum-file-link')
    const button = html.slice(0, at)
    // 第二层:flex 子项默认 min-width:auto 不收缩,少了它文字只会溢出。
    expect(button).toContain('min-width:0')
    expect(button).toContain('max-width:280px')
  })

  it('does not put the filename inside an official Button capsule', () => {
    // 回归点:官方胶囊的 class 不应出现在这里 —— 它承载不了长文本。
    const html = render()
    expect(html).not.toMatch(/class="[^"]*\bbutton\b/)
  })

  it('renders a file type icon alongside the name', () => {
    expect(render()).toContain('<svg')
  })

  it('renders a non-interactive span when no open handler is given', () => {
    // 总览条用这个形态:打开动作由旁边的「查看 diff」按钮承担,文件名不该抢它。
    const html = renderReadOnly()
    expect(html).toContain('<span')
    expect(html).not.toContain('<button')
  })

  it('keeps the same truncation in the read-only form', () => {
    // 两种形态必须共用同一套截断,否则一处能省略、另一处溢出。
    const html = renderReadOnly()
    const at = html.indexOf('data-striatum-file-name')
    const span = html.slice(html.lastIndexOf('<span', at), at)
    expect(span).toContain('text-overflow:ellipsis')
    expect(html.slice(0, at)).toContain('min-width:0')
  })
})

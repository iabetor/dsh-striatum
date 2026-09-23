/**
 * dsh-striatum — FileLink:文件类型图标 + 可截断的文件名 + 点击打开。
 *
 * **为什么不复用官方 Button**:官方 `.button` 是 `display:inline-flex;
 * justify-content:center`,没有 `min-width:0` / `overflow:hidden` /
 * `white-space:nowrap` —— 它是给 "Keep"、"撤销" 这类**定长短标签**用的。
 * 把任意长度的文件路径塞进去,`maxWidth` 只压住盒子,文字照旧按自然宽度撑开并
 * 折行溢出,相邻项互相叠字(实测)。长路径必须由文本层自己截断。
 *
 * **截断要三层同时成立**,少一层就只剩溢出而没有省略号:
 *  1. 容器允许收缩(`minWidth: 0`,flex 子项默认 `min-width: auto` 不收缩);
 *  2. 按钮本身 `minWidth: 0` + 宽度上限;
 *  3. 文本 span `overflow: hidden` + `text-overflow: ellipsis` + `nowrap`。
 *
 * @module dsh-striatum/client/FileLink
 */
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { h, type CSSProperties } from './react.ts'

/** 单个文件链接:无边框纯文本按钮,靠省略号收窄。 */
const linkStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  minWidth: '0', maxWidth: '280px',
  border: 0, background: 'transparent', padding: '2px 4px',
  borderRadius: '6px', cursor: 'pointer', color: 'inherit',
  font: 'inherit',
}

/** 文件类型图标:不参与收缩,窄屏下不该先被压扁。 */
const iconStyle: CSSProperties = { flex: 'none', display: 'inline-flex' }

/** 文件名文本:真正被截断的那一层。 */
const textStyle: CSSProperties = {
  minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
}

/**
 * 一个文件引用:图标 + 截断的文件名。
 *
 * 传了 `onOpen` 就是可点按钮;不传则渲染成同形态的 `span`(只读展示 —— 例如总览条
 * 里另有「查看 diff」按钮,文件名本身不该抢那个动作)。两种形态共用同一套截断,
 * 不会出现一处能省略、另一处溢出。
 * @param props.display - 展示用短路径(相对会话工作区)。
 * @param props.path - 完整路径,作悬停提示(以及打开目标)。
 * @param props.onOpen - 点击回调;省略则不可点。
 * @returns 图标 + 截断文件名的元素。
 */
export function FileLink({ display, path, onOpen }: {
  display: string
  path: string
  onOpen?: (() => void) | undefined
}): ReturnType<typeof h> {
  const content = [
    h('span', { key: 'i', style: iconStyle }, h(FileTypeIcon, { path, size: 14 })),
    h('span', { key: 'n', style: textStyle, 'data-striatum-file-name': '' }, display),
  ]
  return onOpen === undefined
    ? h('span', { style: linkStyle, title: path, 'data-striatum-file-link': '' }, content)
    : h('button', {
        type: 'button',
        title: path,
        onClick: onOpen,
        style: linkStyle,
        'data-striatum-file-link': '',
      }, content)
}

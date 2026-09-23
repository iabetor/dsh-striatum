/**
 * dsh-striatum — ChangesBody:文件预览里的「改动」渲染器。
 *
 * **首先是一个文件查看器**:正文来自预览壳的座位 props(与官方 CodeBody 同源),
 * 所以 striatum 不认识的普通文件也照常显示全文。改动高亮只是叠加层 —— 这点
 * 很关键:本渲染器以 `priority: 'extension'` 排在官方渲染器之前,**会接管所有
 * 文本文件**,不能只对"有改动"的文件有效。
 *
 * 呈现方式是**整文件画布 + 改动行叠加高亮**(与 CodeBuddy 一致),而不是把改动
 * 块单独列成清单 —— 后者在用户接受某块后,那一块凭空消失,全部接受完视图就空了。
 *
 * 两级闸门并存:
 *  - hunk 级:每个改动区末尾就近一组「接受 / 撤销」,只作用于该块;
 *  - 文件级:最下方一组,接受=基线移到当前内容,撤销=整文件回到基线。
 *
 * 数据:GET /striatum/api/changes 只取**改动元数据**(hunks),不再取正文 ——
 * 正文由壳提供,避免两处读取不一致,也免去"未跟踪文件没有正文"的伪错误。
 */
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HunkView } from '../shared/wire.ts'
import { acceptHunk, fetchChanges, keep, revertHunk, undo, StriatumApiClientError } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { parseFileAddress } from './file-address.ts'
import { highlightLines, languageForPath, type HighlightedLines } from './highlight.ts'
import { centerScrollTop, rulerMarks, type RulerMark } from './ruler.ts'
import { contentLines, hunkHeaderOf, hunkRows, oldSideLines, segmentsOf, withFoldedPlain, type RenderItem } from './segments.ts'
import { StatBadge } from './StatBadge.tsx'
import { useCallback, useEffect, useMemo, useRef, useState, h, type CSSProperties } from './react.ts'

/** 本命名空间绑定的翻译函数(键集由 locales.ts 的声明约束)。 */
type T = TranslateNS<'striatum'>

/** 渲染器主体 props(document 座位的 owner share + 注册处注入的文案)。 */
export interface ChangesBodyProps {
  resourceAddress: string
  /** 壳加载好的文件正文(与官方渲染器同源)。 */
  content: DocumentContent
  /** 绑定 striatum 命名空间的翻译函数(注册处注入)。 */
  t: T
  /** 把本组件的滚动容器交给预览壳(滚动位置随之持久化)。 */
  scrollportRef?: (el: HTMLElement | null) => void
  /**
   * 请预览壳重读本文件。
   *
   * 本组件会**写**它显示的文件(撤销 hunk / 整文件回退),写完后壳手里的正文就
   * 过期了。壳只会在下一次元数据帧发现版本变化,然后亮出「文件已更新,当前显示
   * 为旧内容」的提示条等用户点 —— 对读者没做过的改动这是对的,但这次改动是本
   * 组件刚做的,自己就能报告。调这个即走壳自己的重读路径,页面、观察到的版本、
   * 提示条一步落定(滚动位置保留)。
   *
   * 应对的是"插件与预览器版本不同步":旧预览器不传这个 props 时为空,此时退回
   * 不刷新(维持既有行为)。
   */
  reload?: () => void
}

const wrapStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  fontSize: '12px',
  overflow: 'hidden',
}

/** 画布 + 标尺的一行:占满剩余高度,标尺不参与滚动。 */
const rowStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: '0',
  display: 'flex',
  alignItems: 'stretch',
}

/**
 * 头部:文件名 + 统计 + 工具按钮。几何照官方 `.header`(38px 高、底部细边框)。
 *
 * 官方那行还带文件下拉选择器;这里不重复 —— 文件名与左邻的文件树已经说明了
 * 当前文件,再加一个单选项下拉没有信息量。
 */
const headerStyle: CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  gap: '6px',
  alignItems: 'center',
  boxSizing: 'border-box',
  height: '38px',
  padding: '0 6px 0 8px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
  color: 'var(--dsw-alias-label-primary)',
}

/** 头部里的文件名:可省略,不挤走右侧工具。 */
const headerPathStyle: CSSProperties = {
  minWidth: '0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
  fontSize: '12px',
}

/**
 * 标尺上改动标记的配色:与改动行**同一批 token**。
 *
 * 早先写死 `#27ae60`/`#c0392b`/`#d68910`:浅色主题下会脏,而且与改动行的
 * `color-mix` 底色对不上 —— 同一处改动在标尺和正文里是两个颜色。
 * @param tone - 该标记的类型。
 * @returns 该类型的颜色。
 */
function markColor(tone: RulerMark['tone']): string {
  if (tone === 'add') return 'var(--dsw-alias-state-success-primary, #27ae60)'
  if (tone === 'del') return 'var(--dsw-alias-state-error-primary, #c0392b)'
  // 混合块(既有增又有删):没有对应的官方语义色,保留琥珀色。
  return '#d68910'
}

/**
 * 整文件画布:等宽、可换行,行号用 grid 对齐。
 *
 * 字体与行高对齐官方 ReviewTab(`--dsw-font-markdown-code-block` = 11px/19px);
 * 行网格取官方 `.line` 的四栏 `3.5em 3.5em 1.2em minmax(0,1fr)`,底色与标记色
 * 走同一批 `--dsw-alias-*` token —— 这样本视图与官方对比视图观感一致。纯文件行
 * (无改动)只填新行号栏,旧行号栏留空,列宽因此不跳动。
 */
const canvasStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: '0',
  minHeight: '0',
  overflow: 'auto',
  font: 'var(--dsw-font-markdown-code-block, 11px/19px ui-monospace, SFMono-Regular, Menlo, monospace)',
}

/** 四栏行网格(旧行号 / 新行号 / 标记 / 正文),与官方 ReviewTab 的 `.line` 同构。 */
const GRID_COLUMNS = '3.5em 3.5em 1.2em minmax(0, 1fr)'

/**
 * 行网格。`wrap` 决定长行折行还是横向滚动 —— 与官方 `.body[data-review-wrap]`
 * 的两态一致:不折行时 `pre` + 画布横向滚动,折行时 `pre-wrap` + 任意断点。
 * @param wrap - 是否折行。
 * @returns 该状态下的行样式。
 */
function gridRow(wrap: boolean): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: GRID_COLUMNS,
    minHeight: '22px',
    lineHeight: '22px',
    whiteSpace: wrap ? 'pre-wrap' : 'pre',
    ...(wrap ? { overflowWrap: 'anywhere' as const } : {}),
  }
}

/** 行号栏(旧/新共用):右对齐、不可选中、三级文案色 —— 与官方 `.number` 一致。 */
const gutterStyle: CSSProperties = {
  textAlign: 'right',
  paddingRight: '8px',
  color: 'var(--dsw-alias-label-tertiary)',
  userSelect: 'none',
  fontVariantNumeric: 'tabular-nums',
}

/** 标记栏(`+`/`-`/空格),与官方 `.sign` 一致居中。 */
const signStyle: CSSProperties = {
  textAlign: 'center',
  userSelect: 'none',
}

const bodyCellStyle: CSSProperties = { paddingRight: '16px' }

/**
 * 改动行底色:与官方 ReviewTab 同一套 `color-mix`,不再写死 `#c0392b1f` ——
 * 写死色在浅色主题下会脏,与官方并排时肉眼可辨。
 * @param wrap - 是否折行(见 {@link gridRow})。
 */
function rowStyles(wrap: boolean): { ctx: CSSProperties, del: CSSProperties, add: CSSProperties } {
  const base = gridRow(wrap)
  return {
    ctx: { ...base },
    del: {
      ...base,
      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
    },
    add: {
      ...base,
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
    },
  }
}
const delTextStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const addTextStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }
const ctxTextStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

/** hunk 头:`@@ -a,b +c,d @@`,等宽、三级文案色 —— 与官方 `.hunkHeader` 一致。 */
const hunkHeaderStyle: CSSProperties = {
  padding: '4px 16px',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'pre',
  fontVariantNumeric: 'tabular-nums',
}

/** 折叠标记:一行高的可点条,样式与 hunk 头同族但可交互。 */
const foldStyle: CSSProperties = {
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  margin: 0,
  padding: '2px 16px',
  border: 0,
  borderTop: '0.5px solid var(--dsw-alias-border-l1)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

/** 改动区末尾的操作条:紧跟改动行,标明作用范围就是这一块。 */
const opsRowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
  padding: '3px 8px 3px 3.2em',
  background: 'var(--dsw-specific-tip, #ffffff10)',
  borderTop: '0.5px solid var(--dsw-alias-border-l1, #8884)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1, #8884)',
  marginBottom: '2px',
}

const noticeStyle: CSSProperties = { padding: '6px 10px', opacity: 0.7, flex: 'none' }

const fileFooterStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
  padding: '6px 8px',
  borderTop: '0.5px solid var(--dsw-alias-border-l1, #8884)',
  flex: 'none',
}

/** 标尺:固定在画布右侧、滚动条旁,宽度足够点中但不挡内容。 */
const rulerStyle: CSSProperties = {
  position: 'relative',
  flex: 'none',
  width: '10px',
  // 底色取官方 `.empty` 用的同一个 hover 面(theme 里**没有** `fill-l2` 这个
  // token —— 之前写它一直在走硬编码 fallback,浅色主题下会脏)。
  background: 'var(--dsw-alias-interactive-bg-hover)',
  borderLeft: '0.5px solid var(--dsw-alias-border-l3)',
}

/** 单个改动标记:一个可点的小色块。 */
const markStyle: CSSProperties = {
  position: 'absolute',
  left: '1px',
  width: '8px',
  minHeight: '3px',
  padding: 0,
  border: 'none',
  borderRadius: '2px',
  cursor: 'pointer',
  opacity: 0.85,
}

/** 操作按钮:交给官方 Button 的胶囊几何,这里只补危险色。 */
const dangerStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const statStyle: CSSProperties = { opacity: 0.6, fontVariantNumeric: 'tabular-nums' }
const spacerStyle: CSSProperties = { flex: '1 1 auto' }

/**
 * 渲染一行的高亮片段;无高亮数据时退回纯文本。
 *
 * `style` 是该行的正文色(新增/删除/上下文),高亮 span 自带颜色时优先于它。
 */
function LineBody({ text, spans, style }: {
  text: string
  spans: readonly { text: string, color: string | undefined }[] | undefined
  style?: CSSProperties | undefined
}) {
  const base = { ...bodyCellStyle, ...style }
  if (spans === undefined) return h('span', { key: 't', style: base }, text)
  return h('span', { key: 't', style: base },
    spans.map((span, i) => h('span', { key: i, style: span.color === undefined ? undefined : { color: span.color } }, span.text)))
}

/**
 * 改动块旧侧(上下文 + 删除行)的独立高亮。
 *
 * 删除行在**当前文件里已不存在**,拿不到整文件高亮的对应 token,所以按"旧侧
 * 片段"单独着色一次。必须整段一起着色 —— 多行字符串/块注释的颜色依赖跨行状态。
 * @param hunk - 改动块。
 * @param lang - grammar id。
 * @returns 旧侧逐行片段;语言未知时为 undefined。
 */
function highlightOldSide(hunk: HunkView, lang: string | undefined): HighlightedLines | undefined {
  const oldLines = oldSideLines(hunk)
  if (oldLines.length === 0) return undefined
  return highlightLines(oldLines.join('\n'), lang)
}

/**
 * 渲染一个改动区:官方 ReviewTab 的观感(双侧行号 + `@@` 头 + 底色行),
 * 外加 striatum 的 hunk 级操作条。
 *
 * 与官方的一处**必要差异**:官方每行只有一栏正文,行号是「旧|新」两栏;我们
 * 同样两栏,但正文前多一个标记栏 —— 因为官方正文里带着 `+`/`-` 前缀(来自
 * hunk.lines 的首字符),而我们这一层已经把它剥进 `marker`,再拼回字符串会与
 * 语法高亮的 span 下标打架。多一栏比重新对齐高亮下标更稳。
 */
function HunkRegion({
  hunk, t, busy, onAccept, onRevert, regionRef, allHighlight, oldHighlight, wrap,
}: {
  hunk: HunkView
  t: T
  busy: boolean
  onAccept: () => void
  onRevert: () => void
  regionRef?: (el: HTMLElement | null) => void
  /** 当前文件全文的逐行高亮(新侧:上下文 + 新增行取这里)。 */
  allHighlight: HighlightedLines | undefined
  /** 旧侧片段高亮(删除行取这里,旧文件顺序)。 */
  oldHighlight: HighlightedLines | undefined
  /** 长行是否折行(头部开关控制)。 */
  wrap: boolean
}) {
  const rows: ReturnType<typeof h>[] = []
  const styles = rowStyles(wrap)
  // 官方那种 hunk 头:让"这一块在文件的哪个位置"一眼可读,也是与官方观感
  // 最明显的一处对齐。
  rows.push(h('div', { key: 'head', style: hunkHeaderStyle }, hunkHeaderOf(hunk)))
  hunkRows(hunk).forEach((row, i) => {
    const isDel = row.kind === 'del'
    const isAdd = row.kind === 'add'
    const style = isDel ? styles.del : isAdd ? styles.add : styles.ctx
    // 正文色:新增/删除用状态色,上下文用二级文案色 —— 与官方 `.add .text` /
    // `.del .text` / `.context .text` 一致。高亮 span 自带颜色时优先。
    const textStyle = isDel ? delTextStyle : isAdd ? addTextStyle : ctxTextStyle
    // 删除行取旧侧片段,其余行取整文件高亮(下标由 hunkRows 统一算好)。
    const lineNo = row.newLineNo
    const spans = row.oldIndex !== null
      ? oldHighlight?.[row.oldIndex]
      : lineNo === null ? undefined : allHighlight?.[lineNo - 1]
    rows.push(h('div', { key: `l${i}`, style }, [
      h('span', { key: 'on', style: gutterStyle }, row.oldLineNo === null ? '' : String(row.oldLineNo)),
      h('span', { key: 'nn', style: gutterStyle }, lineNo === null ? '' : String(lineNo)),
      h('span', { key: 'sg', style: { ...signStyle, ...textStyle } }, row.marker),
      h(LineBody, { key: 't', text: row.text, style: textStyle, spans }),
    ]))
  })
  rows.push(h('div', { key: 'ops', style: opsRowStyle }, [
    h('span', { key: 'scope', style: { opacity: 0.7 } }, t('striatum.hunkScope')),
    h('span', { key: 'stat', style: statStyle }, `+${hunk.added} -${hunk.removed}`),
    h('span', { key: 'sp', style: spacerStyle }),
    // 官方 Button 胶囊(与界面其他按钮同族),不再手写边框。
    h(Button, { key: 'accept', variant: 'outline', size: 'sm', disabled: busy, onClick: onAccept },
      t('striatum.hunkAccept')),
    h(Button, { key: 'revert', variant: 'outline', size: 'sm', style: dangerStyle, disabled: busy, onClick: onRevert },
      t('striatum.hunkRevert')),
  ]))
  return h('div', { key: `hunk-${hunk.index}`, ref: regionRef }, rows)
}

/** 改动概览标尺:滚动条旁按比例标出每处改动,点击定位过去。 */
function Ruler({ marks, onJump, t }: { marks: readonly RulerMark[], onJump: (index: number) => void, t: T }) {
  if (marks.length === 0) return null
  return h('div', { style: rulerStyle, 'data-striatum-ruler': '' },
    marks.map(mark => h('button', {
      key: mark.index,
      type: 'button',
      'data-tone': mark.tone,
      title: t('striatum.rulerMark', {
        line: String(mark.line),
        added: String(mark.added),
        removed: String(mark.removed),
      }),
      'aria-label': t('striatum.rulerJump', { line: String(mark.line) }),
      style: {
        ...markStyle,
        top: `${mark.topPercent}%`,
        height: `${mark.heightPercent}%`,
        background: markColor(mark.tone),
      },
      onClick: () => { onJump(mark.index) },
    })))
}

/**
 * 折叠标记行:一行高的可点条,点击展开该普通段。
 *
 * 抽成独立组件是因为「有改动」与「只读」两条分支都要用它 —— 两处各写一份必然
 * 漂移(改了一处的文案或 data 属性,另一处忘改)。
 */
function FoldRow({
  hidden, segmentFrom, folded, onUnfold, t,
}: {
  hidden: number
  segmentFrom: number
  /** 该段当前是否处于折叠态(由调用方按 state 判定,不从 hidden 反推)。 */
  folded: boolean
  onUnfold: (segmentFrom: number) => void
  t: T
}) {
  return h('button', {
    type: 'button',
    'data-striatum-fold': folded ? '' : undefined,
    style: foldStyle,
    title: t('striatum.unfoldHint', { count: String(hidden) }),
    onClick: () => { onUnfold(segmentFrom) },
  }, t('striatum.folded', { count: String(hidden) }))
}

/**
 * 画布:把 {@link RenderItem} 序列画成四栏行。
 *
 * **两条分支共用这一个组件**(有改动 / 只读),差别只在传进来的 `items` 与
 * `renderHunk`:
 *  - 普通行、折叠标记的渲染只有一份 —— 早先两条分支各写一份,折叠就只在
 *    "有改动"那侧生效,只读侧(大文件最常见的路径)整份文件直接进 DOM;
 *  - `renderHunk` 由调用方给:只读分支不传(它的 items 里不会有 hunk 项)。
 */
function Canvas({
  items, scrollportRef, allHighlight, unfolded, onUnfold, t, renderHunk, wrap,
}: {
  items: readonly RenderItem[]
  scrollportRef?: (el: HTMLElement | null) => void
  /** 当前文件全文的逐行高亮;undefined 时退化为纯文本。 */
  allHighlight: HighlightedLines | undefined
  unfolded: ReadonlySet<number>
  onUnfold: (segmentFrom: number) => void
  t: T
  /** 改动块的渲染器;只读分支省略。 */
  renderHunk?: ((hunk: HunkView) => ReturnType<typeof h>) | undefined
  /** 长行是否折行(头部开关控制)。 */
  wrap: boolean
}) {
  const rows = rowStyles(wrap)
  return h('div', { style: canvasStyle, ref: scrollportRef },
    items.map((item, i) => item.kind === 'plain'
      // 四栏网格:旧行号栏留空、无标记 —— 纯文件行与改动行共用列宽,从"纯查看"
      // 切到"有改动"时列不会跳。
      ? h('div', { key: `p${i}` }, item.lines.map((text, j) => h('div', { key: j, style: rows.ctx }, [
          h('span', { key: 'on', style: gutterStyle }, ''),
          h('span', { key: 'nn', style: gutterStyle }, String(item.from + j + 1)),
          h('span', { key: 'sg', style: signStyle }, ' '),
          h(LineBody, { key: 't', text, style: ctxTextStyle, spans: allHighlight?.[item.from + j] }),
        ])))
      : item.kind === 'fold'
        // 折叠标记占一行,行号栏空着 —— 它不是一个真实行。
        ? h(FoldRow, {
            key: `f${i}`, hidden: item.hidden, segmentFrom: item.segmentFrom,
            folded: !unfolded.has(item.segmentFrom), onUnfold, t,
          })
        // renderHunk 返回的元素自带 key(HunkRegion 以 `hunk-${index}` 为 key),
        // 这里直接交给 map 的 key 位置,无需再包一层 Fragment。
        : renderHunk === undefined ? null : renderHunk(item.hunk)))
}

/**
 * 预览头部:文件类型图标 + 文件名 + 改动统计 + 换行开关。
 *
 * 对齐官方 ReviewTab 的头部几何(38px、底部细边框、右侧 28×28 图标键)。
 * @param props - 显示路径、统计、换行状态与其切换。
 * @returns 头部元素。
 */
function Header({ display, path, added, removed, wrap, onToggleWrap, t }: {
  display: string
  /** 查表用的绝对路径(文件类型图标按它分类)。 */
  path: string
  added: number | undefined
  removed: number | undefined
  wrap: boolean
  onToggleWrap: () => void
  t: T
}): ReturnType<typeof h> {
  return h('div', { style: headerStyle, 'data-striatum-header': '' },
    // 文件类型图标:与总览条、本轮改动条同一套识别,不再是纯文字。
    path === '' ? null : h('span', { style: { display: 'inline-flex', flex: 'none' } },
      h(FileTypeIcon, { path, size: 16 })),
    h('span', { style: headerPathStyle, title: display }, display),
    h('span', { style: { flex: '1 1 auto' } }),
    StatBadge({ added, removed, t }),
    h(Button, {
      variant: 'ghost', size: 'sm',
      // aria-pressed 与官方一致:这是开关,不是普通按钮。
      'aria-pressed': wrap,
      title: t(wrap ? 'striatum.wrap.on' : 'striatum.wrap.off'),
      onClick: onToggleWrap,
      // 开启时用主文案色 + 官方 hover 面,与"已按下"的观感一致(官方 .tool
      // 的 aria-pressed 也是这个处理)。
      style: wrap
        ? { color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-interactive-bg-hover)' }
        : undefined,
    }, t('striatum.wrapShort')),
  )
}

/**
 * 文件预览里的改动视图。
 *
 * sessionId 从资源地址解出(dsh-resource://file/session/<id>/<path>)。
 * @param props - 渲染器 owner share(正文 + 资源地址 + 文案)。
 */
export function ChangesBody({ resourceAddress, content, t, scrollportRef, reload }: ChangesBodyProps) {
  const parsed = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress])
  const [view, setView] = useState<Awaited<ReturnType<typeof fetchChanges>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canvas = useRef<HTMLElement | null>(null)
  const regions = useRef(new Map<number, HTMLElement>())
  /**
   * 长行是否换行。默认**不换行**(横向滚动),与官方 ReviewTab 的默认一致 ——
   * 代码长行折行会打乱缩进层次,横向滚动反而更好读。需要时由头部按钮切换。
   */
  const [wrap, setWrap] = useState(false)

  useEffect(() => {
    if (parsed === null) return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await fetchChanges(parsed.sessionId, parsed.path)
        if (!alive) return
        setView(next)
        setError(null)
      } catch (e) {
        if (alive) setError(e instanceof StriatumApiClientError ? e.message : String(e))
      }
    }
    void load()
    const off = subscribeStriatumEvents(() => { void load() })
    return () => { alive = false; off() }
  }, [parsed?.sessionId, parsed?.path])

  /**
   * 执行一次写操作(撤销 hunk / 接受 hunk / 整文件回退),然后刷新视图。
   *
   * 写完之后**必须请壳重读**:本渲染器的正文来自壳的座位 props,而壳不会主动
   * 重读 —— 它只在发现版本变化时亮出「文件已更新」提示条等用户点。只刷自己的
   * hunk 元数据是不够的:红绿块会消失,正文却仍是旧内容,看起来就像"撤销没生效"。
   * @param fn - 写操作。
   */
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (parsed === null) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      await Promise.all([
        fetchChanges(parsed.sessionId, parsed.path).then(setView),
        // 壳重读是异步的;不 await 也不阻塞 hunk 状态的刷新。旧版预览器没有
        // 这个能力时 reload 为空,退回原行为(用户手动点提示条)。
        Promise.resolve(reload?.()),
      ])
    } catch (e) {
      setError(e instanceof StriatumApiClientError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const text = content.kind === 'text' ? content.text : ''
  const complete = content.kind === 'text' && content.eof
  const lines = useMemo(() => contentLines(text), [text])

  // 语法高亮:整份文本一次着色(跨行状态才正确),再按行取用。
  const lang = useMemo(() => (parsed === null ? undefined : languageForPath(parsed.path)), [parsed?.path])
  const allHighlight = useMemo(() => highlightLines(text, lang), [text, lang])

  // 只在正文读全(eof)后才叠加改动:分页加载中途行号会变,叠加必然错位。
  const overlay = complete ? (view?.hunks ?? []) : []
  const segments = useMemo(() => segmentsOf(lines, overlay), [lines, overlay])
  // 已展开的普通段起点。折叠只作用于**离改动很远的空白长段**,改动块相邻的
  // 上下文永远可见;万行文件因此不会把整份正文塞进 DOM。
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set())
  // 换文件时清空展开状态,否则段起点会张冠李戴。
  useEffect(() => { setUnfolded(new Set()) }, [parsed?.sessionId, parsed?.path])
  const unfold = useCallback((segmentFrom: number) => {
    setUnfolded(prev => new Set([...prev, segmentFrom]))
  }, [])
  const items = useMemo(() => withFoldedPlain(segments, unfolded), [segments, unfolded])
  // 只读分支的折叠输入:同一套折叠,但输入是没有 hunk 的单个普通段。
  const plainItems = useMemo(
    () => withFoldedPlain(segmentsOf(lines, []), unfolded),
    [lines, unfolded],
  )
  const marks = useMemo(() => rulerMarks(lines.length, overlay), [lines.length, overlay])
  // 每个改动块的旧侧高亮(删除行专用):键为块索引。旧侧片段很小,单独着色成本可忽略。
  const oldHighlights = useMemo(
    () => new Map(overlay.map(hunk => [hunk.index, highlightOldSide(hunk, lang)])),
    [overlay, lang],
  )

  const registerRegion = useCallback((index: number) => (el: HTMLElement | null) => {
    if (el === null) regions.current.delete(index)
    else regions.current.set(index, el)
  }, [])

  /** 把某个改动滚到视口中间(标尺点击用)。 */
  const jumpTo = useCallback((index: number) => {
    const container = canvas.current
    const target = regions.current.get(index)
    if (container === null || target === undefined) return
    container.scrollTo({
      top: centerScrollTop(target.offsetTop, target.offsetHeight, container.clientHeight, container.scrollHeight),
      behavior: 'smooth',
    })
  }, [])

  const bindCanvas = useCallback((el: HTMLElement | null) => {
    canvas.current = el
    scrollportRef?.(el)
  }, [scrollportRef])

  // 正文不是文本(二进制等):本渲染器声明的是 text-pages,正常不会走到这里。
  if (content.kind !== 'text') return null

  // 无改动、或正文尚未读全:就是个纯文件查看器。
  if (overlay.length === 0) {
    return h('div', { style: wrapStyle }, [
      h(Header, {
        key: 'head',
        // 未跟踪时 view 为 null —— 用资源地址里的路径兜底,头部不至于空着。
        display: view?.display ?? parsed?.path ?? '',
        path: view?.path ?? parsed?.path ?? '',
        added: undefined,
        removed: undefined,
        wrap,
        onToggleWrap: () => { setWrap(v => !v) },
        t,
      }),
      h(Canvas, {
        key: 'plain',
        // 只读分支的 items 来自 segmentsOf(lines, []) —— 单个普通段,同样折叠。
        items: plainItems,
        scrollportRef: bindCanvas,
        allHighlight,
        unfolded,
        onUnfold: unfold,
        t,
        wrap,
      }),
      // 已跟踪但确实没有可对比内容时,给一句说明(不是错误)。
      view !== null && view.tracked && !view.hasBaseline && !view.created
        ? h('div', { key: 'note', style: noticeStyle }, t('striatum.noDiff'))
        : null,
      view !== null && view.diffLimited
        ? h('div', { key: 'big', style: noticeStyle }, t('striatum.diffLimited'))
        : null,
      error !== null
        ? h('div', { key: 'err', style: { ...noticeStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error)
        : null,
    ])
  }

  const totals = overlay.reduce(
    (acc, x) => ({ added: acc.added + x.added, removed: acc.removed + x.removed }),
    { added: 0, removed: 0 },
  )

  return h('div', { style: wrapStyle }, [
    h(Header, {
      key: 'head',
      display: view?.display ?? parsed?.path ?? '',
      path: view?.path ?? parsed?.path ?? '',
      added: totals.added,
      removed: totals.removed,
      wrap,
      onToggleWrap: () => { setWrap(v => !v) },
      t,
    }),
    h('div', { key: 'row', style: rowStyle }, [
      h(Canvas, {
        key: 'canvas',
        items,
        scrollportRef: bindCanvas,
        allHighlight,
        unfolded,
        onUnfold: unfold,
        t,
        wrap,
        renderHunk: hunk => h(HunkRegion, {
          key: `hunk-${hunk.index}`,
          hunk,
          t,
          busy,
          wrap,
          regionRef: registerRegion(hunk.index),
          allHighlight,
          oldHighlight: oldHighlights.get(hunk.index),
          onAccept: () => { void run(() => acceptHunk(parsed!.sessionId, parsed!.path, hunk.index)) },
          onRevert: () => { void run(() => revertHunk(parsed!.sessionId, parsed!.path, hunk.index)) },
        }),
      }),
      h(Ruler, { key: 'ruler', marks, onJump: jumpTo, t }),
    ]),
    view?.diffLimited === true ? h('div', { key: 'big', style: noticeStyle }, t('striatum.diffLimited')) : null,
    error !== null
      ? h('div', { key: 'err', style: { ...noticeStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error)
      : null,
    // 文件级(最下方):作用于整个文件。
    h('div', { key: 'fileops', style: fileFooterStyle }, [
      h('span', { key: 'label', style: { opacity: 0.7 } }, t('striatum.fileLevel')),
      h('span', { key: 'stat', style: statStyle }, `+${totals.added} -${totals.removed}`),
      h('span', { key: 'sp', style: spacerStyle }),
      h(Button, {
        key: 'keep',
        variant: 'outline', size: 'sm',
        disabled: busy,
        onClick: () => { void run(() => keep(parsed!.sessionId, parsed!.path)) },
      }, t('striatum.keepAllFile')),
      h(Button, {
        key: 'undo',
        variant: 'outline', size: 'sm', style: dangerStyle,
        disabled: busy || view?.canUndo !== true,
        onClick: () => { void run(() => undo(parsed!.sessionId, parsed!.path)) },
      }, t('striatum.undoFile')),
    ]),
  ])
}

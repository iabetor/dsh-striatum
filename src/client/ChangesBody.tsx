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
import type { HunkView } from '../shared/wire.ts'
import { acceptHunk, fetchChanges, keep, revertHunk, undo, StriatumApiClientError } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { parseFileAddress } from './file-address.ts'
import { highlightLines, languageForPath, type HighlightedLines } from './highlight.ts'
import { centerScrollTop, rulerMarks, type RulerMark } from './ruler.ts'
import { contentLines, hunkHeaderOf, hunkRows, oldSideLines, segmentsOf, withFoldedPlain } from './segments.ts'
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

const gridRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID_COLUMNS,
  minHeight: '22px',
  lineHeight: '22px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
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
 */
const ctxRowStyle: CSSProperties = { ...gridRowStyle }
const delRowStyle: CSSProperties = {
  ...gridRowStyle,
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
}
const addRowStyle: CSSProperties = {
  ...gridRowStyle,
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
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
  background: 'var(--dsw-alias-fill-l2, #8881)',
  borderLeft: '0.5px solid var(--dsw-alias-border-l1, #8884)',
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

const btnStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l1, #8888)',
  borderRadius: '6px',
  background: 'transparent',
  padding: '1px 8px',
  fontSize: '11px',
  cursor: 'pointer',
  color: 'inherit',
}

const dangerStyle: CSSProperties = { ...btnStyle, borderColor: '#c0392b66', color: '#c0392b' }
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
  hunk, t, busy, onAccept, onRevert, regionRef, allHighlight, oldHighlight,
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
}) {
  const rows: ReturnType<typeof h>[] = []
  // 官方那种 hunk 头:让"这一块在文件的哪个位置"一眼可读,也是与官方观感
  // 最明显的一处对齐。
  rows.push(h('div', { key: 'head', style: hunkHeaderStyle }, hunkHeaderOf(hunk)))
  hunkRows(hunk).forEach((row, i) => {
    const isDel = row.kind === 'del'
    const isAdd = row.kind === 'add'
    const style = isDel ? delRowStyle : isAdd ? addRowStyle : ctxRowStyle
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
    h('button', { key: 'accept', type: 'button', disabled: busy, style: btnStyle, onClick: onAccept },
      t('striatum.hunkAccept')),
    h('button', { key: 'revert', type: 'button', disabled: busy, style: dangerStyle, onClick: onRevert },
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
        background: mark.tone === 'add' ? '#27ae60' : mark.tone === 'del' ? '#c0392b' : '#d68910',
      },
      onClick: () => { onJump(mark.index) },
    })))
}

/** 只读文件画布(无改动叠加时用),与有改动时同一套行渲染。 */
function PlainCanvas({
  lines, scrollportRef, allHighlight,
}: {
  lines: readonly string[]
  scrollportRef?: (el: HTMLElement | null) => void
  /** 当前文件全文的逐行高亮;undefined 时退化为纯文本。 */
  allHighlight: HighlightedLines | undefined
}) {
  // 与有改动时同一套四栏网格:旧行号栏留空、无标记 —— 这样从"纯查看"切到
  // "有改动"时列宽不跳。
  return h('div', { style: canvasStyle, ref: scrollportRef },
    lines.map((text, i) => h('div', { key: i, style: gridRowStyle }, [
      h('span', { key: 'on', style: gutterStyle }, ''),
      h('span', { key: 'nn', style: gutterStyle }, String(i + 1)),
      h('span', { key: 'sg', style: signStyle }, ' '),
      h(LineBody, { key: 't', text, style: ctxTextStyle, spans: allHighlight?.[i] }),
    ])))
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
  const items = useMemo(() => withFoldedPlain(segments, unfolded), [segments, unfolded])
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
      h(PlainCanvas, { key: 'plain', lines, scrollportRef: bindCanvas, allHighlight }),
      // 已跟踪但确实没有可对比内容时,给一句说明(不是错误)。
      view !== null && view.tracked && !view.hasBaseline && !view.created
        ? h('div', { key: 'note', style: noticeStyle }, t('striatum.noDiff'))
        : null,
      view !== null && view.diffLimited
        ? h('div', { key: 'big', style: noticeStyle }, t('striatum.diffLimited'))
        : null,
      error !== null ? h('div', { key: 'err', style: { ...noticeStyle, color: '#c0392b' } }, error) : null,
    ])
  }

  const totals = overlay.reduce(
    (acc, x) => ({ added: acc.added + x.added, removed: acc.removed + x.removed }),
    { added: 0, removed: 0 },
  )

  return h('div', { style: wrapStyle }, [
    h('div', { key: 'row', style: rowStyle }, [
      h('div', { key: 'canvas', style: canvasStyle, ref: bindCanvas },
        items.map((item, i) => item.kind === 'plain'
          ? h('div', { key: `p${i}` }, item.lines.map((line, j) => {
              const spans = allHighlight?.[item.from + j]
              return h('div', { key: j, style: gridRowStyle }, [
                h('span', { key: 'on', style: gutterStyle }, ''),
                h('span', { key: 'nn', style: gutterStyle }, String(item.from + j + 1)),
                h('span', { key: 'sg', style: signStyle }, ' '),
                h(LineBody, { key: 't', text: line, style: ctxTextStyle, spans }),
              ])
            }))
          : item.kind === 'fold'
            // 折叠标记占一行,行号栏空着 —— 它不是一个真实行。
            ? h('button', {
                key: `f${i}`,
                type: 'button',
                'data-striatum-fold': '',
                style: foldStyle,
                title: t('striatum.unfoldHint', { count: String(item.hidden) }),
                onClick: () => {
                  setUnfolded(prev => new Set([...prev, item.segmentFrom]))
                },
              }, t('striatum.folded', { count: String(item.hidden) }))
            : h(HunkRegion, {
                key: `h${item.hunk.index}`,
                hunk: item.hunk,
                t,
                busy,
                regionRef: registerRegion(item.hunk.index),
                allHighlight,
                oldHighlight: oldHighlights.get(item.hunk.index),
                onAccept: () => { void run(() => acceptHunk(parsed!.sessionId, parsed!.path, item.hunk.index)) },
                onRevert: () => { void run(() => revertHunk(parsed!.sessionId, parsed!.path, item.hunk.index)) },
              }))),
      h(Ruler, { key: 'ruler', marks, onJump: jumpTo, t }),
    ]),
    view?.diffLimited === true ? h('div', { key: 'big', style: noticeStyle }, t('striatum.diffLimited')) : null,
    error !== null ? h('div', { key: 'err', style: { ...noticeStyle, color: '#c0392b' } }, error) : null,
    // 文件级(最下方):作用于整个文件。
    h('div', { key: 'fileops', style: fileFooterStyle }, [
      h('span', { key: 'label', style: { opacity: 0.7 } }, t('striatum.fileLevel')),
      h('span', { key: 'stat', style: statStyle }, `+${totals.added} -${totals.removed}`),
      h('span', { key: 'sp', style: spacerStyle }),
      h('button', {
        key: 'keep',
        type: 'button',
        disabled: busy,
        style: btnStyle,
        onClick: () => { void run(() => keep(parsed!.sessionId, parsed!.path)) },
      }, t('striatum.keepAllFile')),
      h('button', {
        key: 'undo',
        type: 'button',
        disabled: busy || view?.canUndo !== true,
        style: dangerStyle,
        onClick: () => { void run(() => undo(parsed!.sessionId, parsed!.path)) },
      }, t('striatum.undoFile')),
    ]),
  ])
}

/**
 * dsh-striatum — 把「整文件」与「改动块」编排成顺序渲染的片段。
 *
 * 抽取为纯函数以便单测:局部片段与文件行是否对得齐,是"接受一块后画面错位"
 * 这类 bug 的高发处,值得脱离 React 验证。
 * @module dsh-striatum/client/segments
 */
import type { HunkView } from '../shared/wire.ts'

/** 画布上的一段:普通文件行,或一个待渲染的改动块。 */
export type Segment =
  | { kind: 'plain', lines: string[], from: number }
  | { kind: 'hunk', hunk: HunkView }

/**
 * 编排片段。
 *
 * 每个 hunk 覆盖当前文件的 [newStart, newStart+newLines-1] 区段;该区段的内
 * 容由 hunk 自己渲染(它会画出上下文/新增行以及不在新侧的删除行),故这里把
 * 这些文件行跳过,只补上它们之间的普通行。
 * @param lines - 当前文件全文按行拆分(无结尾空行)。
 * @param hunks - 改动块(顺序不限)。
 * @returns 片段序列;覆盖整文件且不重叠。
 */
export function segmentsOf(lines: readonly string[], hunks: readonly HunkView[]): Segment[] {
  const out: Segment[] = []
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart)
  let cursor = 0 // 0-based:已渲染到第几行
  for (const hunk of sorted) {
    const start = Math.max(0, hunk.newStart - 1)
    // 重叠或越界的块跳过(host 与 content 同源,正常不会发生)。
    if (start < cursor || start > lines.length) continue
    if (start > cursor) out.push({ kind: 'plain', lines: lines.slice(cursor, start), from: cursor })
    out.push({ kind: 'hunk', hunk })
    cursor = Math.min(lines.length, start + hunk.newLines)
  }
  if (cursor < lines.length) out.push({ kind: 'plain', lines: lines.slice(cursor), from: cursor })
  return out
}

/** 文件全文 → 内容行。空串为零行;单个结尾换行不算多一行。 */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** 改动块里的一行,连同它的两个行号来源(抽成纯数据以便单测对齐)。 */
export interface HunkRow {
  kind: 'context' | 'del' | 'add'
  /** 行内容(不含前导标记)。 */
  text: string
  /** 前导标记:`-` / `+` / 空格。 */
  marker: string
  /** 新侧行号(1-based);删除行不在新侧,为 null。 */
  newLineNo: number | null
  /** 旧侧片段下标(0-based,用于取旧侧高亮);非删除行为 null。 */
  oldIndex: number | null
}

/**
 * 把改动块摊平成逐行渲染计划,并标出每行的两个高亮来源下标。
 *
 * 这里是"改动底色/高亮画错行"的高发处,故独立成纯函数:
 *  - 新侧行号随 `context`/`add` 递增,`del` 不占新侧行号(留空);
 *  - 旧侧下标 = 该行在 {@link oldSideLines} 里的位置,**随 `context` 一起递增**
 *    —— 旧侧片段由 `context` + `del` 构成,`context` 也占旧侧的一个位置。
 *
 * 注意后者极易写错:若只在 `del` 时递增,`context` 排在 `del` 前面时(3 行
 * 上下文的常态),删除行会取到上下文行的高亮 —— 颜色看着"有个色",实则错位。
 * @param hunk - 改动块。
 * @param startLine - 该块在当前文件中的起始行号(1-based)。
 * @returns 逐行渲染计划,顺序与 `hunk.lines` 一致。
 */
export function hunkRows(hunk: HunkView, startLine: number): HunkRow[] {
  const rows: HunkRow[] = []
  let newLineNo = startLine
  let oldIndex = 0
  for (const line of hunk.lines) {
    const isDel = line.kind === 'del'
    rows.push({
      kind: line.kind,
      text: line.text,
      marker: isDel ? '-' : line.kind === 'add' ? '+' : ' ',
      newLineNo: isDel ? null : newLineNo,
      oldIndex: line.kind === 'add' ? null : oldIndex,
    })
    if (line.kind === 'add') newLineNo += 1
    else {
      oldIndex += 1
      if (!isDel) newLineNo += 1
    }
  }
  return rows
}

/**
 * 改动块的旧侧行(供**删除行**取高亮)。
 *
 * 删除行在当前文件里已不存在,拿不到整文件高亮的对应 token,故按旧侧片段
 * 单独着色。顺序与 {@link hunkRows} 的 `oldIndex` 严格一致(context + del)。
 * @param hunk - 改动块。
 * @returns 旧侧行文本;没有删除行时为空数组。
 */
export function oldSideLines(hunk: HunkView): string[] {
  return hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
}

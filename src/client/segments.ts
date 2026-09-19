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
  /**
   * 旧侧行号(1-based);新增行不在旧侧,为 null。
   *
   * 与 {@link newLineNo} 一起画成官方那样的双侧行号栏。旧侧自
   * `hunk.oldStart` 起算,`context` 与 `del` 各占一号,`add` 不占。
   */
  oldLineNo: number | null
  /** 旧侧片段下标(0-based,用于取旧侧高亮);非删除行为 null。 */
  oldIndex: number | null
}

/**
 * 把改动块摊平成逐行渲染计划,并标出每行的两个高亮来源下标。
 *
 * 这里是"改动底色/高亮画错行"的高发处,故独立成纯函数:
 *  - 新侧行号随 `context`/`add` 递增,`del` 不占新侧行号(留空);
 *  - 旧侧行号自 `hunk.oldStart` 起算,随 `context`/`del` 递增,`add` 不占;
 *  - 旧侧下标 = 该行在 {@link oldSideLines} 里的位置,**随 `context` 一起递增**
 *    —— 旧侧片段由 `context` + `del` 构成,`context` 也占旧侧的一个位置。
 *
 * 注意最后一条极易写错:若只在 `del` 时递增,`context` 排在 `del` 前面时(3 行
 * 上下文的常态),删除行会取到上下文行的高亮 —— 颜色看着"有个色",实则错位。
 *
 * 两侧行号都**只从 hunk 自己取**(`oldStart` / `newStart`),不再由调用方传起点:
 * 早先的 `startLine` 参数在每个调用点都等于 `hunk.newStart`,却给新侧留了第二个
 * 真相来源 —— 一旦传了别的值,新侧会与 `@@` 头对不上,而旧侧不会跟着错,正是上面
 * 警告的那类"看着有色、实则错位"。参数去掉后这种不一致无法表达。
 * @param hunk - 改动块(须带 `oldStart`/`newStart`,由 host 从 diff 库原样带出)。
 * @returns 逐行渲染计划,顺序与 `hunk.lines` 一致。
 */
export function hunkRows(hunk: HunkView): HunkRow[] {
  const rows: HunkRow[] = []
  let newLineNo = hunk.newStart
  let oldLineNo = hunk.oldStart
  let oldIndex = 0
  for (const line of hunk.lines) {
    const isDel = line.kind === 'del'
    const isAdd = line.kind === 'add'
    rows.push({
      kind: line.kind,
      text: line.text,
      marker: isDel ? '-' : isAdd ? '+' : ' ',
      newLineNo: isDel ? null : newLineNo,
      oldLineNo: isAdd ? null : oldLineNo,
      oldIndex: isAdd ? null : oldIndex,
    })
    if (isAdd) newLineNo += 1
    else {
      oldIndex += 1
      oldLineNo += 1
      if (!isDel) newLineNo += 1
    }
  }
  return rows
}

/**
 * 官方 ReviewTab 风格的 hunk 头:`@@ -旧起点,旧行数 +新起点,新行数 @@`。
 * @param hunk - 改动块。
 * @returns 该块的头行文本。
 */
export function hunkHeaderOf(hunk: HunkView): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
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

/** 普通行段超过这个长度就折叠中段。 */
export const PLAIN_FOLD_THRESHOLD = 80

/** 折叠时首尾各保留的行数。 */
export const PLAIN_FOLD_KEEP = 20

/** 画布上真正要渲染的一项:普通行、折叠标记,或一个改动块。 */
export type RenderItem =
  | { kind: 'plain', lines: string[], from: number }
  | { kind: 'fold', from: number, hidden: number, segmentFrom: number }
  | { kind: 'hunk', hunk: HunkView }

/**
 * 折叠过长的普通行段,给 DOM 行数封顶。
 *
 * 为什么不像官方 ReviewTab 那样"总量截断"(其 `renderedHunks` 砍到 5000 行):
 * 官方那张视图**只画 hunk**,砍掉的是 diff 本身;
 * 而本视图是「整文件画布 + 改动叠加」,把总量一刀切会连文件正文一起吞掉,用户就
 * 没法在自己代码的上下文里看改动了 —— 那正是这个视图存在的理由。
 *
 * 所以改为**只折叠改动之外的空白长段**:改动块相邻的上下文永远可见,被折叠的
 * 是离改动很远的大段未改动代码,且给出一键展开。万行文件的 DOM 行数因此从
 * 万级降到「改动数 × 块高 + 每个长段的首尾」。
 *
 * 折叠状态由调用方持有(`expanded` 是"已展开的段起点"集合),纯函数不记状态,
 * 便于单测。
 * @param segments - {@link segmentsOf} 的输出。
 * @param expanded - 已展开的普通段起点(`from`)集合。
 * @returns 渲染项;长段被拆成「首 KEEP 行 + 折叠标记 + 尾 KEEP 行」。
 */
export function withFoldedPlain(
  segments: readonly Segment[],
  expanded: ReadonlySet<number>,
): RenderItem[] {
  const out: RenderItem[] = []
  for (const seg of segments) {
    if (seg.kind === 'hunk') {
      out.push(seg)
      continue
    }
    // 短段、或用户已展开的段:原样渲染。
    if (seg.lines.length <= PLAIN_FOLD_THRESHOLD || expanded.has(seg.from)) {
      out.push(seg)
      continue
    }
    const keep = PLAIN_FOLD_KEEP
    const tailFrom = seg.from + seg.lines.length - keep
    out.push({ kind: 'plain', lines: seg.lines.slice(0, keep), from: seg.from })
    // `segmentFrom` 是**段起点**而非缺口起点:展开时要按它回写展开集合,
    // 由渲染层做减法会与 PLAIN_FOLD_KEEP 耦合,一旦改常量就对不上。
    out.push({ kind: 'fold', from: seg.from + keep, hidden: seg.lines.length - keep * 2, segmentFrom: seg.from })
    out.push({ kind: 'plain', lines: seg.lines.slice(seg.lines.length - keep), from: tailFrom })
  }
  return out
}

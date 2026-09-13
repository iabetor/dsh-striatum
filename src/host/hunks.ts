/**
 * dsh-striatum — hunk 计算:把 (baseline, current) 两侧全文切成可操作的改动块。
 *
 * 与 harness 对话流**同源**:同样用 `diff` 库的 structuredPatch、同样 context=3
 * (见 deepseek-harness 的 packages/fs/tool-fs/src/diff.ts)。这样文件预览里的
 * hunk 边界与对话流里的 diff 卡片一致,不会出现"同一处改动在两处被切成不同块"。
 *
 * 关键取舍:**不持久化 hunk**。行号会随文件演进漂移(实测:同一文件三次编辑,
 * harness 给的行号分别基于 v0/v1/v2),存下来必然失效。改为每次从当前的
 * (baseline, current) 现算 —— 视图请求时才计算,数量级是毫秒。
 * @module dsh-striatum/host/hunks
 */
import { applyPatch, formatPatch, reversePatch, structuredPatch } from 'diff'

/** 每块改动两侧保留的上下文行数;与 harness computeHunkDiffs 保持一致。 */
export const HUNK_CONTEXT = 3

/** 一个可操作的改动块(带在当前文件中的确切位置)。 */
export interface Hunk {
  /** 稳定索引(在本次计算里),客户端用它指代"这一块"。 */
  index: number
  /**
   * 该块在当前文件(new 侧)中的起始行号(1-based)。
   *
   * 客户端据此把改动行**叠加到整文件渲染**上:接受一块后,该段高亮消失但
   * 文件内容仍在原处可见,不会出现"点一下内容就没了"的空洞。
   */
  newStart: number
  /**
   * 该块在当前文件中覆盖的行数(new 侧,含上下文)。
   * 纯删除块的 new 侧只剩上下文,故可能小于 oldLines。
   */
  newLines: number
  /** 该块的逐行内容(` ` 上下文 / `-` 删除 / `+` 新增),供整文件叠加渲染。 */
  lines: HunkLine[]
  /** 该块新增的行数(仅计 + 行)。 */
  added: number
  /** 该块删除的行数(仅计 - 行)。 */
  removed: number
}

/** 改动块里的一行。 */
export interface HunkLine {
  /** `context` 未改动 / `del` 删除 / `add` 新增。 */
  kind: 'context' | 'del' | 'add'
  /** 行内容(不含前导标记)。 */
  text: string
}

/** diff 库的一侧文本 → 内容行。空串为零行(不产生多余的空行)。 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * 计算两侧全文之间的改动块。
 *
 * 每块保留**逐行内容**与在 new 侧的位置,客户端据此在整文件画布上叠加高亮,
 * 而不是把块单独列出来 —— 后者在块被接受后会留下空白。
 * @param baseline - 参考态(用户已确认的基线)。
 * @param current - 盘上当前内容。
 * @returns 改动块列表;两侧相同时为空数组。
 */
export function hunksOf(baseline: string, current: string): Hunk[] {
  if (baseline === current) return []
  const patch = structuredPatch('', '', baseline, current, undefined, undefined, { context: HUNK_CONTEXT })
  return patch.hunks.map((hunk, index) => {
    const lines: HunkLine[] = []
    let added = 0
    let removed = 0
    for (const raw of hunk.lines) {
      // '\' 行是「文件末尾无换行」的注释,不是内容(与 harness 的处理一致)。
      if (raw.startsWith('\\')) continue
      const text = raw.slice(1)
      if (raw.startsWith('-')) {
        lines.push({ kind: 'del', text })
        removed += 1
      } else if (raw.startsWith('+')) {
        lines.push({ kind: 'add', text })
        added += 1
      } else {
        lines.push({ kind: 'context', text })
      }
    }
    return { index, newStart: hunk.newStart, newLines: hunk.newLines, lines, added, removed }
  })
}

/**
 * 把「接受某一块」应用到基线:基线前移一段。
 *
 * 做法:用该块的正向 patch 去改基线。这样后续的 hunk 会因为基线变了而自动重算,
 * 无需维护任何行号映射。
 * @param baseline - 当前基线全文。
 * @param current - 盘上当前内容(用于重算该块的 patch)。
 * @param index - 要接受的块索引(以 `hunksOf(baseline, current)` 为准)。
 * @returns 新基线全文;索引无效或 patch 无法应用时返回 null。
 */
export function acceptHunk(baseline: string, current: string, index: number): string | null {
  const hunk = hunksOf(baseline, current)[index]
  if (hunk === undefined) return null
  const patch = structuredPatch('', '', baseline, current, undefined, undefined, { context: HUNK_CONTEXT })
  const single = patch.hunks[index]
  if (single === undefined) return null
  // applyPatch 失败时返回 false(不抛错)—— 必须判返回值,不能当作内容。
  const next = applyPatch(baseline, formatPatch({ ...patch, hunks: [single] }))
  return typeof next === 'string' ? next : null
}

/**
 * 把「撤销某一块」应用到当前内容:写回该块的改动前片段。
 * @param baseline - 当前基线全文。
 * @param current - 盘上当前内容。
 * @param index - 要撤销的块索引(以 `hunksOf(baseline, current)` 为准)。
 * @returns 应写回磁盘的新内容;索引无效或 patch 无法应用时返回 null。
 */
export function revertHunk(baseline: string, current: string, index: number): string | null {
  const patch = structuredPatch('', '', baseline, current, undefined, undefined, { context: HUNK_CONTEXT })
  const single = patch.hunks[index]
  if (single === undefined) return null
  const reversed = reversePatch({ ...patch, hunks: [single] })
  const next = applyPatch(current, formatPatch(reversed))
  return typeof next === 'string' ? next : null
}

/** 块列表的增删合计(UI 展示用)。 */
export function hunkTotals(hunks: readonly Hunk[]): { added: number, removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    added += h.added
    removed += h.removed
  }
  return { added, removed }
}

// contentLines 供将来需要逐行渲染时使用;当前渲染在客户端做,此处保留导出以便测试。
export { contentLines }

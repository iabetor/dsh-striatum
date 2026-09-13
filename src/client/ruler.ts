/**
 * dsh-striatum — 改动概览标尺的位置计算。
 *
 * 长文件里改动可能寥寥几处,需要翻遍全文才找得到。标尺在滚动条旁按比例标出
 * 每处改动的高度位置,点击即定位过去 —— 与 VS Code / CodeBuddy 的 overview
 * ruler 同思路。
 *
 * 这里是纯计算(不碰 React):只把「行号空间」映射到「百分比空间」。
 * @module dsh-striatum/client/ruler
 */
import type { HunkView } from '../shared/wire.ts'

/** 标尺上的一个改动标记。 */
export interface RulerMark {
  /** 对应 hunk 的索引(点击时用它回查元素)。 */
  index: number
  /** 距标尺顶部的百分比(0-100)。 */
  topPercent: number
  /** 标记高度占标尺的百分比(至少 {@link MIN_MARK_PERCENT},否则细到看不见)。 */
  heightPercent: number
  /** 该改动在当前文件中的起始行(1-based)。 */
  line: number
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  removed: number
  /** 观感分类:纯新增 / 纯删除 / 混合(据此选颜色)。 */
  tone: 'add' | 'del' | 'mix'
}

/** 标记的最小高度(百分比):一个只有 1 行的改动在千行文件里也要看得见。 */
export const MIN_MARK_PERCENT = 1.2

/**
 * 把改动块映射成标尺标记。
 *
 * 位置用 **行号 / 总行数** 估算,而不是真实像素:行高会因换行而不等,但用户
 * 只需"大致位置 + 点击跳过去",比例映射已足够,且免去测量 DOM。
 * @param totalLines - 当前文件的总行数(必须 > 0)。
 * @param hunks - 改动块(顺序不限)。
 * @returns 标记列表,按位置升序;总行数非正时为空。
 */
export function rulerMarks(totalLines: number, hunks: readonly HunkView[]): RulerMark[] {
  if (!Number.isFinite(totalLines) || totalLines <= 0) return []
  return [...hunks]
    .sort((a, b) => a.newStart - b.newStart)
    .map(hunk => {
      const line = Math.max(1, Math.min(totalLines, hunk.newStart))
      const topPercent = ((line - 1) / totalLines) * 100
      const raw = (Math.max(1, hunk.newLines) / totalLines) * 100
      return {
        index: hunk.index,
        topPercent,
        heightPercent: Math.max(MIN_MARK_PERCENT, Math.min(100 - topPercent, raw)),
        line,
        added: hunk.added,
        removed: hunk.removed,
        tone: hunk.added > 0 && hunk.removed === 0
          ? 'add'
          : hunk.removed > 0 && hunk.added === 0
            ? 'del'
            : 'mix',
      }
    })
}

/**
 * 求「把某个改动居中显示」时滚动容器的目标 scrollTop。
 *
 * 抽成纯函数便于单测边界(顶部/底部不外溢)。
 * @param elementTop - 改动块相对滚动内容顶部的偏移(px)。
 * @param elementHeight - 改动块高度(px)。
 * @param viewportHeight - 滚动容器可视高度(px)。
 * @param scrollHeight - 滚动内容总高(px)。
 * @returns 目标 scrollTop(已夹在 [0, scrollHeight - viewportHeight])。
 */
export function centerScrollTop(
  elementTop: number,
  elementHeight: number,
  viewportHeight: number,
  scrollHeight: number,
): number {
  const target = elementTop - (viewportHeight - elementHeight) / 2
  const max = Math.max(0, scrollHeight - viewportHeight)
  return Math.max(0, Math.min(max, target))
}

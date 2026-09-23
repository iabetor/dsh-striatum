/**
 * dsh-striatum — 行数统计的展示(`+12 -3`)。
 *
 * 与官方 ChangedFiles 同观感:新增绿、删除红,紧凑等宽。**只负责画**,数字由 host
 * 算好(客户端没有基线,算不出来)。
 *
 * 缺失数字时**什么都不画** —— 宁可没有统计,也不把"不知道"画成 `+0 -0`。
 *
 * @module dsh-striatum/client/StatBadge
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { h, type CSSProperties } from './react.ts'

/**
 * 新增行的绿 / 删除行的红。
 *
 * 用官方同一批 token(官方 `.added` / `.deleted` 就是这么写的),而不是写死
 * `#27ae60`:写死的色在浅色主题下会脏,且与改动行的 `color-mix` 底色不一致。
 */
const ADDED_COLOR = 'var(--dsw-alias-state-success-primary, #27ae60)'
const REMOVED_COLOR = 'var(--dsw-alias-state-error-primary, #c0392b)'

/** 统计条:两个数字紧挨着,数字本身等宽以免抖动。 */
const statStyle: CSSProperties = {
  display: 'inline-flex',
  gap: '6px',
  fontFamily: 'monospace',
  fontSize: '12px',
  flex: 'none',
  // 数字宽度固定,列表滚动时不会因为位数变化而左右跳。
  fontVariantNumeric: 'tabular-nums',
}

/**
 * 行数统计徽标。
 * @param props - 统计值与文案函数。
 * @returns `+n -m` 片段;两个数字都缺失时返回 null。
 */
export function StatBadge({ added, removed, t, title }: {
  added: number | undefined
  removed: number | undefined
  t: TranslateNS<'striatum'>
  /** 悬停说明;省略则不挂 title。 */
  title?: string | undefined
}): ReturnType<typeof h> | null {
  if (added === undefined && removed === undefined) return null
  return h('span', { style: statStyle, title },
    h('span', { style: { color: ADDED_COLOR } },
      t('striatum.stat.added', { count: String(added ?? 0) })),
    h('span', { style: { color: REMOVED_COLOR } },
      t('striatum.stat.removed', { count: String(removed ?? 0) })),
  )
}

/**
 * 把一组文件的行数统计求和。
 *
 * 只累加**有统计**的文件:读不到或超限的文件没有数字,按 0 计会把合计算小,
 * 所以同时回报"有几个文件没算进去",由调用方决定是否提示。
 * @param files - 待求和的文件视图。
 * @returns 合计与未参与统计的文件数。
 */
export function totalStats(files: readonly { added?: number | undefined; removed?: number | undefined }[]): {
  added: number
  removed: number
  /** 没有统计数字、未计入合计的文件数。 */
  uncounted: number
} {
  let added = 0
  let removed = 0
  let uncounted = 0
  for (const f of files) {
    if (f.added === undefined && f.removed === undefined) {
      uncounted += 1
      continue
    }
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  return { added, removed, uncounted }
}

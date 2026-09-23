/**
 * dsh-striatum — client locales(zh/en)。
 * 官方模式:值全为 string,带参文案用 {param} 占位符(框架替换)。
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

// 命名空间声明与其键集同住:任何写 TranslateNS<'striatum'> 的模块只需本文件,
// 与官方 ui-sidebar-files 同构。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** striatum 的确认条、总览条与文件预览内的改动视图文案。 */
    striatum: StriatumKey
  }
}

/** 简化中文字典(键集源)。 */
export const zh = {
  'striatum.label': '未确认改动',
  'striatum.files': '{count} 个文件',
  'striatum.keep': 'Keep',
  'striatum.keepAll': '全部 Keep',
  'striatum.undo': '撤销',
  'striatum.undoFile': '撤销此文件',
  'striatum.undoAll': '全部撤销',
  'striatum.expand': '展开',
  'striatum.collapse': '收起',
  'striatum.noBaseline': '无法撤销(从未 Keep 过)',
  'striatum.conflict': '文件已被外部修改',
  'striatum.unreadable': '文件当前不可读(可能被删除/移走),无法撤销',
  'striatum.turnTail.title': '本轮改动 · {count} 个文件',
  'striatum.earlierTurns': '含更早 {count} 轮未确认改动,将一并撤销',
  'striatum.undoRefused': '撤销被拒绝',
  'striatum.changes': '改动',
  'striatum.viewDiff': '查看 diff',
  'striatum.turnBadge': '第 {turns} 轮 · {count} 次',
  // 单一轮次时只报次数:逐行重复「第 N 轮」是噪声(见 OverviewStrip 的 spansMultipleTurns)。
  'striatum.changeCount': '{count} 次',
  // 文件预览内的「改动」渲染器
  'striatum.badge.label': '改动',
  'striatum.unresolvedAddress': '无法解析该文件的会话地址。',
  'striatum.loading': '正在读取改动…',
  'striatum.noDiff': '暂无对比基线(该文件从未 Keep 过);Keep 后即可查看 diff。',
  'striatum.noChanges': '该文件当前没有未确认改动。',
  'striatum.hunkAccept': '接受此块',
  'striatum.hunkRevert': '撤销此块',
  'striatum.hunkScope': '此改动',
  'striatum.rulerMark': '第 {line} 行 · +{added} -{removed}',
  'striatum.rulerJump': '跳到第 {line} 行的改动',
  'striatum.diffLimited': '文件过大,已跳过改动对比(仍可查看全文)。',
  'striatum.folded': '⋯ 已折叠 {count} 行未改动内容,点击展开',
  'striatum.unfoldHint': '展开这 {count} 行未改动内容',
  'striatum.fileLevel': '整个文件',
  'striatum.keepAllFile': 'Keep 整个文件',
  // 行数统计(与官方 ChangedFiles 同口径)
  'striatum.stat.added': '+{count}',
  'striatum.stat.removed': '-{count}',
  'striatum.stat.title': '相对基线:新增 {added} 行,删除 {removed} 行',
  'striatum.stat.partial': '合计不含 {count} 个无法统计的文件(已删除或过大)',
  // 头部工具(对齐官方 ReviewTab 的 wrap 开关)
  'striatum.wrap.on': '长行换行(点击改为不换行)',
  'striatum.wrap.off': '长行不换行(点击改为换行)',
  'striatum.wrapShort': '换行',
}

/** 英文字典(同键集)。 */
export const en: Record<StriatumKey, string> = {
  'striatum.label': 'Pending changes',
  'striatum.files': '{count} file(s)',
  'striatum.keep': 'Keep',
  'striatum.keepAll': 'Keep all',
  'striatum.undo': 'Undo',
  'striatum.undoFile': 'Undo file',
  'striatum.undoAll': 'Undo all',
  'striatum.expand': 'Expand',
  'striatum.collapse': 'Collapse',
  'striatum.noBaseline': 'Cannot undo (never kept)',
  'striatum.conflict': 'File modified externally',
  'striatum.unreadable': 'File is not readable now (deleted or moved); cannot undo',
  'striatum.turnTail.title': 'This turn changed {count} file(s)',
  'striatum.earlierTurns': 'Includes {count} earlier unconfirmed turn(s); will undo together',
  'striatum.undoRefused': 'Undo refused',
  'striatum.changes': 'Changes',
  'striatum.viewDiff': 'View diff',
  'striatum.turnBadge': 'Turn {turns} · {count} change(s)',
  // One turn only: report the count alone (repeating "Turn N" per row is noise).
  'striatum.changeCount': '{count} change(s)',
  // In-preview "changes" renderer
  'striatum.badge.label': 'Changes',
  'striatum.unresolvedAddress': 'Could not resolve this file\'s session address.',
  'striatum.loading': 'Reading changes…',
  'striatum.noDiff': 'No baseline to compare (never kept); keep the file to see a diff.',
  'striatum.noChanges': 'This file has no unconfirmed changes.',
  'striatum.hunkAccept': 'Accept',
  'striatum.hunkRevert': 'Undo',
  'striatum.hunkScope': 'This change',
  'striatum.rulerMark': 'Line {line} · +{added} -{removed}',
  'striatum.rulerJump': 'Jump to the change at line {line}',
  'striatum.diffLimited': 'File too large; change comparison skipped (full text still shown).',
  'striatum.folded': '⋯ {count} unchanged lines folded; click to expand',
  'striatum.unfoldHint': 'Expand these {count} unchanged lines',
  'striatum.fileLevel': 'Whole file',
  'striatum.keepAllFile': 'Keep whole file',
  // Line statistics (same counting as the official ChangedFiles)
  'striatum.stat.added': '+{count}',
  'striatum.stat.removed': '-{count}',
  'striatum.stat.title': 'Versus baseline: {added} line(s) added, {removed} removed',
  'striatum.stat.partial': 'Total excludes {count} file(s) that cannot be counted (deleted or too large)',
  // Header tools (mirroring the official ReviewTab wrap toggle)
  'striatum.wrap.on': 'Long lines wrap (click to disable)',
  'striatum.wrap.off': 'Long lines do not wrap (click to enable)',
  'striatum.wrapShort': 'Wrap',
}

/** 本命名空间的键联合。 */
export type StriatumKey = keyof typeof zh

/** Namespace id。 */
export const NS = 'striatum'

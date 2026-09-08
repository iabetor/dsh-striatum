/**
 * dsh-striatum — client locales(zh/en)。
 * 官方模式:值全为 string,带参文案用 {param} 占位符(框架替换)。
 */

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
}

/** 本命名空间的键联合。 */
export type StriatumKey = keyof typeof zh

/** Namespace id。 */
export const NS = 'striatum'

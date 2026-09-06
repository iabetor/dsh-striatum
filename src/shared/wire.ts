/**
 * dsh-striatum — shared wire types (host ↔ client, JSON-serializable).
 * @module @dsh-striatum/shared/wire
 */

/** 一个文件的待确认状态(文件级,无逐条/逐轮链)。 */
export interface FileStateView {
  /** 会话工作区内的规范化路径。 */
  path: string
  /** 是否已有基线(可 undo)。false = 从未 keep 过,undo 禁用。 */
  hasBaseline: boolean
  /** 第一个未确认改动所在轮(UI 展示)。 */
  firstPendingTurn: number
  /** 最近一个未确认改动所在轮(UI 展示)。 */
  lastPendingTurn: number
  /** 累计改动次数。 */
  changeCount: number
  /** 涉及轮次列表(升序,UI 展示如 "第1轮, 第2轮")。 */
  turns: number[]
  /** 外部修改检测:当前文件 hash 与登记时是否一致。false = 可能被外部改过。 */
  hashMatches: boolean
}

/** 展示记录(仅 UI,不参与 undo)。 */
export interface DisplayRecordView {
  turn: number
  step: number
  path: string
  createdAt: number
}

/** /striatum/api/state 的响应。 */
export interface StriatumState {
  sessionId: string
  files: FileStateView[]
  records: DisplayRecordView[]
}

/** keep/undo 的结果。 */
export interface MutateResult {
  ok: true
  /** 受影响路径列表。 */
  paths: string[]
}

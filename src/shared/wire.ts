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

/**
 * 一个可操作的改动块(文件预览内的 diff 视图;两侧均为带上下文的片段)。
 *
 * 不持久化:行号随文件演进漂移,每次由 host 从 (baseline, current) 现算。
 */
export interface HunkView {
  /** 在本次计算里的稳定索引;客户端用它指代"这一块"。 */
  index: number
  /** 该块在**当前文件**中的起始行号(1-based),供整文件叠加渲染定位。 */
  newStart: number
  /** 该块在当前文件中覆盖的行数(含上下文)。 */
  newLines: number
  /** 逐行内容(`context`/`del`/`add`),客户端据此在整文件画布上叠加高亮。 */
  lines: HunkLineView[]
  /** 新增行数(仅 + 行)。 */
  added: number
  /** 删除行数(仅 - 行)。 */
  removed: number
}

/** 改动块里的一行。 */
export interface HunkLineView {
  /** 未改动 / 删除 / 新增。 */
  kind: 'context' | 'del' | 'add'
  /** 行内容(不含前导标记)。 */
  text: string
}

/**
 * 单文件的改动叠加信息(文件预览渲染器用;GET /striatum/api/changes)。
 *
 * **不含文件正文**:正文由预览壳自己加载并通过座位 props 传给渲染器(与官方
 * CodeBody 同源)。这样渲染器在"striatum 不认识的普通文件"上也能正常显示全文
 * —— 它首先是个文件查看器,改动高亮只是叠加层。
 */
export interface FileChangesView {
  path: string
  /**
   * striatum 是否在跟踪这个文件。
   *
   * false = 从未登记过任何写改。此时只显示全文,不做任何改动提示。
   */
  tracked: boolean
  /** 是否有真实基线(Keep 过)。false 且 created=false 时无可对比基线。 */
  hasBaseline: boolean
  /** 基线来自「新建 = 空文件」推断(整篇显示为新增)。 */
  created: boolean
  /** 当前可操作的改动块;无基线或不可读时为空数组。 */
  hunks: HunkView[]
  /** 文件级 undo 是否可用(有基线且有 pending)。 */
  canUndo: boolean
  /** 文件过大,跳过了 diff 计算(hunks 必为空)。UI 应如实说明而非谎称"无改动"。 */
  diffLimited: boolean
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

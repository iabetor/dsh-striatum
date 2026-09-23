/**
 * dsh-striatum — shared wire types (host ↔ client, JSON-serializable).
 * @module @dsh-striatum/shared/wire
 */

/** 一个文件的待确认状态(文件级,无逐条/逐轮链)。 */
export interface FileStateView {
  /** 会话工作区内的规范化路径。 */
  path: string
  /**
   * 给人看的短路径(相对会话工作区根;工作区外为 `~/…` 或绝对路径)。
   *
   * 由 host 计算而不是客户端:只有 host 知道 cwd。**显示与操作必须分开** ——
   * 列表显示这个,而 keep/undo/diff 一律用 {@link path},后者才是查表用的键。
   */
  display: string
  /**
   * 撤销是否真的可用(host 判定)。
   *
   * 客户端**不要**自己推导:曾经这里还有个 `hashMatches`,客户端用
   * `hasBaseline && hashMatches` 拼出"可撤销",而文件被删除时当前 hash 读不到、
   * `hashMatches` 反而为真 —— 按钮可点、点击却抛 `file-unreadable`。判定条件
   * 只此一份,且由唯一知情的一方(host)给出。
   */
  canUndo: boolean
  /**
   * 不可撤销的原因(仅当 {@link canUndo} 为假时有意义)。
   *
   * 与 host 的 UndoErrorCode 同集合 —— 客户端据此选文案,不自行推断,
   * 否则「文件已删除」这类情形会只显示一个不可点的按钮而没有任何解释。
   */
  undoBlockedBy?: 'no-baseline' | 'file-unreadable' | 'hash-mismatch'
  /** 第一个未确认改动所在轮(UI 展示)。 */
  firstPendingTurn: number
  /** 最近一个未确认改动所在轮(UI 展示)。 */
  lastPendingTurn: number
  /** 累计改动次数。 */
  changeCount: number
  /** 涉及轮次列表(升序,UI 展示如 "第1轮, 第2轮")。 */
  turns: number[]
  /**
   * 相对基线的行数统计(与官方 ChangedFiles 的 `+n -m` 同口径:只数增删行,
   * 不含上下文)。
   *
   * 由 host 算而不是客户端:基线只有 host 有,客户端拿不到可比对的两侧全文。
   * 读不到文件或超限时为 undefined —— 此时**不显示**统计,而不是显示 `+0 -0`
   * (那会把"不知道"谎报成"没有改动")。
   */
  added?: number
  /** 见 {@link added}。 */
  removed?: number
}

/**
 * 一个可操作的改动块(文件预览内的 diff 视图;两侧均为带上下文的片段)。
 *
 * 不持久化:行号随文件演进漂移,每次由 host 从 (baseline, current) 现算。
 */
export interface HunkView {
  /** 在本次计算里的稳定索引;客户端用它指代"这一块"。 */
  index: number
  /**
   * 该块在**基线(旧)侧**的起始行号(1-based)。
   *
   * 与 {@link newStart} 一起画成官方那种双侧行号栏,并拼出
   * `@@ -oldStart,oldLines +newStart,newLines @@` 头。纯插入(基线里没有对应
   * 行)时 `oldLines` 为 0,而 `oldStart` 仍是 **1** —— 这是 `diff` 库的实际
   * 行为(实测:`''`→`'x\ny\n'` 得 `-1,0`),不是 git 那种新建文件的 `-0,0`。
   */
  oldStart: number
  /** 该块在基线侧覆盖的行数(含上下文);纯插入为 0。 */
  oldLines: number
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
  /** 给人看的短路径(与 {@link FileStateView.display} 同一规则),头部展示用。 */
  display: string
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

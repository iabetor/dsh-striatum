/**
 * dsh-striatum — ChangeRegistry: 会话内文件级「改动闸门」状态机(纯逻辑,无 cordis 依赖)。
 *
 * 语义(设计文档 v2 §4.2,文件级整体 keep/undo):
 * - 每个文件一条 FileState;agent 每次 write/edit 登记一条 DisplayRecord 并更新状态;
 * - Keep(path):读文件当前内容 → 存为新基线(纯元数据,不写文件)。文件条目保留(基线供
 *   未来 undo),但 pending 清空 → 不再出现在「待确认」视图;
 * - Undo(path):整文件原子写回基线 —— 实际写文件由 host 层经 ctx.fs 执行;本 registry
 *   负责校验 hash、给出应写入的基线内容、写回后更新状态。文件 IO 经 FileIo 解耦。
 * @module dsh-striatum/host/registry
 */

import type { DisplayRecordView, FileChangesView, FileStateView } from '../shared/wire.ts'
import {
  acceptHunk as acceptHunkIn,
  hunkTotals,
  hunksOf,
  revertHunk as revertHunkIn,
  type Hunk,
} from './hunks.ts'

/** 一次登记的输入(来自 tool/result 的 meta.diffs + 事件归属)。 */
export interface ChangeInput {
  turn: number
  step: number
  /** 事件里 diff.path。 */
  path: string
  oldText: string | null
  newText: string
  /**
   * 本次登记是否为「新建文件」(write 创建,改动前不存在)。
   *
   * 显式标注而不是靠 `oldText === null` 推断:harness 对「纯插入式 edit」同样
   * 给 `oldText: null`(见 computeHunkDiffs 注释),两者语义完全不同 —— 前者
   * 的改动前是空文件(可整篇显示为新增),后者只是 hunk 没带删除侧。
   */
  created?: boolean
  /**
   * 本次改动**之前**的完整文件内容(tools/execute 包装器从工具返回值取得)。
   *
   * 只在文件尚无基线时用作基线 —— 这样"改动过就能看到 diff",不必先 Keep。
   * 已有基线时忽略(基线由 Keep / 块级接受推进,不能被历史快照回退)。
   * 新建文件为 null(改动前不存在)。
   */
  beforeText?: string | null
  createdAt?: number
  /** 事件 seq(对账/去重游标)。 */
  seq?: number
}

/** 单文件内部状态(JSON-serializable)。 */
export interface PersistedFileState {
  path: string
  /** 上次 Keep 时的整文件内容;null = 从未 keep(不可 undo)。 */
  baseline: string | null
  baselineHash: string | null
  /** 最近一次登记/keep 时读到的文件哈希。 */
  lastKnownHash: string | null
  firstPendingTurn: number
  lastPendingTurn: number
  /** 涉及轮次(升序去重)。 */
  turns: number[]
  /** 累计改动次数(登记次数;UI 展示「改了几次」)。 */
  changeCount: number
  /**
   * 本条目自登记以来是否经历过「新建」。为真时 diff 的基线视为空文件 ——
   * 这样从未 keep 过的新建文件也能显示「整篇新增」,与 CodeBuddy 等
   * 审查工具的呈现一致。keep 之后由真实基线接管(见 keep())。
   */
  created: boolean
}

/** 展示记录(仅 UI):记录每次登记的轮/步/路径。 */
export interface PersistedDisplayRecord {
  turn: number
  step: number
  path: string
  createdAt: number
}

/** 文件事实(host reader 提供)。 */
export interface FileFacts {
  currentContent: string | null
  currentHash: string | null
}

/** registry 依赖的文件 IO(host 实现,测试 mock)。 */
export interface FileIo {
  readFacts(path: string): Promise<FileFacts>
  normalizePath(path: string): string
  /**
   * 把绝对路径渲染成给人看的短路径(规则见 host/paths.ts 的 displayPathOf)。
   *
   * 放在 FileIo 而不是客户端:只有 host 知道会话工作区根(cwd),客户端拿到的是
   * 绝对路径,自己猜不出该从哪里截断。此前客户端用 `basename()` 只留文件名,
   * 于是同一目录下的多个 `index.ts` 在列表里完全无法区分。
   * @param path - 绝对路径。
   * @returns 相对工作区根的短路径。
   */
  displayPath(path: string): string
}

/**
 * 一个文件 diff 两侧文本的上限(字符)。超过则不下发,客户端显示降级提示 ——
 * 超大文件的全文对比既无阅读价值,也会撑爆一次 state 响应。
 */
export const DIFF_TEXT_MAX = 256 * 1024

/**
 * 解析某文件的对比基线。
 *
 * 优先级:
 *  1. 已有真实基线(keep 过,hunk-keep 也会前移它)→ 用它;
 *  2. 从未 keep 但该条目是「新建」→ 基线视为**空文件**,整篇显示为新增;
 *  3. 其余(已有文件、从未 keep)→ null,调用方显示「暂无基线」提示。
 * @param file - 该文件的持久化状态。
 * @returns 基线全文,或 null(无可对比基线)。
 */
function baselineOf(file: PersistedFileState): string | null {
  return file.baseline ?? (file.created ? '' : null)
}

/**
 * 组装某文件的改动视图(hunks + 各项能力位)。
 *
 * 当前内容不可读、无基线、或任一侧超过 {@link DIFF_TEXT_MAX} 时,hunks 为空数组
 * 但仍回报 readable/hasBaseline,让 UI 能给出准确的降级提示。
 * @param file - 该文件的持久化状态。
 * @param facts - 刚读到的文件事实。
 * @param display - 短路径(由调用方从 FileIo 取得;自由函数拿不到 io)。
 * @returns 单文件改动视图。
 */
function changesOf(file: PersistedFileState, facts: FileFacts, display: string): FileChangesView {
  const current = facts.currentContent
  const baseline = baselineOf(file)
  const tooBig = baseline !== null && current !== null
    && (baseline.length > DIFF_TEXT_MAX || current.length > DIFF_TEXT_MAX)
  const usable = current !== null && baseline !== null && !tooBig
  return {
    path: file.path,
    display,
    tracked: true,
    // 这里保持「真实基线」语义(与 created 配对:created=false 且此位为假 =
    // 真的没有可对比内容)。撤销能力由 canUndo 单独表达,它才用统一的 baselineOf。
    hasBaseline: file.baseline !== null,
    created: file.baseline === null && file.created,
    hunks: usable ? hunksOf(baseline, current) : [],
    canUndo: baselineOf(file) !== null && hasPending(file),
    diffLimited: tooBig,
  }
}

/** striatum 未跟踪的文件:只有"无改动"这一事实,不编造其它。 */
export function untrackedChangesView(path: string, display: string): FileChangesView {
  return {
    path,
    display,
    tracked: false,
    hasBaseline: false,
    created: false,
    hunks: [],
    canUndo: false,
    diffLimited: false,
  }
}

/** 一个会话的完整持久化状态。 */
export interface PersistedSessionState {
  version: 1
  sessionId: string
  files: Record<string, PersistedFileState>
  records: PersistedDisplayRecord[]
  /**
   * 已登记到的会话日志最大事件 seq(firehose/对账的游标)。
   * 重启对账时只补登 seq > lastSeq 的事件(幂等);旧存档无此字段 = 0。
   */
  lastSeq: number
}

export type UndoErrorCode = 'no-pending' | 'no-baseline' | 'hash-mismatch' | 'file-unreadable'

export class UndoError extends Error {
  constructor(
    readonly code: UndoErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'UndoError'
  }
}

/** FNV-1a 双字哈希 → 16 位十六进制串;一致性比对用,非密码学。 */
export function hashOf(content: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + h1) >>> 0
  }
  return `${h2.toString(16).padStart(8, '0')}${h1.toString(16).padStart(8, '0')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 JSON 反序列化并校验;损坏返回 undefined。 */
export function parsePersistedState(raw: unknown): PersistedSessionState | undefined {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.sessionId !== 'string') return undefined
  if (!isRecord(raw.files) || !Array.isArray(raw.records)) return undefined
  const files: Record<string, PersistedFileState> = {}
  for (const [key, value] of Object.entries(raw.files)) {
    if (!isRecord(value) || typeof value.path !== 'string') return undefined
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
    const turns = Array.isArray(value.turns) ? (value.turns as unknown[]).filter((x): x is number => typeof x === 'number') : []
    files[key] = {
      path: value.path,
      baseline: str(value.baseline),
      baselineHash: str(value.baselineHash),
      lastKnownHash: str(value.lastKnownHash),
      firstPendingTurn: num(value.firstPendingTurn, 0),
      lastPendingTurn: num(value.lastPendingTurn, 0),
      turns,
      changeCount: num(value.changeCount, 0),
      // 旧存档无此字段 = false(只影响未 keep 的新建文件的 diff 呈现,不影响 keep/undo)。
      created: value.created === true,
    }
  }
  const records: PersistedDisplayRecord[] = []
  for (const r of raw.records) {
    if (!isRecord(r) || typeof r.turn !== 'number' || typeof r.step !== 'number' || typeof r.path !== 'string') continue
    records.push({
      turn: r.turn,
      step: r.step,
      path: r.path,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    })
  }
  return {
    version: 1,
    sessionId: raw.sessionId,
    files,
    records,
    lastSeq: typeof raw.lastSeq === 'number' && Number.isFinite(raw.lastSeq) ? raw.lastSeq : 0,
  }
}

export function emptySessionState(sessionId: string): PersistedSessionState {
  return { version: 1, sessionId, files: {}, records: [], lastSeq: 0 }
}

/** 同文件登记的 turn 合并。 */
function mergeTurn(file: PersistedFileState, turn: number): void {
  file.lastPendingTurn = Math.max(file.lastPendingTurn, turn)
  file.firstPendingTurn = file.firstPendingTurn === 0
    ? turn
    : Math.min(file.firstPendingTurn, turn)
  if (!file.turns.includes(turn)) file.turns = [...file.turns, turn].sort((a, b) => a - b)
}

/** 某文件是否处于「有待确认改动」状态。 */
function hasPending(file: PersistedFileState): boolean {
  return file.changeCount > 0
}

/** 清空某文件的 pending 计数(keep 后)。保留条目与基线。 */
function clearPending(file: PersistedFileState): void {
  file.firstPendingTurn = 0
  file.lastPendingTurn = 0
  file.turns = []
  file.changeCount = 0
}

/**
 * ChangeRegistry:一个会话的改动闸门状态机。纯逻辑;文件 IO 经注入 FileIo。
 */
export class ChangeRegistry {
  private state: PersistedSessionState

  constructor(
    readonly sessionId: string,
    private readonly io: FileIo,
    initial?: PersistedSessionState,
  ) {
    this.state = initial !== undefined && initial.sessionId === sessionId
      ? initial
      : emptySessionState(sessionId)
  }

  /** 当前可序列化状态(供持久化)。 */
  snapshot(): PersistedSessionState {
    return this.state
  }

  /** 登记一次 write/edit。异步:需读文件算 lastKnownHash(事件到达时文件已是 after 态)。 */
  async recordChange(input: ChangeInput): Promise<void> {
    const path = this.io.normalizePath(input.path)
    if (path === '') return
    const now = input.createdAt ?? Date.now()

    let facts: FileFacts
    try {
      facts = await this.io.readFacts(path)
    } catch {
      facts = { currentContent: null, currentHash: null }
    }

    let file = this.state.files[path]
    if (file === undefined) {
      file = {
        path,
        // 首次登记即用「改动前内容」当基线 → 改动过就有 diff,不必先 Keep。
        // beforeText 为 null(新建/后端不提供)时留 null,由 created 走空基线。
        baseline: input.beforeText ?? null,
        baselineHash: input.beforeText === undefined || input.beforeText === null
          ? null
          : hashOf(input.beforeText),
        lastKnownHash: facts.currentHash,
        firstPendingTurn: input.turn,
        lastPendingTurn: input.turn,
        turns: [input.turn],
        changeCount: 0,
        created: input.created === true,
      }
      this.state.files[path] = file
      // beforeText 给了基线但基线等于当前内容(空改动)→ 无待确认,条目仍保留
      // 基线供将来对比(与 keep 的"基线在、pending 空"一致)。
    } else if (facts.currentHash !== null) {
      // 只在成功读到文件时更新 lastKnownHash。读失败(null,文件被删/不可读)
      // 时保留原值 —— 否则 adopt 回放历史事件会抹掉已删除文件的 hash,
      // 导致后续 keep/undo 一律 unreadable 卡死。
      file.lastKnownHash = facts.currentHash
    }
    // 「新建」对本条目是单调事实:一旦为真就保持,直到 keep 以真实基线接管。
    if (input.created === true) file.created = true
    mergeTurn(file, input.turn)
    file.changeCount += 1

    this.state.records.push({ turn: input.turn, step: input.step, path, createdAt: now })
    if (typeof input.seq === 'number') this.advanceSeq(input.seq)
  }

  /** 推进对账游标(只前进)。 */
  advanceSeq(seq: number): void {
    if (Number.isFinite(seq) && seq > this.state.lastSeq) this.state.lastSeq = seq
  }

  /**
   * 批量登记(一次 tool/result 事件的全部 diff,或对账回放的一段)。
   * 带 seq 的输入按游标幂等过滤(seq <= lastSeq 已消费过,跳过);
   * 全部应用后推进游标到 seq。
   */
  async recordChanges(inputs: readonly ChangeInput[], seq?: number): Promise<void> {
    let applied = 0
    for (const input of inputs) {
      if (input.seq !== undefined && input.seq <= this.state.lastSeq) continue
      await this.recordChange(input)
      applied += 1
    }
    if (typeof seq === 'number') this.advanceSeq(seq)
    return
  }

  /**
   * Keep 某文件:读当前内容为新基线(纯元数据,不写文件),清 pending。
   * 文件条目保留(基线供未来 undo)。
   *
   * 文件当前不存在(被删/移走)时:keep = 接受现状(含删除),清 pending 并移除条目
   * —— 文件已不在工作区,继续跟踪无意义,也不该让 keepAll 报 failed。
   */
  async keep(pathRaw: string): Promise<{ ok: boolean; reason?: 'unreadable' | 'no-pending' }> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined || !hasPending(file)) return { ok: true, reason: 'no-pending' }
    const facts = await this.io.readFacts(path)
    if (facts.currentContent === null || facts.currentHash === null) {
      // 文件不存在 → 接受删除:清 pending 并移除条目(不再跟踪)。
      this.state.records = this.state.records.filter(r => r.path !== path)
      delete this.state.files[path]
      return { ok: true, reason: 'no-pending' }
    }
    file.baseline = facts.currentContent
    file.baselineHash = facts.currentHash
    file.lastKnownHash = facts.currentHash
    // 真实基线已接管:此后 diff 以它为准,不再借用「新建 = 空文件」的推断。
    file.created = false
    clearPending(file)
    this.state.records = this.state.records.filter(r => r.path !== path)
    return { ok: true }
  }

  /** Keep 全部(有 pending 的文件)。 */
  async keepAll(): Promise<{ ok: boolean; kept: string[]; failed: Array<{ path: string; reason: string }> }> {
    const kept: string[] = []
    const failed: Array<{ path: string; reason: string }> = []
    for (const path of Object.keys(this.state.files)) {
      const r = await this.keep(path)
      if (r.ok) kept.push(path)
      else failed.push({ path, reason: r.reason ?? 'unknown' })
    }
    return { ok: failed.length === 0, kept, failed }
  }

  /**
   * Undo 准备:校验后返回应写回的基线内容(不写文件)。
   * host 层随后:1) 用 ctx.fs 写回 content;2) 调 commitUndoWrite(path)。
   */
  async prepareUndo(pathRaw: string): Promise<{ content: string; path: string }> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined || !hasPending(file)) throw new UndoError('no-pending', 'no pending change for this file', path)
    // 基线取法与 baselineOf 一致(真实基线 → 新建的空基线):新建文件同样可撤销。
    // 早先这里直查 `file.baseline === null`,绕过了 baselineOf 的「新建 = 空文件」
    // 推断,于是新建文件永远报 no-baseline,而预览里却能正常显示整篇新增 ——
    // 同一个概念两处判据不一致。
    const baseline = baselineOf(file)
    if (baseline === null) {
      throw new UndoError('no-baseline', 'file has no baseline (never kept); cannot undo to before its first change', path)
    }
    const facts = await this.io.readFacts(path)
    if (facts.currentHash === null) {
      throw new UndoError('file-unreadable', 'cannot read current file content', path)
    }
    if (facts.currentHash !== file.lastKnownHash) {
      throw new UndoError('hash-mismatch', 'file was modified outside the agent; undo refused', path)
    }
    // 写回 baselineOf 的结果而非 file.baseline:新建文件没有真实基线,写回的是空
    // 内容(即它被创建时的样子)。清空而不是删除 —— harness 的 fs 契约没有删除
    // 能力(见 baselineOf 注释),清空是这套边界内可逆且可预测的撤销语义。
    return { content: baseline, path }
  }

  /** host 成功写回后调用:更新状态。undo 后文件回到基线,条目删除。 */
  commitUndoWrite(pathRaw: string): void {
    const path = this.io.normalizePath(pathRaw)
    if (this.state.files[path] === undefined) return
    this.state.records = this.state.records.filter(r => r.path !== path)
    delete this.state.files[path]
  }

  /** 该文件是否可 undo(供 UI 禁用/提示)。 */
  async canUndo(pathRaw: string): Promise<{ ok: boolean; reason?: UndoErrorCode }> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined || !hasPending(file)) return { ok: false, reason: 'no-pending' }
    // 与 prepareUndo 同一判据:新建文件有(空)基线,可撤销。两处必须一致,否则
    // UI 显示可撤销而实际拒绝,或反之。
    if (baselineOf(file) === null) return { ok: false, reason: 'no-baseline' }
    const facts = await this.io.readFacts(path)
    if (facts.currentHash === null) return { ok: false, reason: 'file-unreadable' }
    if (facts.currentHash !== file.lastKnownHash) return { ok: false, reason: 'hash-mismatch' }
    return { ok: true }
  }

  /**
   * 取某文件当前可操作的改动块。
   *
   * 现算而非读存储:块的行号会随文件演进漂移,存下来必然失效。基线取法与
   * {@link baselineOf} 一致(真实基线 → 新建空基线 → 无基线则空列表)。
   * @param pathRaw - 文件路径。
   * @returns 改动块列表;无基线、不可读或超限时为空数组。
   */
  async hunksFor(pathRaw: string): Promise<Hunk[]> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined) return []
    const facts = await this.io.readFacts(path).catch(() => ({ currentContent: null, currentHash: null }))
    return changesOf(file, facts, this.io.displayPath(file.path)).hunks
  }

  /**
   * 接受一个改动块:基线前移该块。
   *
   * 语义是"这一段我认可了" —— 只动元数据(不写文件),与文件级 keep 同族。
   * @param pathRaw - 文件路径。
   * @param index - 块索引(以 {@link hunksFor} 的当次结果为准)。
   * @returns 是否成功。
   */
  async acceptHunk(pathRaw: string, index: number): Promise<boolean> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined) return false
    const facts = await this.io.readFacts(path).catch(() => ({ currentContent: null, currentHash: null }))
    const baseline = baselineOf(file)
    if (baseline === null || facts.currentContent === null) return false
    const next = acceptHunkIn(baseline, facts.currentContent, index)
    if (next === null) return false
    file.baseline = next
    file.baselineHash = hashOf(next)
    // 基线已覆盖到 current 时,该文件不再有待决改动 → 条目移除(与 keep 同语义)。
    if (next === facts.currentContent) {
      file.created = false
      file.lastKnownHash = facts.currentHash
      clearPending(file)
      this.state.records = this.state.records.filter(r => r.path !== path)
      return true
    }
    // 新建文件一旦获得真实基线就不再是"整篇新增"。
    file.created = file.created && next === ''
    if (facts.currentHash !== null) file.lastKnownHash = facts.currentHash
    return true
  }

  /**
   * 撤销一个改动块:算出应写回磁盘的内容(不写)。
   * @param pathRaw - 文件路径。
   * @param index - 块索引。
   * @returns 应写回的内容与路径;失败抛 {@link UndoError}。
   */
  async prepareRevertHunk(pathRaw: string, index: number): Promise<{ content: string, path: string }> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined || !hasPending(file)) {
      throw new UndoError('no-pending', 'no pending change for this file', path)
    }
    const facts = await this.io.readFacts(path)
    const baseline = baselineOf(file)
    if (baseline === null || facts.currentContent === null) {
      throw new UndoError('no-baseline', 'no baseline to revert this hunk against', path)
    }
    const next = revertHunkIn(baseline, facts.currentContent, index)
    if (next === null) {
      throw new UndoError('no-pending', 'this change is no longer present in the file', path)
    }
    return { content: next, path }
  }

  /**
   * 撤销某块后更新状态。
   *
   * 与 {@link commitUndoWrite} 的区别:文件级 undo 之后回到基线、条目删除;块级
   * undo 只回退一段,其余改动仍在 → 条目保留,只更新 lastKnownHash。若写回结果
   * 已等于基线(最后一块也被撤销),则与文件级同归:条目移除。
   * @param pathRaw - 文件路径。
   * @param content - 已写回的内容。
   */
  commitRevertHunk(pathRaw: string, content: string): void {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined) return
    file.lastKnownHash = hashOf(content)
    const baseline = file.baseline ?? (file.created ? '' : null)
    if (baseline !== null && content === baseline) {
      this.state.records = this.state.records.filter(r => r.path !== path)
      delete this.state.files[path]
    }
  }

  /** 「待确认」文件级视图(仅含 pending 文件),按最近改动轮倒序。 */
  /** 单文件的改动视图(文件预览渲染器用)。 */
  async changesFor(pathRaw: string): Promise<FileChangesView | undefined> {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    if (file === undefined) return undefined
    const facts = await this.io.readFacts(path).catch(() => ({ currentContent: null, currentHash: null }))
    return changesOf(file, facts, this.io.displayPath(file.path))
  }

  /** 「待确认」文件级视图(仅含 pending 文件),按最近改动轮倒序。 */
  async fileViews(): Promise<FileStateView[]> {
    const out: FileStateView[] = []
    for (const file of Object.values(this.state.files)) {
      if (!hasPending(file)) continue
      const facts = await this.io.readFacts(file.path).catch(() => ({ currentContent: null, currentHash: null }))
      const canUndo = baselineOf(file) !== null
        && facts.currentHash !== null
        && facts.currentHash === file.lastKnownHash
      // 统计复用上面这次读取的内容,不额外读盘。基线不可用(从未 Keep 且非新建)
      // 或当前读不到时给 undefined —— UI 据此不显示统计,而不是显示 +0 -0。
      const baseline = baselineOf(file)
      const totals = baseline !== null && facts.currentContent !== null
        ? hunkTotals(hunksOf(baseline, facts.currentContent))
        : null
      out.push({
        path: file.path,
        display: this.io.displayPath(file.path),
        // 撤销是否真的可用,由 host 判定并下发 —— 判定需要"文件现在读得到吗"与
        // "内容还是登记时那份吗",两者只有读得到文件的这一侧才知道。此前由客户端
        // 用两个下发字段拼,删掉的文件因此变成"可点却失败"。
        canUndo,
        ...(canUndo ? {} : {
          undoBlockedBy: baseline === null ? 'no-baseline' as const
            : facts.currentHash === null ? 'file-unreadable' as const
              : 'hash-mismatch' as const,
        }),
        firstPendingTurn: file.firstPendingTurn,
        lastPendingTurn: file.lastPendingTurn,
        changeCount: file.changeCount,
        turns: [...file.turns],
        ...(totals === null ? {} : { added: totals.added, removed: totals.removed }),
      })
    }
    out.sort((a, b) => b.lastPendingTurn - a.lastPendingTurn)
    return out
  }

  /** 展示记录视图(仅 UI)。 */
  displayRecords(): DisplayRecordView[] {
    return this.state.records.map(r => ({
      turn: r.turn,
      step: r.step,
      path: r.path,
      createdAt: r.createdAt,
    }))
  }

  /** 该文件是否有待确认改动。 */
  hasPending(pathRaw: string): boolean {
    const path = this.io.normalizePath(pathRaw)
    const file = this.state.files[path]
    return file !== undefined && hasPending(file)
  }
}

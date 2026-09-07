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

import type { DisplayRecordView, FileStateView } from '../shared/wire.ts'

/** 一次登记的输入(来自 tool/result 的 meta.diffs + 事件归属)。 */
export interface ChangeInput {
  turn: number
  step: number
  /** 事件里 diff.path。 */
  path: string
  oldText: string | null
  newText: string
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
        baseline: null,
        baselineHash: null,
        lastKnownHash: facts.currentHash,
        firstPendingTurn: input.turn,
        lastPendingTurn: input.turn,
        turns: [input.turn],
        changeCount: 0,
      }
      this.state.files[path] = file
    } else if (facts.currentHash !== null) {
      // 只在成功读到文件时更新 lastKnownHash。读失败(null,文件被删/不可读)
      // 时保留原值 —— 否则 adopt 回放历史事件会抹掉已删除文件的 hash,
      // 导致后续 keep/undo 一律 unreadable 卡死。
      file.lastKnownHash = facts.currentHash
    }
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
    if (file.baseline === null || file.baselineHash === null) {
      throw new UndoError('no-baseline', 'file has no baseline (never kept); cannot undo to before its first change', path)
    }
    const facts = await this.io.readFacts(path)
    if (facts.currentHash === null) {
      throw new UndoError('file-unreadable', 'cannot read current file content', path)
    }
    if (facts.currentHash !== file.lastKnownHash) {
      throw new UndoError('hash-mismatch', 'file was modified outside the agent; undo refused', path)
    }
    return { content: file.baseline, path }
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
    if (file.baseline === null || file.baselineHash === null) return { ok: false, reason: 'no-baseline' }
    const facts = await this.io.readFacts(path)
    if (facts.currentHash === null) return { ok: false, reason: 'file-unreadable' }
    if (facts.currentHash !== file.lastKnownHash) return { ok: false, reason: 'hash-mismatch' }
    return { ok: true }
  }

  /** 「待确认」文件级视图(仅含 pending 文件),按最近改动轮倒序。 */
  async fileViews(): Promise<FileStateView[]> {
    const out: FileStateView[] = []
    for (const file of Object.values(this.state.files)) {
      if (!hasPending(file)) continue
      const facts = await this.io.readFacts(file.path).catch(() => ({ currentContent: null, currentHash: null }))
      out.push({
        path: file.path,
        hasBaseline: file.baseline !== null,
        firstPendingTurn: file.firstPendingTurn,
        lastPendingTurn: file.lastPendingTurn,
        changeCount: file.changeCount,
        turns: [...file.turns],
        hashMatches: facts.currentHash === null || file.lastKnownHash === null || facts.currentHash === file.lastKnownHash,
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

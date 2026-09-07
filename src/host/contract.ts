/**
 * dsh-striatum — host 服务契约(StriatumService 结构面)。
 * api/capture 只依赖此结构面,避免循环依赖。
 */
import type { StriatumState } from '../shared/wire.ts'
import type { ChangeInput } from './registry.ts'

/** keep/undo 结果。 */
export interface KeepResult {
  ok: boolean
  paths: string[]
  failed: Array<{ path: string; reason: string }>
}

/** StriatumService 暴露给 api/capture 的接口。 */
export interface StriatumServiceFace {
  /** 登记一次改动(捕获层)。 */
  record(sessionId: string, input: ChangeInput): Promise<void>
  /** 批量登记 + 推进 seq 游标(对账回放用)。 */
  recordSeq(sessionId: string, inputs: readonly ChangeInput[], seq: number): Promise<void>
  /** Keep 单文件或全部(path 省略 = 全部)。 */
  keep(sessionId: string, path?: string): Promise<KeepResult>
  /** Undo 单文件(写回基线 + 状态更新);冲突抛 UndoError。 */
  undo(sessionId: string, path: string): Promise<void>
  /** 当前状态(供 UI 初始化 / SSE 广播)。 */
  state(sessionId: string): Promise<StriatumState>
  /** 该文件是否可 undo。 */
  canUndo(sessionId: string, path: string): Promise<{ ok: boolean; reason?: string }>
  /** 释放会话。 */
  disposeSession(sessionId: string): void
}

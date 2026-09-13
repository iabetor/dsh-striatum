/**
 * dsh-striatum — host 服务契约(StriatumService 结构面)。
 * api/capture 只依赖此结构面,避免循环依赖。
 */
import type { FileChangesView, StriatumState } from '../shared/wire.ts'
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
  /** 单文件的改动视图(文件预览渲染器用)。 */
  changes(sessionId: string, path: string): Promise<FileChangesView>
  /** 接受一个改动块:基线前移该块(纯元数据)。 */
  acceptHunk(sessionId: string, path: string, index: number): Promise<boolean>
  /** 撤销一个改动块:写回该块的改动前片段。 */
  revertHunk(sessionId: string, path: string, index: number): Promise<void>
  /** 该文件是否可 undo。 */
  canUndo(sessionId: string, path: string): Promise<{ ok: boolean; reason?: string }>
  /** 释放会话。 */
  disposeSession(sessionId: string): void
}

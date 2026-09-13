/**
 * dsh-striatum — client /striatum/api 封装(typed fetch)。
 */
import type { FileChangesView, StriatumState } from '../shared/wire.ts'

/** API 错误。 */
export class StriatumApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'StriatumApiClientError'
  }
}

/** 一次 /striatum/api/<method> 调用。 */
async function call<T>(
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/striatum/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    throw new StriatumApiClientError('network', 'striatum api unreachable', 0)
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new StriatumApiClientError('bad-response', 'striatum api returned non-JSON', res.status)
  }
  const record = payload as { ok?: boolean; code?: string; message?: string }
  if (!res.ok || record.ok === false) {
    throw new StriatumApiClientError(record.code ?? 'error', record.message ?? `HTTP ${res.status}`, res.status)
  }
  return payload as T
}

/** 取某会话当前状态。 */
export function fetchState(sessionId: string, signal?: AbortSignal): Promise<StriatumState> {
  return call<StriatumState>('state', { sessionId }, signal)
}

/** Keep 单文件(省略 path = 全部)。 */
export function keep(sessionId: string, path?: string): Promise<{ ok: boolean; paths: string[]; failed: Array<{ path: string; reason: string }> }> {
  return call('keep', path === undefined ? { sessionId } : { sessionId, path })
}

/** Undo 单文件。冲突抛 StriatumApiClientError(code=conflict)。 */
export function undo(sessionId: string, path: string): Promise<{ ok: boolean; paths: string[] }> {
  return call('undo', { sessionId, path })
}

/** 取某文件的改动视图(文件预览渲染器用)。 */
export function fetchChanges(sessionId: string, path: string, signal?: AbortSignal): Promise<FileChangesView> {
  return call<FileChangesView>('changes', { sessionId, path }, signal)
}

/** 接受一个改动块(基线前移;不写文件)。 */
export function acceptHunk(sessionId: string, path: string, index: number): Promise<{ ok: boolean; paths: string[] }> {
  return call('acceptHunk', { sessionId, path, index })
}

/** 撤销一个改动块(写回该块的改动前片段)。 */
export function revertHunk(sessionId: string, path: string, index: number): Promise<{ ok: boolean; paths: string[] }> {
  return call('revertHunk', { sessionId, path, index })
}

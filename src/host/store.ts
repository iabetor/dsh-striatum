/**
 * dsh-striatum — 会话级持久化:每会话一个 JSONL,存完整会话状态(可重建 registry)。
 *
 * Layout: ~/.dsh/striatum/<sessionId>.jsonl
 * 与 dsh-thalamus 的 notifications.jsonl 同模式:每次变更整文件原子重写
 * (单会话状态小;重写比追加+裁剪更简单安全)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  parsePersistedState,
  type PersistedSessionState,
} from './registry.ts'

/** Resolve the storage root(默认 ~/.dsh/striatum)。 */
export function storageRoot(memoryRoot?: string): string {
  return resolve(memoryRoot ?? join(homedir(), '.dsh', 'striatum'))
}

/** 会话状态文件路径。sessionId 需已做安全化(只允许 [A-Za-z0-9_-])。 */
export function sessionPath(root: string, sessionId: string): string {
  return join(root, `${sessionId}.jsonl`)
}

/** 读取某会话的持久化状态;文件缺失/损坏返回 undefined。 */
export async function readSessionState(root: string, sessionId: string): Promise<PersistedSessionState | undefined> {
  try {
    const raw = await readFile(sessionPath(root, sessionId), 'utf8')
    return parsePersistedState(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** 写入某会话的完整状态(原子:tmp + rename)。 */
export async function writeSessionState(root: string, state: PersistedSessionState): Promise<void> {
  try {
    const dir = resolve(sessionPath(root, state.sessionId), '..')
    await mkdir(dir, { recursive: true })
    const path = sessionPath(root, state.sessionId)
    const temp = `${path}.tmp-${Date.now().toString(36)}`
    await writeFile(temp, JSON.stringify(state), 'utf8')
    await rename(temp, path)
  } catch {
    // Best-effort:存储失败不打断调用方
  }
}

/** 删除某会话的状态文件(会话删除/归档时)。 */
export async function deleteSessionState(root: string, sessionId: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises')
    await rm(sessionPath(root, sessionId), { force: true })
  } catch {
    // best-effort
  }
}

/** 安全化 sessionId(仅保留文件名安全字符)。 */
export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
}

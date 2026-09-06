/**
 * dsh-striatum — capture:监听 session/event 的 tool/result,提取 meta.diffs,
 * 登记进 StriatumService(M0 已验证:meta.diffs 原样保留、事件到达时文件已是 after)。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { StriatumServiceFace } from './contract.ts'

/** 从 tool/result 事件提取合法 diffs(meta.diffs 是 write/edit 的私有负载)。 */
export function diffsOfEvent(event: SessionEvent<'tool/result'>): Array<{ path: string; oldText: string | null; newText: string }> {
  const diffs = (event.data.meta as { diffs?: unknown } | undefined)?.diffs
  if (!Array.isArray(diffs)) return []
  const out: Array<{ path: string; oldText: string | null; newText: string }> = []
  for (const d of diffs) {
    if (typeof d !== 'object' || d === null) continue
    const v = d as Record<string, unknown>
    if (typeof v.path === 'string'
      && (v.oldText === null || typeof v.oldText === 'string')
      && typeof v.newText === 'string') {
      out.push({ path: v.path, oldText: v.oldText, newText: v.newText })
    }
  }
  return out
}

/**
 * 注册 capture:每个会话的 tool/result(带 diffs)登记进该会话的 service。
 * cordis 事件类型:ctx.on('session/event') 由 dsh-session 声明(peer 依赖)。
 */
export function registerCapture(
  ctx: Context,
  service: StriatumServiceFace,
): void {
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'tool/result') return
    const diffs = diffsOfEvent(event)
    if (diffs.length === 0) return
    for (const diff of diffs) {
      void service.record(session.id, {
        turn: event.data.turn,
        step: event.data.step,
        path: diff.path,
        oldText: diff.oldText,
        newText: diff.newText,
      }).catch(() => { /* 登记失败不炸会话 */ })
    }
  })
}

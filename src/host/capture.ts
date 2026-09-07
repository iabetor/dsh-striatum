/**
 * dsh-striatum — capture:从会话事件流提取 write/edit 改动并登记。
 *
 * 登记事实(设计文档 §5.2 修正):
 *  - 主路径:tool/result.meta.diffs —— edit 与「覆盖已有文件」的 write 携带
 *    (hunk 级,path/oldText/newText);事件到达时文件已是 after 态(M0 验证);
 *  - create 路径:新建文件的 write 因 before===null 不产 diffs(harness
 *    presentationMeta 返回 []),此时按 tool/result 的 sourceEventSeqs[0] 回查
 *    配对的 tool/call,用其参数 file_path 登记(newText 由登记时读文件获得)。
 *
 * 对账(重启补登,设计文档 §4.3/§7.3):
 *  - registry 持久化 lastSeq = 已处理的最大 tool/result seq;
 *  - 插件挂载时 adopt 每个 live 会话(启动 sweep + session/created),回放
 *    seq > lastSeq 的 tool/result(经同一提取逻辑)→ 幂等补登;
 *  - 事件提取是纯同步的,每个会话经串行任务链执行,与 firehose 无竞态。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { StriatumServiceFace } from './contract.ts'
import type { ChangeInput } from './registry.ts'

/** tool/call 事件里 write/edit 的参数提取(仅需要 file_path)。 */
export function mutationPathOf(name: string, argsRaw: string): string | null {
  if (name !== 'write' && name !== 'edit') return null
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null) return null
  const filePath = (args as Record<string, unknown>).file_path
  return typeof filePath === 'string' && filePath.trim() !== '' ? filePath : null
}

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

/** 读 tool/result 引用的 call 事件(sourceEventSeqs[0] = call 的 seq;日志下标与 seq 同)。 */
function callEventOf(
  session: Session,
  event: SessionEvent<'tool/result'>,
): SessionEvent<'tool/call'> | undefined {
  const cited = (event as { sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs
  const seq = Array.isArray(cited) && typeof cited[0] === 'number' ? cited[0] : undefined
  if (seq === undefined) return undefined
  const candidate = session.eventAt(seq as never) ?? session.snapshotEvents()[seq]
  if (candidate !== undefined && candidate.type === 'tool/call') return candidate as SessionEvent<'tool/call'>
  return undefined
}

/**
 * 从一次 tool/result 提取要登记的 ChangeInput(纯同步;无改动返回 [])。
 * - diffs 非空 → 每个 diff 一条(edit / 覆盖 write);
 * - diffs 为空且配对 call 是 write → create 补登一条(以 call 的 file_path)。
 * 每条都带事件 seq(供游标/去重)。
 */
export function changesOfResult(
  session: Session,
  event: SessionEvent<'tool/result'>,
): ChangeInput[] {
  const { turn, step } = event.data
  const diffs = diffsOfEvent(event)
  if (diffs.length > 0) {
    return diffs.map(diff => ({
      turn, step, seq: event.seq,
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
    }))
  }
  const call = callEventOf(session, event)
  if (call === undefined) return []
  const path = mutationPathOf(call.data.name, call.data.arguments)
  if (path === null || call.data.name !== 'write') return []
  // write 无 diffs = 新建(create;harness 对 before===null 不产 diffs)
  return [{
    turn, step, seq: event.seq,
    path,
    oldText: null,
    newText: '',
  }]
}

/**
 * 注册 capture:
 *  - firehose:每个会话的 tool/result 经 changesOfResult 登记并推进游标;
 *  - adopt:启动时对已在 ctx.sessions 的会话 + 之后 session/created 的会话,
 *    回放 seq > 持久化 lastSeq 的事件补登(幂等)。
 * 同会话的处理串行化(链队列),避免对账回放与 live 事件交错。
 */
export function registerCapture(
  ctx: Context,
  service: StriatumServiceFace,
): void {
  // 每会话一条任务链;reconcile 任务先入队,live 事件任务随后,天然有序。
  const chains = new Map<string, Promise<void>>()

  const enqueue = (session: Session, task: () => Promise<void>): void => {
    const previous = chains.get(session.id) ?? Promise.resolve()
    const next = previous.then(task).catch(() => { /* 单个任务失败不阻塞后续 */ })
    chains.set(session.id, next)
    void next.finally(() => {
      if (chains.get(session.id) === next) chains.delete(session.id)
    })
  }

  const adopt = (session: Session): void => {
    // 同步快照此刻的日志;之后的增量走 firehose,不会漏也不会重。
    const events = session.snapshotEvents()
    enqueue(session, async () => {
      const results = events.filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
      if (results.length === 0) return
      // 每个 result 提取(纯同步),批量登记并推进到最大 seq。
      const inputs: ChangeInput[] = []
      let maxSeq = 0
      for (const event of results) {
        inputs.push(...changesOfResult(session, event))
        if (event.seq > maxSeq) maxSeq = event.seq
      }
      await service.recordSeq(session.id, inputs, maxSeq)
    })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'tool/result') return
    enqueue(session, async () => {
      await service.recordSeq(session.id, changesOfResult(session, event), event.seq)
    })
  })

  // adopt 已 live 的会话 + 未来的新会话(headless 无 session/created 重放,
  // 故启动 sweep 必须覆盖;hot reload 同理靠 lastSeq 游标幂等)。
  for (const session of ctx.sessions.list()) adopt(session)
  ctx.on('session/created', (session: Session) => adopt(session))
}

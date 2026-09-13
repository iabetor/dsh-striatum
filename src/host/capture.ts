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
// Type-only:`tools/execute` 事件的 Events 合并(用于包装器获得类型)。
// 该包只提供类型声明,运行时不加载 —— 事件名与本插件对 tools 服务的依赖都不落盘。
import type {} from '@deepseek-ai/dsh-tools'
import type { StriatumServiceFace } from './contract.ts'
import type { ChangeInput } from './registry.ts'

/**
 * write/edit 工具在改动**之前**的完整内容,按 callId 暂存。
 *
 * 来源是 `tools/execute` 包装器拿到的工具返回值 `{ before, after }`(harness
 * 的 write/edit 都返回全文,**不是** hunk)。`tool/result` 到达时按 sourceEventSeqs[0]
 * 指向的 call 事件取出 callId 与之配对。
 *
 * 为什么需要它:`meta.diffs` 只保留 ±3 行上下文的 hunk,丢弃了全文,因此
 * "首次改动"没有可对比的基线 —— 用户必须先 Keep 一次才能看到 diff。有了
 * before 就能让「改动过就有 diff」成立。
 */
type BeforeStore = Map<string, string | null>

/** 单会话暂存表的条目上限(兜底:未被 tool/result 消费的残项)。 */
export const BEFORE_STORE_MAX = 64

/** 注册一个空的前置内容暂存表(每会话一个)。 */
export function createBeforeStore(): BeforeStore {
  return new Map()
}

/**
 * 取工具返回值里的「改动前全文」。
 *
 * write/edit 的 canonical value 是 `{ path, before, after }`(harness 的
 * tool-fs 返回全文,**不是** hunk);其它工具或结构不符时返回 undefined。
 * @param name - 工具名。
 * @param value - `tools/execute` 包装器拿到的 canonical value。
 * @returns 改动前全文;新建文件为 null;非 write/edit 或结构不符为 undefined。
 */
export function beforeTextOf(name: string, value: unknown): string | null | undefined {
  if (name !== 'write' && name !== 'edit') return undefined
  if (typeof value !== 'object' || value === null) return undefined
  const before = (value as Record<string, unknown>).before
  if (before === null) return null
  return typeof before === 'string' ? before : undefined
}

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
 *
 * 「新建」判据:harness 的 write 在 `before === null` 时**明确返回 `diffs: []`**
 * (见 tool-fs/src/write.ts 的 presentationMeta),所以走下面 create 分支的即为
 * 新建。这里显式标 `created: true` —— 不要靠 `oldText === null` 反推,因为纯
 * 插入式 edit 同样会给 `oldText: null`(computeHunkDiffs 的约定),两者语义相反。
 */
export function changesOfResult(
  session: Session,
  event: SessionEvent<'tool/result'>,
  beforeOf?: (callId: string) => string | null | undefined,
): ChangeInput[] {
  const { turn, step } = event.data
  const call = callEventOf(session, event)
  // 本次改动的「改动前全文」:由 tools/execute 包装器按 callId 暂存。
  // 取不到(非本次进程执行/未包装)时为 undefined —— registry 会退回"需先 Keep"。
  const beforeText = call === undefined || beforeOf === undefined
    ? undefined
    : beforeOf(call.data.callId)
  const diffs = diffsOfEvent(event)
  if (diffs.length > 0) {
    return diffs.map(diff => ({
      turn, step, seq: event.seq,
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
      // 同一文件的多 hunk 共享同一份 before(整文件级),各自登记时都带上;
      // registry 只在首次(无基线)采纳,重复无副作用。
      ...beforeText === undefined ? {} : { beforeText },
    }))
  }
  if (call === undefined) return []
  const path = mutationPathOf(call.data.name, call.data.arguments)
  if (path === null || call.data.name !== 'write') return []
  // write 且 harness 未产 diffs = 新建(before === null);newText 由登记时读文件获得。
  return [{
    turn, step, seq: event.seq,
    path,
    oldText: null,
    newText: '',
    created: true,
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

  // 每会话的「改动前全文」暂存,按 callId 索引。tools/execute 包装器写入,
  // tool/result 处理时读出并交给 registry 作首次基线。
  const beforeStores = new Map<string, BeforeStore>()
  const storeOf = (sessionId: string): BeforeStore => {
    let store = beforeStores.get(sessionId)
    if (store === undefined) {
      store = createBeforeStore()
      beforeStores.set(sessionId, store)
    }
    return store
  }

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
      const store = storeOf(session.id)
      const inputs: ChangeInput[] = []
      let maxSeq = 0
      for (const event of results) {
        inputs.push(...changesOfResult(session, event, callId => store.get(callId)))
        if (event.seq > maxSeq) maxSeq = event.seq
      }
      await service.recordSeq(session.id, inputs, maxSeq)
    })
  }

  // 在工具 dispatch 前后各取一次:包装器在 `next()` 之后拿到 canonical value
  // (含 before/after 全文),此时结果尚未写入会话日志 —— 比 tool/result 更早,
  // 且不像 tool/call 那样有"写前抢读"的竞态。
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (result.isError) return result
    const sessionId = exec.agent?.id
    if (sessionId === undefined) return result
    const before = beforeTextOf(exec.name, result.value)
    if (before === undefined) return result
    const store = storeOf(String(sessionId))
    store.set(String(exec.callId), before)
    // 上限保护:只保留最近若干次。正常情况下 tool/result 会立刻消费掉对应项,
    // 这里兜底的是"结果没走 tool/result"(被取消/拦截)时留下的残项。
    while (store.size > BEFORE_STORE_MAX) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      store.delete(oldest)
    }
    return result
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'tool/result') return
    const store = storeOf(session.id)
    enqueue(session, async () => {
      // 消费即删:before 是整文件全文,长期驻留会明显占内存。
      const takeBefore = (callId: string): string | null | undefined => {
        const value = store.get(callId)
        store.delete(callId)
        return value
      }
      await service.recordSeq(session.id, changesOfResult(session, event, takeBefore), event.seq)
    })
  })

  // 会话释放时丢掉它的暂存表与任务链,避免插件长驻期间累积。
  ctx.on('session/disposed', (session: Session) => {
    beforeStores.delete(session.id)
    chains.delete(session.id)
  })

  // adopt 已 live 的会话 + 未来的新会话(headless 无 session/created 重放,
  // 故启动 sweep 必须覆盖;hot reload 同理靠 lastSeq 游标幂等)。
  for (const session of ctx.sessions.list()) adopt(session)
  ctx.on('session/created', (session: Session) => adopt(session))
}

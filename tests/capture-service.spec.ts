/**
 * dsh-striatum — capture × service 集成测试:
 * registerCapture 的 adopt(启动回放)+ firehose(tool/result 事件)驱动
 * 真实 StriatumService,验证:
 *  - create(write 无 diffs)→ 经 sourceEventSeqs 回查 call 补登;
 *  - 重复 adopt(热重载/重启对账)幂等;
 *  - 非 write 的 result 不登记。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { StriatumService, type StriatumFsFace } from '../src/index.ts'
import { registerCapture } from '../src/host/capture.ts'

/** mock fs(同 service.spec)。 */
class MockFs implements StriatumFsFace {
  contents = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.contents.set(p, c)
  }
  async resolve(path: string): Promise<{ path: string }> { return { path } }
  async readText(target: { path: string }): Promise<string> {
    const content = this.contents.get(target.path)
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  async writeText(target: { path: string }, content: string): Promise<unknown> {
    this.contents.set(target.path, content)
    return {}
  }
  agentWrite(path: string, content: string): void { this.contents.set(path, content) }
}

const mockSessions = { get: (id: string) => ({ header: { cwd: `/work/${id}` } }) }
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** registerCapture 用的 ctx(stub sessions.list 为空;adopt 由 session/created 驱动)。 */
function captureCtx(): Context {
  const ctx = new Context()
  ;(ctx as unknown as { sessions: unknown }).sessions = { list: () => [] }
  return ctx
}

/** 轮询等待某会话出现 pending 文件(adopt 是异步链)。 */
async function waitFiles(service: StriatumService, sessionId: string, min: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const st = await service.state(sessionId)
    if (st.files.length >= min) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${min} files on ${sessionId}`)
}

/** 触发 capture 的 session/created(类型宽松 emit)。 */
function emitCreated(ctx: Context, session: Session): void {
  ;(ctx as unknown as { emit: (name: string, session: Session) => void })
    .emit('session/created', session)
}

async function makeService(fs: MockFs): Promise<{ service: StriatumService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'striatum-cap-'))
  roots.push(root)
  const ctx = new Context()
  const service = new StriatumService(ctx, { root }, fs, mockSessions as never, undefined)
  return { service, root }
}

/** 构造日志下标=seq 的 stub session(真实 Session 契约:seq == log 下标)。 */
function stubSession(id: string): Session & { push(event: SessionEvent): void } {
  const log: SessionEvent[] = []
  const session = {
    id,
    eventAt: (seq: number) => log[seq],
    snapshotEvents: () => log,
    push(event: SessionEvent): void {
      const index = event.seq
      while (log.length <= index) log.push(undefined as never)
      log[index] = event
    },
  } as unknown as Session & { push(event: SessionEvent): void }
  return session
}

/** 造一个 tool/call 事件。 */
function callEvent(seq: number, turn: number, name: string, filePath: string, step = 1): SessionEvent {
  return {
    type: 'tool/call', seq,
    data: { turn, step, callId: `c-${seq}`, name, arguments: JSON.stringify({ file_path: filePath }) },
  } as unknown as SessionEvent
}

/** 造一个 tool/result 事件(callSeq 引用配对 call;meta 可选)。 */
function resultEvent(seq: number, turn: number, meta: unknown, callSeq: number, step = 1): SessionEvent {
  const event = {
    type: 'tool/result', seq,
    data: {
      turn, step,
      message: { role: 'user', content: [], source: { kind: 'tool', callId: `c-${callSeq}` } },
      ...(meta === undefined ? {} : { meta }),
    },
  } as unknown as SessionEvent & { sourceEventSeqs?: SessionSeq[] }
  event.sourceEventSeqs = [callSeq as SessionSeq]
  return event
}

const A = '/work/sess-1/a.go'
const A1 = 'package a\n\nfunc A() { return 1 }\n'

describe('registerCapture × StriatumService', () => {
  it('adopt replays log: edit diffs registered, create write补登, non-write skipped', async () => {
    const fs = new MockFs({ [A]: A1 })
    fs.agentWrite('/work/sess-1/new.go', 'package new\n')
    const { service, root } = await makeService(fs)
    const ctx = captureCtx()
    registerCapture(ctx as never, service)

    // 日志:seq1 edit a.go(diffs);seq2 write new.go(create,无 diffs);seq3 bash(无 diffs)
    const session = stubSession('sess-1')
    session.push(callEvent(0, 1, 'edit', A))
    session.push(resultEvent(1, 1, { diffs: [{ path: A, oldText: 'old', newText: A1 }] }, 0))
    session.push(callEvent(2, 1, 'write', '/work/sess-1/new.go'))
    session.push(resultEvent(3, 1, undefined, 2))
    session.push(callEvent(4, 1, 'bash', '/ignored'))
    session.push(resultEvent(5, 1, undefined, 4))

    // 模拟启动 adopt:直接调用 capture 内部逻辑(通过 session/created 事件驱动)
    emitCreated(ctx, session)
    await waitFiles(service, 'sess-1', 2)

    const st = await service.state('sess-1')
    const paths = st.files.map(f => f.path).sort()
    expect(paths).toEqual([A, '/work/sess-1/new.go'])
    expect(st.files.find(f => f.path === A)!.changeCount).toBe(1)
    expect(st.files.find(f => f.path === '/work/sess-1/new.go')!.changeCount).toBe(1)
    // 游标推进到最大 seq(5)
    const raw = await (await import('node:fs/promises')).readFile(join(root, 'sess-1.jsonl'), 'utf8')
    expect(JSON.parse(raw).lastSeq).toBe(5)
  })

  it('re-adopt (restart replay) is idempotent; new events after cursor register once', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service, root } = await makeService(fs)
    const ctx = captureCtx()
    registerCapture(ctx as never, service)
    const session = stubSession('sess-1')

    // 第一段日志:seq1-2 edit
    session.push(callEvent(0, 1, 'edit', A))
    session.push(resultEvent(1, 1, { diffs: [{ path: A, oldText: 'o', newText: A1 }] }, 0))
    emitCreated(ctx, session)
    await waitFiles(service, 'sess-1', 1)

    // 模拟重启:同一 root 新 service + 重新 adopt(全量回放)+ 新事件 seq3-4
    const ctx2 = captureCtx()
    const service2 = new StriatumService(ctx2, { root }, fs, mockSessions as never, undefined)
    registerCapture(ctx2 as never, service2)
    session.push(callEvent(2, 2, 'write', '/work/sess-1/new.go'))
    fs.agentWrite('/work/sess-1/new.go', 'package new\n')
    session.push(resultEvent(3, 2, undefined, 2))
    emitCreated(ctx2, session)
    await waitFiles(service2, 'sess-1', 2)

    const st = await service2.state('sess-1')
    expect(st.files).toHaveLength(2)
    expect(st.files.find(f => f.path === A)!.changeCount).toBe(1) // 未被重复登记
    expect(st.files.find(f => f.path === '/work/sess-1/new.go')!.changeCount).toBe(1)
  })
})

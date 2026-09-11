/**
 * dsh-striatum — StriatumService 集成测试(mock fs/sessions,验证 record/keep/undo/state 全链路)。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { StriatumService, type StriatumFsFace } from '../src/index.ts'

/** mock fs:内存文件系统,模拟 resolve/readText/writeText。 */
class MockFs implements StriatumFsFace {
  contents = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.contents.set(p, c)
  }
  async resolve(path: string): Promise<{ path: string }> {
    return { path }
  }
  async readText(target: { path: string }): Promise<string> {
    const content = this.contents.get(target.path)
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  async writeText(target: { path: string }, content: string): Promise<unknown> {
    this.contents.set(target.path, content)
    return {}
  }
}

/** mock sessions。 */
const mockSessions = {
  get: (id: string) => ({ header: { cwd: `/work/${id}` } }),
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeService(fs: MockFs): Promise<{ service: StriatumService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'striatum-test-'))
  roots.push(root)
  const ctx = new Context()
  const service = new StriatumService(ctx, { root }, fs, mockSessions as never, undefined)
  return { service, root }
}

const A = '/work/sess-1/a.go'
const A0 = 'package a\n\nfunc A() {}\n'
const A1 = 'package a\n\nfunc A() { return 1 }\n'
const A2 = 'package a\n\nfunc A() int { return 1 }\n'

describe('StriatumService', () => {
  it('record → state reflects pending file; keep → state empty; JSONL persisted', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service, root } = await makeService(fs)
    await service.record('sess-1', { turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    let st = await service.state('sess-1')
    expect(st.files).toHaveLength(1)
    expect(st.files[0]).toMatchObject({ path: A, turns: [1], changeCount: 1, hasBaseline: false })

    await service.keep('sess-1', A)
    st = await service.state('sess-1')
    expect(st.files).toHaveLength(0) // keep 后无 pending

    // JSONL 已持久化
    const raw = await readFile(join(root, 'sess-1.jsonl'), 'utf8')
    const persisted = JSON.parse(raw) as { sessionId: string; files: Record<string, unknown> }
    expect(persisted.sessionId).toBe('sess-1')
    expect(persisted.files[A]).toMatchObject({ baseline: A1 })
  })

  it('undo writes baseline back through fs and clears pending', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service } = await makeService(fs)
    // 第 1 轮:改到 A1,keep(基线 A1)
    await service.record('sess-1', { turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await service.keep('sess-1', A)
    // 第 2 轮:改到 A2(agent 写文件)
    fs.contents.set(A, A2)
    await service.record('sess-1', { turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    expect((await service.state('sess-1')).files).toHaveLength(1)

    // undo → 写回基线 A1
    await service.undo('sess-1', A)
    expect(fs.contents.get(A)).toBe(A1)
    expect((await service.state('sess-1')).files).toHaveLength(0)
  })

  it('undo refuses when file changed externally (hash mismatch)', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', { turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await service.keep('sess-1', A)
    fs.contents.set(A, A2)
    await service.record('sess-1', { turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    // 外部修改
    fs.contents.set(A, 'package a\n\n// human edit\n')
    await expect(service.undo('sess-1', A)).rejects.toMatchObject({ code: 'hash-mismatch' })
    // canUndo 也报告不可用
    const can = await service.canUndo('sess-1', A)
    expect(can.ok).toBe(false)
    expect(can.reason).toBe('hash-mismatch')
  })

  it('undo without baseline refuses (never kept)', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', { turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await expect(service.undo('sess-1', A)).rejects.toMatchObject({ code: 'no-baseline' })
  })

  it('restores registry from persisted JSONL on later access', async () => {
    const fs = new MockFs({ [A]: A1 }) // 初始 A1
    const { service, root } = await makeService(fs)
    await service.record('sess-1', { turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await service.keep('sess-1', A) // 基线 A1
    fs.contents.set(A, A2)
    await service.record('sess-1', { turn: 2, step: 1, path: A, oldText: A1, newText: A2 })

    // 模拟重启:新 service 实例,同一 root
    const ctx2 = new Context()
    const service2 = new StriatumService(ctx2, { root }, fs, mockSessions as never, undefined)
    const st = await service2.state('sess-1')
    expect(st.files).toHaveLength(1)
    // turns 只含「自上次 keep 以来」的 pending 轮次(第 1 轮已 keep)
    expect(st.files[0]).toMatchObject({ path: A, turns: [2], changeCount: 1 })
    // 重建后仍可 undo 到基线 A1
    await service2.undo('sess-1', A)
    expect(fs.contents.get(A)).toBe(A1)
  })

  it('concurrent first touch returns one shared registry (adopt replay ∥ UI state)', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service } = await makeService(fs)
    // adopt 回放与 UI 的 state() 会并发首次触达同一会话:两条路径必须拿到同一实例,
    // 否则后建实例覆盖 map 中先建实例,一方登记的状态另一方读不到。
    const [r1, r2] = await Promise.all([
      service.registryFor('sess-1'),
      service.registryFor('sess-1'),
    ])
    expect(r1).toBe(r2)
    // 经 r1 登记后,服务读数必须看得到(不被覆盖实例吞掉)
    await r1.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    expect((await service.state('sess-1')).files).toHaveLength(1)
  })

  it('recordSeq applies batch with cursor; restart replays only newer seq', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service, root } = await makeService(fs)
    // 一次 result 的多 diff / 对账回放
    await service.recordSeq('sess-1', [
      { turn: 1, step: 1, seq: 8, path: A, oldText: null, newText: A1 },
    ], 8)
    expect((await service.state('sess-1')).files).toHaveLength(1)

    // 模拟崩溃在 seq 8 之后:重启,对账回放 seq 8 + 新 seq 9
    fs.contents.set(A, A2)
    const ctx2 = new Context()
    const service2 = new StriatumService(ctx2, { root }, fs, mockSessions as never, undefined)
    await service2.recordSeq('sess-1', [
      { turn: 1, step: 1, seq: 8, path: A, oldText: null, newText: A1 }, // 已消费 → 跳过
      { turn: 1, step: 2, seq: 9, path: A, oldText: null, newText: A2 }, // 新 → 登记
    ], 9)
    const st = await service2.state('sess-1')
    expect(st.files[0]).toMatchObject({ path: A, changeCount: 2, turns: [1] })
    // 游标已到 9,再次全量回放不再登记
    await service2.recordSeq('sess-1', [
      { turn: 1, step: 1, seq: 8, path: A, oldText: null, newText: A1 },
      { turn: 1, step: 2, seq: 9, path: A, oldText: null, newText: A2 },
    ], 9)
    expect((await service2.state('sess-1')).files[0]!.changeCount).toBe(2)
  })
})

/**
 * dsh-striatum — StriatumService 集成测试(mock fs/sessions,验证 record/keep/undo/state 全链路)。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { StriatumService, type StriatumFsFace } from '../src/index.ts'

/** mock fs:内存文件系统,模拟 resolve/readText/writeText。 */
class MockFs implements StriatumFsFace {
  contents = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.contents.set(p, c)
  }
  async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    // 模拟真实 resolve:相对路径按 cwd 绝对化,并给出 displayPath。
    const displayPath = path.startsWith('/') || opts?.cwd === undefined ? path : `${opts.cwd}/${path}`
    return { targetKey: FsTargetKey(displayPath), displayPath }
  }
  async readText(target: FsTarget): Promise<string> {
    const content = this.contents.get(target.displayPath)
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    const operation = this.contents.has(target.displayPath) ? 'update' : 'create'
    this.contents.set(target.displayPath, content)
    return { operation, version: 'v1', before: null, after: content } as FsWriteOutcome
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

/** 同 makeService,但把 ctx 一并交回 —— 供断言事件广播的用例使用。 */
async function makeServiceWithCtx(fs: MockFs): Promise<{ service: StriatumService; ctx: Context }> {
  const root = await mkdtemp(join(tmpdir(), 'striatum-test-'))
  roots.push(root)
  const ctx = new Context()
  const service = new StriatumService(ctx, { root }, fs, mockSessions as never, undefined)
  return { service, ctx }
}

/**
 * 让 `sessions.get` 像生产环境那样**只返回 live 会话**,并给非 live 会话提供
 * 持久化 header。GUI 里查看历史会话时会话并不 live —— 这正是相对路径失效的
 * 真实场景(只看 sessions.get 会拿到 undefined,路径无法绝对化)。
 *
 * sessionPersistence 经 `ctx.get` 惰性读取(生产代码如此),所以这里提供到
 * Context 上,而不是作为构造参数传入。
 */
async function makeServiceForStoredSession(
  fs: MockFs, liveIds: readonly string[], storedCwd: string,
): Promise<{ service: StriatumService }> {
  const root = await mkdtemp(join(tmpdir(), 'striatum-test-'))
  roots.push(root)
  const ctx = new Context()
  const sessions = { get: (id: string) => (liveIds.includes(id) ? { header: { cwd: `/live/${id}` } } : undefined) }
  const persistence = { stat: async () => ({ header: { cwd: storedCwd } }) }
  ;(ctx as unknown as { get: (name: string) => unknown }).get = (name: string) =>
    name === 'sessionPersistence' ? persistence : undefined
  const service = new StriatumService(ctx, { root }, fs, sessions as never, undefined)
  return { service }
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

  it('reaches changes/undo through the relative path the file preview passes', async () => {
    // 预览器的路径来自资源地址的 path 段,**相对会话 cwd**;registry 登记的却是
    // 绝对路径。normalizePath 不做绝对化时三者会一起坏:changes 看似无改动、
    // undo 报 no-pending、keep 静默"成功"却什么也没做。
    const abs = '/work/sess-1/rel.go'
    const rel = 'rel.go'
    const fs = new MockFs({ [abs]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })

    const view = await service.changes('sess-1', rel)
    expect(view.tracked).toBe(true)
    expect(view.hunks.length).toBeGreaterThan(0)

    // undo 必须真的把基线写回磁盘
    await service.undo('sess-1', rel)
    expect(fs.contents.get(abs)).toBe(A0)
  })

  it('keep through a relative path advances the baseline instead of doing nothing', async () => {
    const abs = '/work/sess-1/rel2.go'
    const rel = 'rel2.go'
    const fs = new MockFs({ [abs]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })

    // keep 查不到条目时会返回 ok:true + reason:'no-pending' —— 静默失败。
    // 因此这里同时断言"报告了路径"和"改动确实消失"。
    const r = await service.keep('sess-1', rel)
    expect(r.paths).toContain(rel)
    expect((await service.changes('sess-1', rel)).hunks).toHaveLength(0)
  })

  it('acceptHunk and revertHunk also work through a relative path', async () => {
    const abs = '/work/sess-1/rel3.go'
    const rel = 'rel3.go'
    const fs = new MockFs({ [abs]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })

    const before = await service.changes('sess-1', rel)
    expect(before.hunks).toHaveLength(1)

    // 撤销该块 → 文件回到基线的功能体
    await service.revertHunk('sess-1', rel, before.hunks[0]!.index)
    expect(fs.contents.get(abs)).toBe(A0)
  })

  it('undoes a content deletion through a relative path', async () => {
    // 把"相对路径"与"内容删除"两个维度叠在一起 —— 这正是先前两个 bug 的交汇处:
    // 路径没绝对化则查不到条目,删除行没走旧侧则还原不回来。
    const abs = '/work/sess-1/del.go'
    const rel = 'del.go'
    const FULL = 'line1\nline2\nline3\nline4\n'
    const SHRUNK = 'line1\nline2\nline4\n'
    const fs = new MockFs({ [abs]: SHRUNK })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: FULL, newText: SHRUNK, beforeText: FULL,
    })

    const view = await service.changes('sess-1', rel)
    expect(view.hunks[0]!.removed).toBe(1)
    expect(view.hunks[0]!.added).toBe(0)

    await service.undo('sess-1', rel)
    expect(fs.contents.get(abs)).toBe(FULL) // 被删掉的那一行回来了
  })

  it('refuses undo of a deleted file and writes nothing', async () => {
    const abs = '/work/sess-1/gone.go'
    const rel = 'gone.go'
    const fs = new MockFs({ [abs]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })
    // 文件被移走/删掉:没有可写回的目标,undo 必须拒绝而不是写坏别处
    fs.contents.delete(abs)

    await expect(service.undo('sess-1', rel)).rejects.toThrow()
    expect(fs.contents.has(abs)).toBe(false) // 没有被凭空写回
  })

  it('keeps a deleted file through a relative path, accepting the deletion', async () => {
    const abs = '/work/sess-1/gone2.go'
    const rel = 'gone2.go'
    const fs = new MockFs({ [abs]: A1 })
    const { service } = await makeService(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })
    fs.contents.delete(abs)

    const r = await service.keep('sess-1', rel)
    expect(r.ok).toBe(true) // 接受删除,不报失败
    expect((await service.state('sess-1')).files).toHaveLength(0) // 条目已移除
  })

  it('emits fs/observed after an undo write so the preview shell refreshes', async () => {
    // 预览正文由资源层(workspaceFiles)持有,而它的变更帧**只来自 fs/observed**
    // (操作系统不被监听)。若写回不发这个事件,磁盘虽然改了,预览壳收不到通知 ——
    // 界面仍显示旧内容,看起来像"撤销没生效"。
    const fs = new MockFs({ [A]: A1 })
    const { service, ctx } = await makeServiceWithCtx(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: A, oldText: null, newText: '', beforeText: A0,
    })

    const observed: Array<{ target: unknown, observation: unknown }> = []
    ctx.on('fs/observed', (target, observation) => { observed.push({ target, observation }) })

    await service.undo('sess-1', A)

    expect(observed).toHaveLength(1)
    expect(observed[0]!.observation).toEqual({ kind: 'present', version: 'v1' })
    expect((observed[0]!.target as { displayPath: string }).displayPath).toBe(A)
  })

  it('emits fs/observed after a revertHunk write', async () => {
    const fs = new MockFs({ [A]: A1 })
    const { service, ctx } = await makeServiceWithCtx(fs)
    await service.record('sess-1', {
      turn: 1, step: 1, path: A, oldText: null, newText: '', beforeText: A0,
    })
    const view = await service.changes('sess-1', A)

    const observed: unknown[] = []
    ctx.on('fs/observed', (_target, observation) => { observed.push(observation) })

    await service.revertHunk('sess-1', A, view.hunks[0]!.index)
    expect(observed).toEqual([{ kind: 'present', version: 'v1' }])
  })

  it('resolves a relative path for a session that is not live (persisted header fallback)', async () => {
    // `sessions.get` 只返回 live 会话;GUI 里看历史会话时它不是 live 的。
    // 只看 sessions.get 会拿到 undefined → 相对路径无法绝对化 → 界面看不到 diff。
    // 官方 workspaceFileScope 因此回退读持久化的 header,这里必须同样回退。
    const cwd = '/work/stored'
    const abs = `${cwd}/rel-live.go`
    const fs = new MockFs({ [abs]: A1 })
    // 该会话**不在** live 列表里
    const { service } = await makeServiceForStoredSession(fs, [], cwd)
    await service.record('sess-1', {
      turn: 1, step: 1, path: abs, oldText: null, newText: '', beforeText: A0,
    })

    // 相对路径必须能查到改动(靠持久化 header 的 cwd 绝对化)
    const view = await service.changes('sess-1', 'rel-live.go')
    expect(view.tracked).toBe(true)
    expect(view.hunks.length).toBeGreaterThan(0)

    // 且 undo 能真的写回
    await service.undo('sess-1', 'rel-live.go')
    expect(fs.contents.get(abs)).toBe(A0)
  })

  it('prefers the live session cwd over the persisted header', async () => {
    // 两级回退的优先级:live 有就用 live,不该被持久化的旧值覆盖。
    // helper 的 live cwd 是 `/live/<id>`。
    const liveCwd = '/live/sess-1'
    const fs = new MockFs({ [`${liveCwd}/live.go`]: A1 })
    const { service } = await makeServiceForStoredSession(fs, ['sess-1'], '/work/stale')
    await service.record('sess-1', {
      turn: 1, step: 1, path: `${liveCwd}/live.go`, oldText: null, newText: '', beforeText: A0,
    })

    const view = await service.changes('sess-1', 'live.go')
    expect(view.tracked).toBe(true)
    expect(view.hunks.length).toBeGreaterThan(0)
  })
})

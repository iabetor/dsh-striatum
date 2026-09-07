/**
 * dsh-striatum — ChangeRegistry 单元测试(文件级 keep/undo 语义,设计 v2 §4.2)。
 */
import { describe, expect, it } from 'vitest'
import {
  ChangeRegistry,
  UndoError,
  emptySessionState,
  hashOf,
  parsePersistedState,
  type FileFacts,
  type FileIo,
} from '../src/host/registry.ts'

/** 内存假文件系统:记录当前内容,模拟 agent 写 / 外部改。 */
class FakeFs implements FileIo {
  contents = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.contents.set(p, c)
  }
  normalizePath(path: string): string {
    return path
  }
  async readFacts(path: string): Promise<FileFacts> {
    const content = this.contents.get(path)
    return content === undefined
      ? { currentContent: null, currentHash: null }
      : { currentContent: content, currentHash: hashOf(content) }
  }
  /** 模拟 agent 改文件(改完才发事件)。 */
  agentWrite(path: string, content: string): void {
    this.contents.set(path, content)
  }
  /** 模拟外部手动改。 */
  externalWrite(path: string, content: string): void {
    this.contents.set(path, content)
  }
}

const A = '/work/a.go'
const B = '/work/b.go'
const A0 = 'package a\n\nfunc A() {}\n'
const A1 = 'package a\n\nfunc A() { return 1 }\n'
const A2 = 'package a\n\nfunc A() int { return 1 }\n'
const B0 = 'package b\n'
const B1 = 'package b\n\nfunc B() {}\n'

function make(fs: FakeFs): ChangeRegistry {
  return new ChangeRegistry('sess-1', fs)
}

describe('hashOf', () => {
  it('is stable and differs across content', () => {
    expect(hashOf('abc')).toBe(hashOf('abc'))
    expect(hashOf('abc')).not.toBe(hashOf('abd'))
  })
})

describe('recordChange', () => {
  it('registers a new file with facts read at event time (after state)', async () => {
    const fs = new FakeFs({ [A]: A1 }) // 事件到达时文件已是 after
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 2, path: A, oldText: A0, newText: A1 })
    expect(r.hasPending(A)).toBe(true)
    const views = await r.fileViews()
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      path: A, firstPendingTurn: 1, lastPendingTurn: 1, turns: [1], changeCount: 1,
    })
    expect(views[0]!.hashMatches).toBe(true)
    expect(r.displayRecords()).toHaveLength(1)
  })

  it('merges multi-turn changes on the same file into one unit', async () => {
    const fs = new FakeFs({ [A]: A2 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    fs.agentWrite(A, A2) // 第 2 轮基于第 1 轮结果再改
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    const views = await r.fileViews()
    expect(views).toHaveLength(1) // 仍是一个文件级单元
    expect(views[0]!.turns).toEqual([1, 2])
    expect(views[0]!.firstPendingTurn).toBe(1)
    expect(views[0]!.lastPendingTurn).toBe(2)
    expect(views[0]!.changeCount).toBe(2)
    expect(r.displayRecords()).toHaveLength(2)
  })

  it('skips empty path after normalize', async () => {
    const fs = new FakeFs()
    const io: FileIo = { normalizePath: () => '', readFacts: fs.readFacts.bind(fs) }
    const r = new ChangeRegistry('s', io)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: null, newText: 'x' })
    expect(r.snapshot().files).toEqual({})
    expect(r.hasPending(A)).toBe(false)
  })

  it('tolerates unreadable file at record time', async () => {
    const fs = new FakeFs() // 文件不存在(登记时读不到)
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: null, newText: A1 })
    expect(r.hasPending(A)).toBe(true)
    const views = await r.fileViews()
    expect(views[0]!.hashMatches).toBe(true) // 读不到 → 视为一致(不误报)
  })
})

describe('keep', () => {
  it('keep sets baseline to current content and clears pending (pure metadata)', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    const before = fs.contents.get(A)
    const res = await r.keep(A)
    expect(res.ok).toBe(true)
    expect(fs.contents.get(A)).toBe(before) // 不写文件
    expect(r.hasPending(A)).toBe(false) // 不再待确认
    expect(await r.fileViews()).toHaveLength(0) // 从视图消失
    expect(r.displayRecords()).toHaveLength(0)
    // 但文件条目保留基线(供未来 undo)
    const snap = r.snapshot().files[A]
    expect(snap?.baseline).toBe(A1)
    expect(snap?.baselineHash).toBe(hashOf(A1))
  })

  it('keep then later change: undo returns to the kept baseline', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A) // 基线 A1
    fs.agentWrite(A, A2) // 第 2 轮又改
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    expect(r.hasPending(A)).toBe(true)
    const prep = await r.prepareUndo(A)
    expect(prep.content).toBe(A1) // undo 目标 = 上次 keep 的 A1
    fs.contents.set(A, prep.content)
    r.commitUndoWrite(A)
    expect(fs.contents.get(A)).toBe(A1)
    expect(r.hasPending(A)).toBe(false)
  })

  it('keep with no pending is a no-op success', async () => {
    const fs = new FakeFs()
    const r = make(fs)
    const res = await r.keep(A)
    expect(res.ok).toBe(true)
  })

  it('keep of a deleted file accepts the deletion and drops the entry', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    fs.contents.delete(A) // 文件被删
    const res = await r.keep(A)
    expect(res.ok).toBe(true) // keep = 接受现状(含删除)
    expect(r.hasPending(A)).toBe(false)
    expect(r.snapshot().files[A]).toBeUndefined() // 条目移除,不再跟踪
    expect(await r.fileViews()).toHaveLength(0)
  })

  it('recordChange read failure keeps prior lastKnownHash', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, seq: 10, path: A, oldText: A0, newText: A1 })
    const before = r.snapshot().files[A]!.lastKnownHash
    expect(before).not.toBeNull()
    // 文件被删后,adopt 回放再次登记同一事件 —— 不得抹掉 lastKnownHash
    fs.contents.delete(A)
    await r.recordChanges([{ turn: 1, step: 1, seq: 10, path: A, oldText: A0, newText: A1 }], 10)
    expect(r.snapshot().files[A]!.lastKnownHash).toBe(before)
  })

  it('keepAll keeps every pending file', async () => {
    const fs = new FakeFs({ [A]: A1, [B]: B1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.recordChange({ turn: 1, step: 2, path: B, oldText: B0, newText: B1 })
    const res = await r.keepAll()
    expect(res.ok).toBe(true)
    expect(res.kept.sort()).toEqual([A, B].sort())
    expect(await r.fileViews()).toHaveLength(0)
  })
})

describe('undo', () => {
  it('refuses undo with no baseline (never kept)', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await expect(r.prepareUndo(A)).rejects.toMatchObject({ code: 'no-baseline' })
    const can = await r.canUndo(A)
    expect(can.ok).toBe(false)
    expect(can.reason).toBe('no-baseline')
  })

  it('refuses undo when file modified externally (hash mismatch)', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A)
    fs.agentWrite(A, A2)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    fs.externalWrite(A, 'package a\n\n// hacked by human\n') // 外部修改
    await expect(r.prepareUndo(A)).rejects.toMatchObject({ code: 'hash-mismatch' })
    const can = await r.canUndo(A)
    expect(can.ok).toBe(false)
    expect(can.reason).toBe('hash-mismatch')
  })

  it('undo of a file with no pending throws no-pending', async () => {
    const fs = new FakeFs()
    const r = make(fs)
    await expect(r.prepareUndo(A)).rejects.toMatchObject({ code: 'no-pending' })
  })

  it('undo of a kept file (no pending) throws no-pending', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A)
    await expect(r.prepareUndo(A)).rejects.toMatchObject({ code: 'no-pending' })
  })
})

describe('persistence round-trip', () => {
  it('serializes and reparses state losslessly; rebuilt registry can undo', async () => {
    const fs = new FakeFs({ [A]: A1 }) // 初始 A1
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A) // 基线 A1
    fs.agentWrite(A, A2)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    const snap = r.snapshot()
    const parsed = parsePersistedState(JSON.parse(JSON.stringify(snap)))
    expect(parsed).toBeDefined()
    expect(parsed!.sessionId).toBe('sess-1')
    expect(parsed!.files[A]).toEqual(snap.files[A])
    expect(parsed!.records).toEqual(snap.records)
    // 重建后仍能 undo 到基线
    const r2 = new ChangeRegistry('sess-1', fs, parsed)
    const prep = await r2.prepareUndo(A)
    expect(prep.content).toBe(A1)
  })

  it('rejects malformed state', () => {
    expect(parsePersistedState(null)).toBeUndefined()
    expect(parsePersistedState({ version: 2 })).toBeUndefined()
    expect(parsePersistedState({ version: 1, sessionId: 's', files: 'x', records: [] })).toBeUndefined()
  })

  it('registry ignores initial state with mismatched sessionId', () => {
    const fs = new FakeFs()
    const st = emptySessionState('other')
    const r = new ChangeRegistry('sess-1', fs, st)
    expect(r.snapshot().sessionId).toBe('sess-1')
    expect(r.snapshot().files).toEqual({})
  })
})

describe('seq cursor & idempotent replay', () => {
  it('recordChanges with seq advances lastSeq', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChanges([{ turn: 1, step: 1, seq: 10, path: A, oldText: null, newText: A1 }], 10)
    expect(r.snapshot().lastSeq).toBe(10)
    expect(r.hasPending(A)).toBe(true)
  })

  it('replaying an already-consumed seq is a no-op (idempotent)', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChanges([{ turn: 1, step: 1, seq: 10, path: A, oldText: null, newText: A1 }], 10)
    // 重启后对账重放同样的 seq(或更早)——不得重复登记
    await r.recordChanges([{ turn: 1, step: 1, seq: 10, path: A, oldText: null, newText: A1 }], 10)
    await r.recordChanges([{ turn: 1, step: 1, seq: 5, path: A, oldText: null, newText: A1 }], 5)
    expect(r.snapshot().files[A]!.changeCount).toBe(1)
    expect(r.snapshot().records).toHaveLength(1)
    expect(r.snapshot().lastSeq).toBe(10)
  })

  it('replay after cursor applies only newer events', async () => {
    const fs = new FakeFs({ [A]: A2 })
    const r = make(fs)
    await r.recordChanges([{ turn: 1, step: 1, seq: 10, path: A, oldText: null, newText: A1 }], 10)
    // 重启后日志新增 seq 12(第 2 轮改 A2)
    fs.agentWrite(A, A2)
    await r.recordChanges([{ turn: 2, step: 1, seq: 12, path: A, oldText: null, newText: A2 }], 12)
    expect(r.snapshot().files[A]!.changeCount).toBe(2)
    expect(r.snapshot().files[A]!.turns).toEqual([1, 2])
    expect(r.snapshot().lastSeq).toBe(12)
  })

  it('empty replay (no diffs) still advances the cursor', async () => {
    const fs = new FakeFs()
    const r = make(fs)
    await r.recordChanges([], 20)
    expect(r.snapshot().lastSeq).toBe(20)
    expect(r.snapshot().files).toEqual({})
  })
})

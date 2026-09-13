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
import { hunkRows, oldSideLines } from '../src/client/segments.ts'

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

describe('changesFor (文件预览的改动视图)', () => {
  it('shows a diff on the very first change when beforeText is available', async () => {
    // 关键行为:改动过就有 diff,不必先 Keep。
    // beforeText 由 tools/execute 包装器从工具返回值取得(改动前全文)。
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({
      turn: 1, step: 1, path: A, oldText: A0, newText: A1, beforeText: A0,
    })
    const view = (await r.changesFor(A))!
    expect(view.tracked).toBe(true)
    expect(view.hasBaseline).toBe(true) // 基线来自 beforeText
    expect(view.hunks.length).toBeGreaterThan(0) // 首次改动即可见 diff
    expect(view.canUndo).toBe(true)
  })

  it('falls back to keep-first when beforeText is unavailable', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    // 没有 beforeText(例如改动发生在插件加载前)→ 退回旧行为
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    const before = (await r.changesFor(A))!
    expect(before.hasBaseline).toBe(false)
    expect(before.created).toBe(false)
    expect(before.hunks).toEqual([])
    expect(before.canUndo).toBe(false)

    await r.keep(A) // 以当前内容(A1)为基线
    fs.agentWrite(A, A2) // agent 再改一次
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })

    const after = (await r.changesFor(A))!
    expect(after.hasBaseline).toBe(true)
    expect(after.canUndo).toBe(true)
    expect(after.hunks.length).toBeGreaterThan(0)
    expect(after.tracked).toBe(true)
  })

  it('never lets a later beforeText roll back an established baseline', async () => {
    // 第二次改动的 beforeText 是"上一次改后"的内容,不该覆盖已推进的基线。
    const fs = new FakeFs({ [A]: A2 })
    const r = make(fs)
    await r.recordChange({
      turn: 1, step: 1, path: A, oldText: A0, newText: A1, beforeText: A0,
    })
    await r.keep(A) // 基线推进到 A2(当前内容)
    await r.recordChange({
      turn: 2, step: 1, path: A, oldText: A1, newText: A2, beforeText: A1,
    })
    // 基线仍是 keep 后的 A2,未被 beforeText(A1)回退
    expect(r.snapshot().files[A]!.baseline).toBe(A2)
  })

  it('has no hunks before a baseline exists, then reports them after keep', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    // 首次登记、非新建、无 beforeText → 无基线,无法对比
    const before = (await r.changesFor(A))!
    expect(before.hasBaseline).toBe(false)
    expect(before.created).toBe(false)
    expect(before.hunks).toEqual([])
    expect(before.canUndo).toBe(false)

    await r.keep(A) // 以当前内容(A1)为基线
    fs.agentWrite(A, A2) // agent 再改一次
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })

    const after = (await r.changesFor(A))!
    expect(after.hasBaseline).toBe(true)
    expect(after.canUndo).toBe(true)
    expect(after.hunks.length).toBeGreaterThan(0)
    expect(after.tracked).toBe(true)
  })

  it('reports hunk positions that land inside the file the shell renders', async () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const cur = base.replace('line 3\n', 'line 3 CHANGED\n').replace('line 18\n', 'line 18 CHANGED\n')
    const fs = new FakeFs({ [A]: base })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: base, newText: cur })
    await r.keep(A)
    fs.agentWrite(A, cur)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: base, newText: cur })

    const view = (await r.changesFor(A))!
    // 正文由预览壳提供;hunk 的 newStart 必须落在当前文件范围内,叠加才不错位。
    const lineCount = cur.split('\n').length
    for (const h of view.hunks) {
      expect(h.newStart).toBeGreaterThanOrEqual(1)
      expect(h.newStart - 1 + h.newLines).toBeLessThanOrEqual(lineCount)
    }
  })

  it('treats a created file as an empty baseline (whole file is an addition)', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: null, newText: '', created: true })
    const view = (await r.changesFor(A))!
    expect(view.created).toBe(true)
    expect(view.hunks).toHaveLength(1)
    expect(view.hunks[0]!.removed).toBe(0)
    expect(view.hunks[0]!.added).toBeGreaterThan(0)
  })

  it('reports no hunks (rather than fabricating them) when the file is unreadable', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A)
    fs.agentWrite(A, A2)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    fs.contents.delete(A) // 文件被删/移走
    const view = (await r.changesFor(A))!
    // 正文由预览壳负责;这里只保证不生成假的 hunk。
    expect(view.hunks).toEqual([])
    expect(view.tracked).toBe(true)
  })
})

describe('acceptHunk / prepareRevertHunk (块级闸门)', () => {
  /** 20 行文件,第 3 与第 18 行各改一处(相隔远 → 两块)。 */
  const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const CHANGED = LINES.replace('line 3\n', 'line 3 CHANGED\n').replace('line 18\n', 'line 18 CHANGED\n')

  /** 建立"有基线 + 两块待决"的状态。 */
  async function withPending(fs: FakeFs, r: ReturnType<typeof make>): Promise<void> {
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: LINES, newText: CHANGED })
    await r.keep(A) // 基线 = LINES
    fs.agentWrite(A, CHANGED)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: LINES, newText: CHANGED })
  }

  it('accepts one hunk, leaving the rest pending', async () => {
    const fs = new FakeFs({ [A]: LINES })
    const r = make(fs)
    await withPending(fs, r)

    expect((await r.changesFor(A))!.hunks).toHaveLength(2)
    expect(await r.acceptHunk(A, 0)).toBe(true)
    // 接受一块后仍有一块待决 → 条目保留
    expect((await r.changesFor(A))!.hunks).toHaveLength(1)
    expect(r.hasPending(A)).toBe(true)
  })

  it('clears pending once every hunk is accepted, keeping the baseline for future undo', async () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n'
    const cur = base.replace('b\n', 'B\n')
    const fs = new FakeFs({ [A]: base })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: base, newText: cur })
    await r.keep(A)
    fs.agentWrite(A, cur)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: base, newText: cur })

    expect(await r.acceptHunk(A, 0)).toBe(true)
    // 全部接受 → pending 清空(与文件级 keep 同语义);条目保留,基线供未来 undo
    expect(r.hasPending(A)).toBe(false)
    expect(await r.fileViews()).toHaveLength(0)
    const view = (await r.changesFor(A))!
    expect(view.hasBaseline).toBe(true)
    expect(view.hunks).toEqual([]) // 无 pending → 无待决块
  })

  it('reverting a hunk yields content that restores only that hunk', async () => {
    const fs = new FakeFs({ [A]: LINES })
    const r = make(fs)
    await withPending(fs, r)

    const prep = await r.prepareRevertHunk(A, 0)
    const out = prep.content.split('\n')
    expect(out[2]).toBe('line 3') // 第 3 行复原
    expect(out[17]).toBe('line 18 CHANGED') // 第 18 行保留
  })

  it('rejects an out-of-range hunk index', async () => {
    const fs = new FakeFs({ [A]: LINES })
    const r = make(fs)
    await withPending(fs, r)
    expect(await r.acceptHunk(A, 9)).toBe(false)
    await expect(r.prepareRevertHunk(A, 9)).rejects.toThrow()
  })
})

/**
 * 删除的两种含义,行为完全不同,必须分开测:
 *  - **内容删除**(删掉文件里的若干行):文件仍在,可以 undo 还原那些行;
 *  - **文件删除**(整个文件被移走/删掉):读不到内容,undo 无法进行,只能 keep
 *    接受既成事实。
 *
 * 这两种是最容易只在其中一侧正确的地方 —— 尤其"删除行的高亮"要取旧侧片段,
 * 行号映射错一位就会让红底行显示成别的内容。
 */
describe('内容删除(del 行)', () => {
  /** 5 行文件,删掉第 3 行 → 纯删除(无新增)。 */
  const FULL = 'line1\nline2\nline3\nline4\nline5\n'
  const SHRUNK = 'line1\nline2\nline4\nline5\n'

  /** 记录一次"删掉第 3 行"的改动(事件到达时磁盘已是 after)。 */
  async function withDeletion(fs: FakeFs, r: ChangeRegistry): Promise<void> {
    fs.agentWrite(A, SHRUNK)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: FULL, newText: SHRUNK, beforeText: FULL })
  }

  it('reports the deletion as a del-only hunk', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    const view = (await r.changesFor(A))!
    expect(view.hunks).toHaveLength(1)
    expect(view.hunks[0]!.removed).toBe(1)
    expect(view.hunks[0]!.added).toBe(0)
    expect(view.hunks[0]!.lines.filter(l => l.kind === 'del').map(l => l.text)).toEqual(['line3'])
  })

  it('undo restores the deleted line', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    expect(await r.canUndo(A)).toEqual({ ok: true })
    expect((await r.prepareUndo(A)).content).toBe(FULL)
  })

  it('revertHunk restores the deleted line', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    expect((await r.prepareRevertHunk(A, 0)).content).toBe(FULL)
  })

  it('acceptHunk advances the baseline, so the deletion stops being pending', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    expect(await r.acceptHunk(A, 0)).toBe(true)
    expect((await r.changesFor(A))!.hunks).toHaveLength(0)
    // 基线已前移到删除后的内容:改动不再是 pending,也就没有可撤销的对象。
    expect(r.hasPending(A)).toBe(false)
    await expect(r.prepareUndo(A)).rejects.toMatchObject({ code: 'no-pending' })
  })

  it('maps every deleted line to its own old-side index (highlight取旧侧)', async () => {
    // 删除行在当前文件里不存在,高亮要取"旧侧片段";旧侧下标把 context 也算进去,
    // 否则红底行会取到上下文行的 token —— 颜色看着有,内容却是别的行。
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    const hunk = (await r.changesFor(A))!.hunks[0]!
    const old = oldSideLines(hunk)
    for (const row of hunkRows(hunk, hunk.newStart)) {
      if (row.kind !== 'del') continue
      expect(old[row.oldIndex!]).toBe(row.text)
    }
    expect(hunkRows(hunk, hunk.newStart).filter(r2 => r2.kind === 'del').map(r2 => r2.oldIndex)).toEqual([2])
  })

  it('handles deleting the entire file content (every line removed)', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    fs.agentWrite(A, '')
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: FULL, newText: '', beforeText: FULL })
    const view = (await r.changesFor(A))!
    expect(view.created).toBe(false) // 内容清空 ≠ 新建
    expect(view.hunks[0]!.removed).toBe(5)
    expect(view.hunks[0]!.added).toBe(0)
    // 全部行都是删除行 → 无新侧行号,且旧侧下标 0..4 逐个对齐
    const hunk = view.hunks[0]!
    const rows = hunkRows(hunk, hunk.newStart)
    expect(rows.every(row => row.newLineNo === null)).toBe(true)
    expect(rows.map(row => row.oldIndex)).toEqual([0, 1, 2, 3, 4])
    expect((await r.prepareUndo(A)).content).toBe(FULL)
  })

  it('keeps a deletion pending until it is explicitly accepted', async () => {
    const fs = new FakeFs({ [A]: FULL })
    const r = make(fs)
    await withDeletion(fs, r)
    expect(r.hasPending(A)).toBe(true)
    expect((await r.fileViews())[0]!.changeCount).toBe(1)
  })
})

/**
 * 文件被删除(不在磁盘上)时的行为。此处 undo 天然不可行 —— 没有可写回的目标,
 * 也没有"当前内容"可校验;唯一合理的出口是 keep = 接受删除并停止跟踪。
 */
describe('文件删除(磁盘上已不存在)', () => {
  /** 建立基线 → 再改一次 → 然后删掉文件。 */
  async function withMissingFile(fs: FakeFs, r: ChangeRegistry): Promise<void> {
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A)
    fs.agentWrite(A, A2)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: A1, newText: A2 })
    fs.contents.delete(A)
  }

  it('does not fabricate hunks, but still reports the file as tracked', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await withMissingFile(fs, r)
    const view = (await r.changesFor(A))!
    expect(view.tracked).toBe(true)
    expect(view.hunks).toEqual([])
  })

  it('refuses undo with file-unreadable rather than writing a stale baseline', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await withMissingFile(fs, r)
    expect(await r.canUndo(A)).toEqual({ ok: false, reason: 'file-unreadable' })
    await expect(r.prepareUndo(A)).rejects.toThrow(UndoError)
  })

  it('keep accepts the deletion and drops the entry', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await withMissingFile(fs, r)
    expect((await r.keep(A)).ok).toBe(true)
    expect(r.hasPending(A)).toBe(false)
    expect(r.snapshot().files[A]).toBeUndefined()
  })

  it('keepAll treats a missing file as accepted, not failed', async () => {
    const fs = new FakeFs({ [A]: A1, [B]: B1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.recordChange({ turn: 1, step: 1, path: B, oldText: B0, newText: B1 })
    fs.contents.delete(A) // 只删 A
    const all = await r.keepAll()
    expect(all.ok).toBe(true)
    expect(all.failed).toEqual([])
    expect(all.kept).toContain(A)
    expect(all.kept).toContain(B)
    expect(await r.fileViews()).toHaveLength(0)
  })

  it('a never-kept created file that is then deleted cannot be undone', async () => {
    // 新建文件没有基线(内容为空是"新建"推断,不是可写回的旧内容)。
    const fs = new FakeFs()
    const r = make(fs)
    fs.agentWrite(A, A1)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: null, newText: '', created: true })
    fs.contents.delete(A)
    const view = (await r.changesFor(A))!
    expect(view.created).toBe(true)
    expect(view.hunks).toEqual([])
    expect(await r.canUndo(A)).toEqual({ ok: false, reason: 'no-baseline' })
  })

  it('a deleted-then-recreated file diffs against the kept baseline', async () => {
    const fs = new FakeFs({ [A]: A1 })
    const r = make(fs)
    await r.recordChange({ turn: 1, step: 1, path: A, oldText: A0, newText: A1 })
    await r.keep(A)
    fs.contents.delete(A)
    // 文件又出现,内容与基线不同 → 仍以 keep 的基线做对比
    fs.agentWrite(A, A2)
    await r.recordChange({ turn: 2, step: 1, path: A, oldText: null, newText: '', created: true })
    const view = (await r.changesFor(A))!
    expect(view.hasBaseline).toBe(true)
    expect(view.hunks).toHaveLength(1)
    expect(view.hunks[0]!.added).toBe(1)
    expect(view.hunks[0]!.removed).toBe(1)
  })
})

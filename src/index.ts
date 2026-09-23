/**
 * dsh-striatum — host plugin entry(M2:capture + store + api + undo 写回)。
 *
 * 提供 `ctx.striatum` 服务(实现 StriatumServiceFace):
 *  - 按会话维护 ChangeRegistry,经 store 持久化(~/.dsh/striatum/<sessionId>.jsonl);
 *  - record/keep/undo/state 统一入口,变更后持久化 + SSE 广播;
 *  - undo 经 ctx.fs 原子写回(会话 cwd 内,受沙箱约束);
 *  - 监听 session/event(capture)自动登记改动;
 *  - /striatum/api/* + /striatum/events(web profile 有 webServer 时)。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
// 类型专用导入(被擦除,不触发 client bundle 纯度门禁):把 `fs/observed` 事件与
// FsTarget/FsWriteOutcome 的声明引入本文件的类型空间。
import type { FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { FileChangesView, StriatumState } from './shared/wire.ts'
import { ChangeRegistry, hashOf, untrackedChangesView, type ChangeInput, type FileIo } from './host/registry.ts'
import { displayPathOf } from './host/paths.ts'
import { readSessionState, safeSessionId, writeSessionState, storageRoot } from './host/store.ts'
import { registerCapture } from './host/capture.ts'
import { registerStriatumApi, type SseClients } from './host/api.ts'
import type { StriatumServiceFace, KeepResult } from './host/contract.ts'

/** 结构面:fs 服务(与 agent 工具同一条沙箱链)。 */
export interface StriatumFsFace {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(
    target: FsTarget,
    content: string,
    intent?: unknown,
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<FsWriteOutcome>
}

/** 结构面:sessions 服务(拿会话 cwd)。 */
export interface SessionsFace {
  get(id: string): { header?: { cwd?: string }; id?: string } | undefined
}

/**
 * 结构面:sessionPersistence 服务。
 *
 * `sessions.get(id)` **只返回 live 会话**(见 dsh-session 的 `get` 文档)。GUI 里
 * 打开一个历史会话时该会话并不 live,于是拿不到 header.cwd,相对路径就永远
 * 无法绝对化。官方 `workspaceFiles` 因此有第二级回退:live 拿不到就读持久化
 * 的 header(`api/workspace-files` 的 `workspaceFileScope` resolve)。这里照做。
 */
export interface SessionPersistenceFace {
  stat(id: string): Promise<{ header?: { cwd?: string } } | undefined>
}

/** 结构面:sandboxPolicy 服务(undo 写回时按会话解析 workspace-write policy)。 */
export interface SandboxPolicyFace {
  resolve(request?: { session?: unknown; mode?: string }): { mode: string; workspaceRoot: string; sessionId?: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    striatum: StriatumService
  }
}

/** 真实 FileIo:经 ctx.fs 读文件。 */
function makeFileIo(fs: StriatumFsFace, cwd: string | undefined): FileIo {
  return {
    /**
     * 把路径对齐到 registry 登记时用的形态(绝对路径)。
     *
     * 登记侧来自 fs 工具的绝对路径,而**文件预览器**传的是相对会话工作区根的
     * 路径(如 `dsh-turn-probe/a.md`)。两者不齐则查表落空 —— `undo` 报
     * `no-pending`、`keep` 更是静默返回成功却不做任何事。这里按会话 cwd 补全,
     * 是所有按路径查表的方法的共同入口,修一处即全部生效。
     * @param path - 绝对或相对路径。
     * @returns 绝对化后的路径;无 cwd 可用时原样返回。
     */
    normalizePath(path: string): string {
      if (path.startsWith('/') || cwd === undefined || cwd === '') return path
      const base = cwd.replace(/\/+$/, '')
      return `${base}/${path.replace(/^\.?\/+/, '')}`
    },
    async readFacts(path: string) {
      try {
        const target = await fs.resolve(path, { cwd: cwd ?? process.cwd() })
        const content = await fs.readText(target)
        return { currentContent: content, currentHash: hashOf(content) }
      } catch {
        return { currentContent: null, currentHash: null }
      }
    },
    /**
     * 短路径渲染(规则见 {@link displayPathOf})。**只用于显示** —— keep/undo/diff
     * 仍传绝对路径,那个才是 registry 的查表键。
     * @param path - 绝对路径。
     * @returns 给人看的短路径。
     */
    displayPath(path: string): string {
      return displayPathOf(path, cwd)
    },
  }
}

/** 会话 → registry 的持有者。fs/sessions 经构造注入(避免 Service 内访问未声明 ctx 服务)。 */
export class StriatumService extends Service implements StriatumServiceFace {
  static provide = 'striatum'

  private readonly registries = new Map<string, ChangeRegistry>()
  /**
   * 首次构造中的 registry 承诺(每会话一条)。adopt 回放与 UI 的 state() 会并发
   * 首次触达同一会话;两条路径都走 registryFor,若各自 await 后各建一个实例,
   * 后写入 map 的会覆盖先前的,导致一方登记的状态被另一方读不到。
   */
  private readonly pendingRegistries = new Map<string, Promise<ChangeRegistry>>()
  private readonly sseClients = new Set<ServerResponse>()

  constructor(
    ctx: Context,
    private readonly config: { root: string },
    private readonly fs: StriatumFsFace,
    private readonly sessions: SessionsFace | undefined,
    private readonly sandboxPolicy: SandboxPolicyFace | undefined,
  ) {
    super(ctx, 'striatum')
  }

  /** SSE 客户端管理。 */
  readonly sse: SseClients = {
    add: (client) => {
      this.sseClients.add(client)
      return () => { this.sseClients.delete(client) }
    },
    broadcast: (data) => {
      const body = `data: ${JSON.stringify(data)}\n\n`
      for (const client of this.sseClients) {
        try { client.write(body) } catch { this.sseClients.delete(client) }
      }
    },
  }

  /**
   * 取会话的工作区根(cwd),用于把预览器给的相对路径绝对化。
   *
   * 两级回退,与官方 `workspaceFileScope` 一致:
   *  1. **live 会话**——正在跑 agent 的会话;
   *  2. **持久化的 header**——`sessions.get` 只返回 live 会话,而 GUI 里查看
   *     历史会话(没有 agent 在跑)时它并不是 live 的。只看第 1 级会拿到
   *     undefined,相对路径便永远无法绝对化(表现为"看不到 diff")。
   *
   * 第二级经 `ctx.get` **惰性**读取:sessionPersistence 不在本插件的 inject
   * 列表里(可选服务,加载顺序不定),裸属性读取会抛
   * `cannot get property "…" without inject` 并让插件整体加载失败。
   * @param sessionId - 会话 id。
   * @returns 工作区根;两级都拿不到时 undefined。
   */
  private async cwdOf(sessionId: string): Promise<string | undefined> {
    const live = this.sessions?.get(sessionId)?.header?.cwd
    if (live !== undefined) return live
    const persistence = (this.ctx as unknown as {
      get(name: string): unknown
    }).get('sessionPersistence') as SessionPersistenceFace | undefined
    const stored = await persistence?.stat(sessionId).catch(() => undefined)
    return stored?.header?.cwd
  }

  /**
   * 同上,但用同步可见的 live cwd 兜底一个非空值。
   *
   * 写文件必须有个 cwd(相对路径要按它解析),而 `fs.resolve` 在传绝对路径时
   * 并不真正使用 cwd —— 因此这里用进程 cwd 作为最后兜底即可。
   * @param sessionId - 会话 id。
   * @returns 会话工作区根,或持久化/进程 cwd 兜底。
   */
  private async cwdOrProcess(sessionId: string): Promise<string> {
    return await this.cwdOf(sessionId) ?? process.cwd()
  }

  private async persist(sessionId: string, registry: ChangeRegistry): Promise<void> {
    await writeSessionState(this.config.root, registry.snapshot())
  }

  /**
   * 取某会话 registry(首次从 store 重建,惰性)。
   * 并发首次触达(adopt 回放 ∥ UI state())共享同一次构造,返回同一实例。
   */
  async registryFor(sessionId: string): Promise<ChangeRegistry> {
    const existing = this.registries.get(sessionId)
    if (existing !== undefined) return existing
    const inFlight = this.pendingRegistries.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const creating = this.createRegistry(sessionId)
    this.pendingRegistries.set(sessionId, creating)
    try {
      return await creating
    } finally {
      this.pendingRegistries.delete(sessionId)
    }
  }

  /** 构造并登记一个会话 registry(仅经 registryFor 调用,保证每会话一次)。 */
  private async createRegistry(sessionId: string): Promise<ChangeRegistry> {
    const cwd = await this.cwdOf(sessionId)
    const io = makeFileIo(this.fs, cwd)
    const stored = await readSessionState(this.config.root, safeSessionId(sessionId))
    const registry = new ChangeRegistry(sessionId, io, stored)
    this.registries.set(sessionId, registry)
    return registry
  }

  /** 登记一次改动(捕获层调用)。 */
  async record(sessionId: string, input: ChangeInput): Promise<void> {
    const registry = await this.registryFor(sessionId)
    await registry.recordChange(input)
    await this.persist(sessionId, registry)
    this.sse.broadcast({ kind: 'registered', sessionId })
  }

  /** 批量登记 + 推进 seq 游标(对账回放 / 一次 result 多 diff)。 */
  async recordSeq(sessionId: string, inputs: readonly ChangeInput[], seq: number): Promise<void> {
    const registry = await this.registryFor(sessionId)
    if (inputs.length === 0) {
      // 无改动也推进游标:避免已消费事件在重启后被重复对账。
      registry.advanceSeq(seq)
      // 但从未登记过的会话(纯读/bash)不落盘 —— 避免为无关会话建空 JSONL。
      const snap = registry.snapshot()
      if (Object.keys(snap.files).length > 0 || snap.records.length > 0) {
        await this.persist(sessionId, registry)
      }
      return
    }
    await registry.recordChanges(inputs, seq)
    await this.persist(sessionId, registry)
    this.sse.broadcast({ kind: 'registered', sessionId })
  }

  /** Keep 单文件或全部。 */
  async keep(sessionId: string, path?: string): Promise<KeepResult> {
    const registry = await this.registryFor(sessionId)
    if (path !== undefined) {
      const r = await registry.keep(path)
      await this.persist(sessionId, registry)
      const paths = r.ok && r.reason !== 'no-pending' ? [path] : []
      const failed = !r.ok ? [{ path, reason: r.reason ?? 'unknown' }] : []
      return { ok: failed.length === 0, paths, failed }
    }
    const all = await registry.keepAll()
    await this.persist(sessionId, registry)
    return { ok: all.ok, paths: all.kept, failed: all.failed }
  }

  /** Undo 单文件:校验 → 写回基线 → 状态更新。冲突抛 UndoError。 */
  async undo(sessionId: string, path: string): Promise<void> {
    const registry = await this.registryFor(sessionId)
    const prep = await registry.prepareUndo(path)
    // 用 prep.path(registry 规范化后的绝对路径),与 revertHunk 一致 —— 传原始
    // 相对路径虽然能被 fs.resolve 的 cwd 兜住,却让"谁来规范化"有两套答案。
    await this.writeFile(sessionId, prep.path, prep.content)
    registry.commitUndoWrite(prep.path)
    await this.persist(sessionId, registry)
  }

  /** 当前状态。 */
  async state(sessionId: string): Promise<StriatumState> {
    const registry = await this.registryFor(sessionId)
    const files = await registry.fileViews()
    return { sessionId, files, records: registry.displayRecords() }
  }

  /** 单文件的改动视图(文件预览渲染器用)。未跟踪的文件返回"无改动"。 */
  async changes(sessionId: string, path: string): Promise<FileChangesView> {
    const registry = await this.registryFor(sessionId)
    const view = await registry.changesFor(path)
    if (view !== undefined) return view
    // 未跟踪也要给 display:预览头部显示文件名,规则须与已跟踪的一致。
    return untrackedChangesView(path, displayPathOf(path, await this.cwdOf(sessionId)))
  }

  /**
   * 接受一个改动块:基线前移该块(纯元数据,不写文件)。
   * @param sessionId - 会话。
   * @param path - 文件路径。
   * @param index - 块索引。
   * @returns 是否成功。
   */
  async acceptHunk(sessionId: string, path: string, index: number): Promise<boolean> {
    const registry = await this.registryFor(sessionId)
    const ok = await registry.acceptHunk(path, index)
    if (ok) {
      await this.persist(sessionId, registry)
      this.sse.broadcast({ kind: 'kept', sessionId, paths: [path], failed: [] })
    }
    return ok
  }

  /** 撤销一个改动块:写回该块的改动前片段。 */
  async revertHunk(sessionId: string, path: string, index: number): Promise<void> {
    const registry = await this.registryFor(sessionId)
    const prep = await registry.prepareRevertHunk(path, index)
    await this.writeFile(sessionId, prep.path, prep.content)
    registry.commitRevertHunk(path, prep.content)
    await this.persist(sessionId, registry)
    this.sse.broadcast({ kind: 'undone', sessionId, path })
  }

  /**
   * 经 ctx.fs 原子写回,并广播一次 `fs/observed`。
   *
   * 必须带按会话解析的 sandbox policy(workspace-write,workspaceRoot = 会话 cwd),
   * 否则沙箱后端按默认模式(可能 read-only)拒绝。
   *
   * **必须发 `fs/observed`**:文件预览的正文由资源层(workspaceFiles)持有,而
   * 它的变更帧**只来自 `fs/observed` 事件**(操作系统并不被监听)。官方 write 工具
   * 写完就发这个事件(`tool-fs/write.ts`);striatum 若只写不发,磁盘虽然改了,
   * 预览壳却收不到"内容已变"的通知 —— 表现为撤销后**界面仍显示旧内容**,
   * 看起来像撤销没生效。这里的 observation 形状与官方一致(target + version)。
   */
  private async writeFile(sessionId: string, path: string, content: string): Promise<void> {
    const cwd = await this.cwdOrProcess(sessionId)
    const target = await this.fs.resolve(path, { cwd })
    let policy: unknown
    if (this.sandboxPolicy !== undefined) {
      const session = this.sessions?.get(sessionId)
      policy = this.sandboxPolicy.resolve({ session })
    }
    const outcome = await this.fs.writeText(target, content, undefined, undefined, policy)
    // 让资源层把"内容已变"推给浏览器;actor 传 undefined —— 这不是一次 agent
    // 工具调用,只是宿主侧的回滚写。
    this.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, undefined)
  }

  /** 该文件是否可 undo。 */
  async canUndo(sessionId: string, path: string): Promise<{ ok: boolean; reason?: string }> {
    const registry = await this.registryFor(sessionId)
    const r = await registry.canUndo(path)
    return { ok: r.ok, reason: r.reason }
  }

  /** 释放某会话(会话删除时)。 */
  disposeSession(sessionId: string): void {
    this.registries.delete(sessionId)
    this.pendingRegistries.delete(sessionId)
  }
}

/** 插件配置。 */
export interface Config {
  /** 持久化根(默认 ~/.dsh/striatum)。 */
  root?: string
}

/** Stable Cordis plugin name. */
export const name = 'dsh-striatum'

/** Services required before mounting: sessions(会话 cwd)。fs 经条件 inject。 */
export const inject = ['sessions']

export function apply(ctx: Context, config: Config = {}): void {
  const root = storageRoot(config.root)
  // fs/sandboxPolicy 是条件服务(headless 也有;经 inject 拿引用,避免 Service 内访问未声明 ctx 属性)
  ctx.inject(['fs', 'sandboxPolicy'], (fsCtx) => {
    const fs = (fsCtx as unknown as { fs: StriatumFsFace }).fs
    const sandboxPolicy = (fsCtx as unknown as { sandboxPolicy?: SandboxPolicyFace }).sandboxPolicy
    const sessions = (ctx as unknown as { sessions?: SessionsFace }).sessions
    // Service 构造经 static provide 自动注册 ctx.striatum,勿再手动 provide。
    // sessionPersistence 不在这里取:它是**可选**服务,加载顺序不定,捕获一次可能
    // 恒为 undefined;改由 Service 在查询时经 ctx.get 惰性读取。
    const service = new StriatumService(ctx, { root }, fs, sessions, sandboxPolicy)

    // capture:监听会话事件自动登记改动
    registerCapture(ctx, service)

    // HTTP API + SSE(web profile 才有 webServer/webRuntime;headless 无 → 不注册)
    ctx.inject(['webServer', 'webRuntime'], (apiCtx) => {
      registerStriatumApi(apiCtx as never, service, service.sse)
    })
  })
}

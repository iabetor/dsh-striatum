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
import type { StriatumState } from './shared/wire.ts'
import { ChangeRegistry, hashOf, type ChangeInput, type FileIo } from './host/registry.ts'
import { readSessionState, safeSessionId, writeSessionState, storageRoot } from './host/store.ts'
import { registerCapture } from './host/capture.ts'
import { registerStriatumApi, type SseClients } from './host/api.ts'
import type { StriatumServiceFace, KeepResult } from './host/contract.ts'

/** 结构面:fs 服务(与 agent 工具同一条沙箱链)。 */
export interface StriatumFsFace {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ path: string }>
  readText(target: { path: string }, signal?: AbortSignal): Promise<string>
  writeText(
    target: { path: string },
    content: string,
    intent?: unknown,
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<unknown>
}

/** 结构面:sessions 服务(拿会话 cwd)。 */
export interface SessionsFace {
  get(id: string): { header?: { cwd?: string }; id?: string } | undefined
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
    normalizePath(path: string): string {
      return path
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

  private cwdOf(sessionId: string): string | undefined {
    return this.sessions?.get(sessionId)?.header?.cwd
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
    const cwd = this.cwdOf(sessionId)
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
    // 经 ctx.fs 原子写回;必须带按会话解析的 sandbox policy(workspace-write,
    // workspaceRoot = 会话 cwd),否则沙箱后端按默认模式(可能 read-only)拒绝。
    const cwd = this.cwdOf(sessionId) ?? process.cwd()
    const target = await this.fs.resolve(path, { cwd })
    let policy: unknown
    if (this.sandboxPolicy !== undefined) {
      const session = this.sessions?.get(sessionId)
      policy = this.sandboxPolicy.resolve({ session })
    }
    await this.fs.writeText(target, prep.content, undefined, undefined, policy)
    registry.commitUndoWrite(path)
    await this.persist(sessionId, registry)
  }

  /** 当前状态。 */
  async state(sessionId: string): Promise<StriatumState> {
    const registry = await this.registryFor(sessionId)
    const files = await registry.fileViews()
    return { sessionId, files, records: registry.displayRecords() }
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
    const service = new StriatumService(ctx, { root }, fs, sessions, sandboxPolicy)

    // capture:监听会话事件自动登记改动
    registerCapture(ctx, service)

    // HTTP API + SSE(web profile 才有 webServer/webRuntime;headless 无 → 不注册)
    ctx.inject(['webServer', 'webRuntime'], (apiCtx) => {
      registerStriatumApi(apiCtx as never, service, service.sse)
    })
  })
}

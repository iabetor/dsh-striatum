/**
 * dsh-striatum — host JSON API + SSE。
 *
 * JSON API: /striatum/api/<method> (state / keep / undo)
 * SSE:      /striatum/events(登记/keep/undo 后广播)
 * 信任篱笆:loopback + webRuntime.trustedHosts(参照 dsh-thalamus)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { StriatumServiceFace } from './contract.ts'

/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20

/** One API failure with its wire code and HTTP status. */
export class StriatumApiError extends Error {
  constructor(
    readonly code: 'bad-request' | 'not-found' | 'forbidden' | 'conflict' | 'no-baseline' | 'no-pending' | 'internal',
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Read and parse the JSON request body (bounded). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new StriatumApiError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new StriatumApiError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Write a success envelope. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, value)
}

/** Map a thrown error to an HTTP response. */
export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof StriatumApiError) {
    writeJson(res, error.status, { ok: false, code: error.code, message: error.message })
    return
  }
  // registry UndoError → HTTP 映射
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const e = error as { code: string; message?: string; path?: string }
    if (e.code === 'hash-mismatch') {
      writeJson(res, 409, { ok: false, code: 'conflict', message: e.message ?? 'file changed externally', path: e.path })
      return
    }
    if (e.code === 'no-baseline') {
      writeJson(res, 400, { ok: false, code: 'no-baseline', message: e.message ?? 'no baseline', path: e.path })
      return
    }
    if (e.code === 'no-pending') {
      writeJson(res, 400, { ok: false, code: 'no-pending', message: e.message ?? 'no pending change', path: e.path })
      return
    }
    if (e.code === 'file-unreadable') {
      writeJson(res, 400, { ok: false, code: 'file-unreadable', message: e.message ?? 'cannot read current file content', path: e.path })
      return
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, code: 'internal', message })
}

/** Browser-trust fence: loopback host or configured trusted authority. */
export function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length === 0) return false
  let url: URL
  try {
    url = new URL(`http://${authority}`)
  } catch {
    return false
  }
  const hostname = url.hostname
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return true
  }
  return trustedHosts.some(entry => {
    const entryHost = entry.includes(':') ? entry.slice(0, entry.lastIndexOf(':')) : entry
    return entryHost === hostname || entry === url.host
  })
}

/** SSE client registry. */
export interface SseClients {
  add(client: ServerResponse): () => void
  broadcast(data: unknown): void
}

/** webServer 结构面。 */
interface WebServerService {
  register(route: WebRoute): () => void
}

/** webRuntime 结构面。 */
interface WebRuntimeService {
  trustedHosts: string[]
}

/** 注册 /striatum API 路由 + SSE(依赖 StriatumServiceFace,无循环依赖)。 */
export function registerStriatumApi(
  ctx: Context & { webServer: WebServerService; webRuntime: WebRuntimeService },
  service: StriatumServiceFace,
  sse: SseClients,
): void {
  const trustedHosts = () => ctx.webRuntime.trustedHosts

  const apiRoute: WebRoute = {
    kind: 'prefix',
    path: '/striatum/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = url.pathname.slice('/striatum/api'.length + 1)
      try {
        if (!isTrustedRequest(req, trustedHosts())) {
          throw new StriatumApiError('forbidden', 'request rejected by the striatum trust fence', 403)
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') throw new StriatumApiError('bad-request', 'sessionId is required')
        switch (method) {
          case 'state': {
            writeOk(res, await service.state(sessionId))
            return
          }
          case 'keep': {
            const path = typeof body.path === 'string' ? body.path : undefined
            const r = await service.keep(sessionId, path)
            sse.broadcast({ kind: 'kept', sessionId, paths: r.paths, failed: r.failed })
            writeOk(res, r)
            return
          }
          case 'undo': {
            const path = typeof body.path === 'string' ? body.path : ''
            if (path === '') throw new StriatumApiError('bad-request', 'path is required')
            await service.undo(sessionId, path)
            sse.broadcast({ kind: 'undone', sessionId, path })
            writeOk(res, { ok: true, paths: [path] })
            return
          }
          default:
            throw new StriatumApiError('not-found', `unknown method "${method}"`, 404)
        }
      } catch (error) {
        writeError(res, error)
      }
    },
  }

  const eventsRoute: WebRoute = {
    kind: 'exact',
    path: '/striatum/events',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedRequest(req, trustedHosts())) {
        writeError(res, new StriatumApiError('forbidden', 'request rejected by the striatum trust fence', 403))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const unsubscribe = sse.add(res)
      res.on('close', unsubscribe)
      res.on('error', unsubscribe)
    },
  }

  ctx.webServer.register(apiRoute)
  ctx.webServer.register(eventsRoute)
}

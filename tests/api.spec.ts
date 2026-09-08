import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { UndoError } from '../src/host/registry.ts'
import { writeError } from '../src/host/api.ts'

/** Capture the status + JSON body a handler wrote. */
function capture(): { res: ServerResponse; written: { status: number; body: unknown } } {
  const written = { status: 0, body: undefined as unknown }
  const res = {
    writeHead(status: number): ServerResponse {
      written.status = status
      return this as unknown as ServerResponse
    },
    end(body?: unknown): ServerResponse {
      if (typeof body === 'string') written.body = JSON.parse(body) as unknown
      return this as unknown as ServerResponse
    },
  } as unknown as ServerResponse
  return { res, written }
}

describe('writeError UndoError → HTTP mapping', () => {
  it('maps hash-mismatch to 409 conflict', () => {
    const { res, written } = capture()
    writeError(res, new UndoError('hash-mismatch', 'changed externally', '/a.ts'))
    expect(written.status).toBe(409)
    expect(written.body).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('maps no-baseline to 400', () => {
    const { res, written } = capture()
    writeError(res, new UndoError('no-baseline', 'no baseline', '/a.ts'))
    expect(written.status).toBe(400)
    expect(written.body).toMatchObject({ ok: false, code: 'no-baseline' })
  })

  it('maps no-pending to 400', () => {
    const { res, written } = capture()
    writeError(res, new UndoError('no-pending', 'no pending', '/a.ts'))
    expect(written.status).toBe(400)
    expect(written.body).toMatchObject({ ok: false, code: 'no-pending' })
  })

  it('maps file-unreadable to 400 instead of a generic 500', () => {
    const { res, written } = capture()
    writeError(res, new UndoError('file-unreadable', 'cannot read current file content', '/a.ts'))
    expect(written.status).toBe(400)
    expect(written.body).toMatchObject({ ok: false, code: 'file-unreadable', path: '/a.ts' })
  })

  it('falls back to 500 internal for unknown errors', () => {
    const { res, written } = capture()
    writeError(res, new Error('boom'))
    expect(written.status).toBe(500)
    expect(written.body).toMatchObject({ ok: false, code: 'internal' })
  })
})

/**
 * dsh-striatum — 会话事件 → 每轮 write/edit 路径累积(仿 ui-deliverables)。
 *
 * 发布每轮「被 write/edit 触碰的路径」为 turn data(key: striatum-turns),
 * 供 turnTail chain 的 select 纯同步判断「本轮有无改动」。
 *
 * 注意:这里只累积 tool/call 的路径(不含结果校验);「是否仍 pending」
 * 由组件挂载后查 host /striatum/api 决定 —— select 必须纯,不能异步。
 */
import type {
  ConversationNodeDefinition,
  ConversationTurnDataMap,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 每轮改动路径的 turn data 值。 */
export interface StriatumTurnData {
  /** 本 turn 被 write/edit 触碰的路径(去重,首次出现序)。 */
  readonly changed: readonly string[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** 本 turn 触碰的 write/edit 路径(striatum 用)。 */
    'striatum-turns': StriatumTurnData
  }
}

interface StriatumState {
  readonly turn: number
  readonly changed: string[]
}

/** 从工具名+参数提取 write/edit 的目标路径。 */
function mutationPath(name: string, argsRaw: string): string | null {
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

/**
 * 累积每轮 write/edit 路径的 conversation definition。
 * 只关心 tool/call(参数里有路径);结果是否成功由 host 的 pending 判断。
 */
export const striatumTurnsDefinition: ConversationNodeDefinition<StriatumState> = {
  kind: 'striatum-turns',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') {
      const { name } = event.data
      if (name === 'write' || name === 'edit') return { id: String(event.data.turn), role: 'update' }
      return null
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('striatum-turns start requires turn/start')
    return { turn: match.event.data.turn, changed: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/call') return context.state
    const path = mutationPath(match.event.data.name, match.event.data.arguments)
    if (path === null || context.state.changed.includes(path)) return context.state
    return { ...context.state, changed: [...context.state.changed, path] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'striatum-turns'
      && (previous.value as StriatumTurnData).changed === context.state.changed) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'striatum-turns',
      value: { changed: context.state.changed },
    }
  },
}

/** select:本轮有 write/edit → 返回路径列表;否则 null(不占链)。 */
export function selectStriatumTurn(
  data: Readonly<StriatumTurnData> | undefined,
): readonly string[] | null {
  if (data === undefined) return null
  return data.changed.length === 0 ? null : data.changed
}

/**
 * dsh-striatum — client half。
 *
 * 注册:
 *  - 一个 conversation definition(striatum-turns):累积每轮 write/edit 路径;
 *  - conversation.chat.turnTail(chain):每轮末尾「本轮改动」确认条;
 *  - conversation.input.dock(list):输入框上方「未确认改动」总览条。
 *
 * scope=session 的槽位组件由框架注入 sessionId 标准 prop;turnTail 的
 * select 纯同步读 turn data(本轮有无 write/edit),组件挂载后查 host
 * 确认是否仍 pending。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { en, NS, zh } from './locales.ts'
import { OverviewStripBody } from './OverviewStrip.tsx'
import { TurnTailStripBody } from './TurnTailStrip.tsx'
import { h } from './react.ts'
import { selectStriatumTurn, striatumTurnsDefinition } from './turn-changes.ts'

/** client ctx 结构面(经官方 client 类型导入合并)。 */
type ClientCtx = Context & {
  locale: {
    register(namespace: string, dicts: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: unknown, component?: unknown): unknown
  }
  uiConversation: {
    events: { register(definition: unknown): unknown }
  }
}

/** Stable client plugin name. */
export const name = 'dsh-striatum'

/** Required services. */
export const inject = ['slots', 'locale', 'uiConversation']

export function apply(ctx: Context): void {
  const client = ctx as ClientCtx
  client.effect(() => client.locale.register(NS, { zh, en }), 'dsh-striatum: dictionaries')
  const t = client.locale.bind(NS)

  // 会话引擎:累积每轮 write/edit 路径(turn data)
  client.uiConversation.events.register(striatumTurnsDefinition)

  // 1) 每轮末尾确认条(turnTail chain):select 纯同步判断本轮有无 write/edit。
  // priority -10:先于官方 deliverables 产物行(默认 0)尝试 —— striatum 是
  // gatekeeper,本轮有改动待确认时显示操作条;否则让位给产物行。
  client.slots.inject('conversation.chat.turnTail', () => client.slots.register(
    {
      name: 'conversation.chat.turnTail',
      id: 'striatum-turn-tail',
      priority: -10,
      locale: NS,
      select: (owner: TurnTailOwnerProps) =>
        selectStriatumTurn(owner.turn.data.get('striatum-turns')),
      inject: (sessionId: string) => ({ sessionId, t }),
    },
    // matched = 本 turn write/edit 路径(select 非 null 才挂载)
    (props: TurnTailOwnerProps & { matched: readonly string[] } & { sessionId: string; t: (k: string, p?: Record<string, unknown>) => string }) =>
      h(TurnTailStripBody, {
        turn: props.turn,
        openFile: props.openFile,
        sessionId: props.sessionId,
        t: props.t,
      }),
  ))

  // 2) 输入框上方总览条(input.dock list)
  client.slots.inject('conversation.input.dock', () => client.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'striatum-overview',
      order: 80,
      locale: NS,
    },
    (props: { sessionId: string }) =>
      h(OverviewStripBody, { sessionId: props.sessionId, t }),
  ))
}

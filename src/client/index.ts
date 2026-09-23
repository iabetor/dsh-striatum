/**
 * dsh-striatum — client half。
 *
 * 注册:
 *  - 一个 conversation definition(striatum-turns):累积每轮 write/edit 路径;
 *  - conversation.chat.turnTail(chain):每轮末尾「本轮改动」确认条;
 *  - conversation.input.dock(list):输入框上方「未确认改动」总览条;
 *  - 文件预览的「改动」渲染器:与预览合并显示(hunk 级 + 文件级两级闸门)。
 *
 * scope=session 的槽位组件由框架注入 sessionId 标准 prop;turnTail 的
 * select 纯同步读 turn data(本轮有无 write/edit),组件挂载后查 host
 * 确认是否仍 pending。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only:documentPreviews 服务、sidebar.right.tab.document 座位与正文类型的
// Context 合并。该包不在平台模块表里,只有类型导入才不触发 client bundle 纯度门禁。
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ChangesBody } from './ChangesBody.tsx'
import { CHANGES_RENDERER_ID, DIFFABLE_EXTENSIONS } from './changes-renderer.ts'
import { sessionFileAddress } from './file-address.ts'
import { en, NS, zh } from './locales.ts'
import { OverviewStripBody } from './OverviewStrip.tsx'
import { TurnTailStripBody } from './TurnTailStrip.tsx'
import { h } from './react.ts'
import { selectStriatumTurn, striatumTurnsDefinition } from './turn-changes.ts'

/** 文件预览的渲染器注册表(ui-sidebar-documentpreview 提供)。 */
interface DocumentPreviewsFace {
  register(definition: unknown): () => void
}

/**
 * 可选依赖:文件预览的渲染器注册表。
 *
 * **不能**放进顶层的 `export const inject` —— 那是强依赖,未满足会让整个插件
 * 加载失败(cordis 抛 `cannot get property "documentPreviews" without inject`)。
 * 而预览器只在 web-app bundle 里,换 profile 就可能不在;故按官方做法用
 * `ctx.inject([...], cb)` 惰性注册:没有预览器时只是不注册那个渲染器。
 */
type OptionalCtx = Context & {
  inject(services: readonly string[], callback: (scope: ClientCtx & { documentPreviews: DocumentPreviewsFace }) => void): unknown
}

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

/** 侧栏导航面(仅用到 openResource)。 */
interface SidebarRightFace {
  openResource(address: string, options?: unknown): void
}

export function apply(ctx: Context): void {
  const client = ctx as ClientCtx
  client.effect(() => client.locale.register(NS, { zh, en }), 'dsh-striatum: dictionaries')
  const t = client.locale.bind(NS)

  // 「打开某文件预览」:sidebarRight 由 ui-sidebar-right 经 reflect.provide 提供,
  // 不在本插件的 inject 列表里,故用 ctx.get() 可选获取 —— 没装侧栏时返回
  // undefined,对应按钮不渲染,其余功能照常。
  const openDiff = (sessionId: string): ((path: string) => void) | undefined => {
    const sidebarRight = client.get('sidebarRight') as SidebarRightFace | undefined
    if (sidebarRight === undefined) return undefined
    return (path: string) => { sidebarRight.openResource(sessionFileAddress(sessionId, path)) }
  }

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
        sessionId: props.sessionId,
        t: props.t,
      }),
  ))

  // 2) 输入框上方总览条(input.dock list)
  //
  //    order 决定同槽位各条的上下顺序(升序 = 从上往下)。官方占用:
  //    todo(任务)= 0、goal = 10、queue = 20。取 -10 让「未确认改动」排在
  //    任务条**之上** —— 它是本轮唯一需要用户裁决的东西,应当先被看到。
  client.slots.inject('conversation.input.dock', () => client.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'striatum-overview',
      order: -10,
      locale: NS,
    },
    (props: { sessionId: string }) =>
      h(OverviewStripBody, { sessionId: props.sessionId, t, onOpenDiff: openDiff(props.sessionId) }),
  ))

  // 3) 文件预览的「改动」渲染器:与预览合并,不另开 tab。
  //
  //    注册表 `documentPreviews` 由 ui-sidebar-documentpreview 经
  //    ctx.reflect.provide 提供;侧栏的 turnTail / OverviewStrip 不依赖它,
  //    故用 ctx.inject 惰性接入 —— 预览器缺席时(striatum 仍提供确认条)
  //    不会拖垮整个 client 半。
  //
  //    priority 'extension' 使其排在官方 builtin 渲染器之前 → 打开有改动的
  //    代码文件时默认显示 diff;用户仍可在预览工具栏切回「代码」。
  const optional = client as OptionalCtx
  // 子 fiber 的 inject 集合自成一档:这里用到的服务都要列出(slots 虽在顶层已
  // 声明,但惰性回调跑在独立 fiber 上,不列就可能解析不到)。
  optional.inject(['slots', 'documentPreviews'], (scope) => {
    // 注意:register 是**服务**的方法,必须经 scope.documentPreviews 调用;
    // 早期版本误写成 previewCtx.register(靠 as unknown 骗过类型检查),
    // 运行时是 undefined → 渲染器静默不注册。
    const previews = scope.documentPreviews
    scope.effect(() => previews.register({
      id: CHANGES_RENDERER_ID,
      extensions: DIFFABLE_EXTENSIONS,
      priority: 'extension',
      title: () => t('striatum.badge.label'),
      loading: 'text-pages',
      wrap: false,
    }), 'dsh-striatum: changes renderer')
    scope.slots.inject('sidebar.right.tab.document', () => scope.slots.register(
      { name: 'sidebar.right.tab.document', key: CHANGES_RENDERER_ID, locale: NS },
      (props: {
        resourceAddress: string
        content: DocumentContent
        scrollportRef?: (el: HTMLElement | null) => void
        /** 预览壳的重读通道;旧版预览器不提供,此时为 undefined。 */
        reload?: () => void
      }) => h(ChangesBody, {
        resourceAddress: props.resourceAddress,
        content: props.content,
        t,
        scrollportRef: props.scrollportRef,
        reload: props.reload,
      }),
    ))
  })
}

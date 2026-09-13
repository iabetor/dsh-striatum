/**
 * dsh-striatum — OverviewStrip:输入框上方的「未确认改动」总览条。
 *
 * 挂在 conversation.input.dock(list)。订阅 /striatum/events(SSE),有 pending
 * 才显示;折叠为单行卡片(对齐 GoalBar/composer 几何),展开后按文件列出
 * Keep/Undo(文件级语义)。
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { FileStateView } from '../shared/wire.ts'
import { fetchState, keep, undo, StriatumApiClientError } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { useEffect, useState, h, type CSSProperties } from './react.ts'

/** 本组件经槽位注入的能力。 */
export interface OverviewStripInjected {
  t: TranslateNS<'striatum'>
  sessionId: string
  /**
   * 打开某文件的预览(点「diff」时调用)。
   *
   * 由注册处注入:它拿得到 `ctx.sidebarRight`(reflect.provide 服务)。组件
   * 自身不直接依赖侧栏服务,以保持与槽位契约解耦。
   */
  onOpenDiff?: (path: string) => void
}

export type OverviewStripProps = OverviewStripInjected

/** 与 composer 卡片对齐的 dock 宽度(参照官方 GoalBar)。 */
const dockStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 'calc(100% - var(--dsh-composer-side-clearance, 0px) * 2 - var(--dsh-composer-dock-inset, 0px) * 4)',
  maxWidth: 'calc(var(--dsh-composer-card-max-width, 720px) - var(--dsh-composer-dock-inset, 0px) * 4)',
  margin: '0 auto',
}

/** 卡片容器:auto 高度(折叠=36px 头;展开=头+列表),边框/背景在容器上。 */
const cardStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  border: '0.5px solid var(--dsw-alias-border-l1, #8886)',
  borderRadius: '10px',
  background: 'var(--dsw-specific-tip, #ffffff0d)',
  overflow: 'hidden',
}

/** 头行:固定 36px(对齐官方 GoalBar dock 卡)。 */
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  height: '36px',
  padding: '4px 6px 4px 10px',
  fontSize: '12px',
}

/** 展开区:官方 Todo/Queue 面板同款 max-height + 滚动,不无限撑高。 */
const listStyle: CSSProperties = {
  width: '100%',
  maxHeight: '180px',
  overflowY: 'auto',
}

const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
  width: '100%', padding: '3px 6px',
}

const btnStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l1, #8888)',
  borderRadius: '6px', background: 'transparent',
  padding: '1px 8px', fontSize: '12px', cursor: 'pointer', color: 'inherit',
}

const dangerStyle: CSSProperties = { ...btnStyle, borderColor: '#c0392b66', color: '#c0392b' }

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** OverviewStrip 主体:常驻于输入框上方、与 composer 对齐的卡片。 */
export function OverviewStripBody({ t, sessionId, onOpenDiff }: OverviewStripProps) {
  const [files, setFiles] = useState<FileStateView[]>([])
  const [expanded, setExpanded] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const refresh = (): void => {
    fetchState(sessionId)
      .then(state => { setFiles(state.files); setReady(true) })
      .catch(() => { setReady(true) })
  }

  useEffect(() => {
    refresh()
    return subscribeStriatumEvents(refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (!ready) return null
  if (files.length === 0) return null

  const onKeep = async (path?: string): Promise<void> => {
    setBusyPath(path ?? '*'); setError(null)
    try {
      await keep(sessionId, path)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusyPath(null) }
  }

  const onUndo = async (path: string): Promise<void> => {
    setBusyPath(path); setError(null)
    try {
      await undo(sessionId, path)
      refresh()
    } catch (e) {
      const known = e instanceof StriatumApiClientError
        ? e.code === 'conflict' ? t('striatum.conflict')
          : e.code === 'file-unreadable' ? t('striatum.unreadable') : undefined
        : undefined
      const msg = known ?? (e instanceof Error ? e.message : String(e))
      setError(`${t('striatum.undoRefused')}: ${msg}`)
    } finally { setBusyPath(null) }
  }

  return h('div', { 'data-striatum-overview': '', style: dockStyle },
    h('div', { style: cardStyle },
      // 头行(固定 36px):整行可点切换展开/收起(▸/▾);Keep/撤销按钮点击不冒泡。
      h('div', {
        style: { ...headerStyle, cursor: 'pointer', userSelect: 'none' },
        onClick: () => { setExpanded(v => !v) },
        title: t(expanded ? 'striatum.collapse' : 'striatum.expand'),
      },
        h('span', {
          style: { fontWeight: 600, flex: 'none', fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, #888)' },
          'aria-hidden': true,
        }, expanded ? '▾' : '▸'),
        h('span', { style: { fontWeight: 600, flex: 'none' } },
          `${t('striatum.label')} · ${t('striatum.files', { count: String(files.length) })}`),
        h('span', { style: { flex: 1 } }),
        h('button', {
          type: 'button', disabled: busyPath !== null,
          onClick: (event: MouseEvent) => { event.stopPropagation(); void onKeep() },
          style: btnStyle,
        }, t('striatum.keepAll')),
        h('button', {
          type: 'button', disabled: busyPath !== null,
          onClick: (event: MouseEvent) => {
            event.stopPropagation()
            void Promise.all(files.map(f => onUndo(f.path).catch(() => undefined)))
          },
          style: dangerStyle,
        }, t('striatum.undoAll')),
      ),
      // 展开的文件列表(限高滚动)
      expanded
        ? h('div', { style: listStyle }, files.map(f => h('div', { key: f.path, style: { ...rowStyle, justifyContent: 'flex-start' } },
          h('span', { style: { fontFamily: 'monospace', flex: 'none' } }, basename(f.path)),
          h('span', { style: { opacity: 0.7, flex: 'none' } },
            t('striatum.turnBadge', { turns: f.turns.join(','), count: String(f.changeCount) })),
          !f.hasBaseline
            ? h('span', { style: { color: '#888', flex: 'none' } }, t('striatum.noBaseline'))
            : !f.hashMatches
              ? h('span', { style: { color: '#b8860b', flex: 'none' } }, t('striatum.conflict'))
              : null,
          h('span', { style: { flex: 1 } }),
          // 「diff」:打开该文件的预览(注册了改动渲染器的类型会抢先显示 diff)。
          onOpenDiff !== undefined
            ? h('button', {
                type: 'button',
                onClick: () => { onOpenDiff(f.path) },
                style: btnStyle,
              }, t('striatum.viewDiff'))
            : null,
          h('button', {
            type: 'button', disabled: busyPath !== null, onClick: () => { void onKeep(f.path) },
            style: btnStyle,
          }, t('striatum.keep')),
          h('button', {
            type: 'button', disabled: busyPath !== null || !f.hasBaseline || !f.hashMatches,
            onClick: () => { void onUndo(f.path) }, style: dangerStyle,
          }, t('striatum.undo')),
        )))
        : null,
      error !== null ? h('div', { style: { ...rowStyle, color: '#c0392b' } }, error) : null,
    ),
  )
}

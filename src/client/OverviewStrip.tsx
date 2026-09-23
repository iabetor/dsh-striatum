/**
 * dsh-striatum — OverviewStrip:输入框上方的「未确认改动」总览条。
 *
 * 挂在 conversation.input.dock(list)。订阅 /striatum/events(SSE),有 pending
 * 才显示;折叠为单行卡片(对齐 GoalBar/composer 几何),展开后按文件列出
 * Keep/Undo(文件级语义)。
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileStateView } from '../shared/wire.ts'
import { fetchState, keep, undo, StriatumApiClientError } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { FileLink } from './FileLink.tsx'
import { spansMultipleTurns } from './overview-rows.ts'
import { StatBadge, totalStats } from './StatBadge.tsx'
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
  display: 'flex', alignItems: 'center', gap: '8px',
  width: '100%', padding: '4px 8px',
}

/** 行尾操作组:始终贴右,与左侧文件信息分开。 */
const rowActionsStyle: CSSProperties = {
  display: 'inline-flex', gap: '4px', alignItems: 'center', flex: 'none', marginLeft: 'auto',
}

/** 撑开用占位:把操作组推到行尾。 */
const rowSpacerStyle: CSSProperties = { flex: '1 1 auto' }

const dangerStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

/** 头部批量按钮:官方 ghost 胶囊,与界面其他按钮同族。 */
const headerBtnStyle: CSSProperties = { flex: 'none' }

/** 撤销类按钮的着色(官方 Button 的 outline + 危险色)。 */
const headerDangerStyle: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-state-error-primary)',
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

  const totals = totalStats(files)
  // 跨轮时才逐行标轮次(见 spansMultipleTurns)。
  const multiTurn = spansMultipleTurns(files)

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
        // 合计统计:与官方 ChangedFiles 头部的 `+156 -43` 同位。
        StatBadge({
          added: totals.uncounted === files.length ? undefined : totals.added,
          removed: totals.uncounted === files.length ? undefined : totals.removed,
          t,
          title: totals.uncounted === 0
            ? undefined
            : t('striatum.stat.partial', { count: String(totals.uncounted) }),
        }),
        h('span', { style: { flex: 1 } }),
        // 批量操作:官方 Button 胶囊(与界面其他按钮同族),不再是手写边框。
        h(Button, {
          variant: 'ghost', size: 'sm', style: headerBtnStyle,
          disabled: busyPath !== null,
          onClick: event => { event.stopPropagation(); void onKeep() },
        }, t('striatum.keepAll')),
        h(Button, {
          variant: 'ghost', size: 'sm', style: headerDangerStyle,
          disabled: busyPath !== null,
          onClick: event => {
            event.stopPropagation()
            void Promise.all(files.map(f => onUndo(f.path).catch(() => undefined)))
          },
        }, t('striatum.undoAll')),
      ),
      // 展开的文件列表(限高滚动)
      expanded
        ? h('div', { style: listStyle }, files.map(f => h('div', { key: f.path, style: rowStyle },
          // 图标 + 截断文件名:与「本轮改动」条共用 FileLink,截断规则只有一份。
          // 这里不给 onOpen —— 打开动作由右侧的「查看 diff」承担,文件名不抢它。
          h(FileLink, { display: f.display, path: f.path }),
          // 轮次只在**跨轮**时显示:单一轮次下逐行写「第 21 轮」是 9 行重复同一句
          // 话,纯噪声。「N 次」始终保留 —— 它逐文件不同,是真信息。
          h(Tag, { tone: 'quiet' },
            t(multiTurn ? 'striatum.turnBadge' : 'striatum.changeCount',
              { turns: f.turns.join(','), count: String(f.changeCount) })),
          // 每文件统计(与官方文件行的 `+3 -1` 同位)。missing 时画不出来,不显示。
          StatBadge({ added: f.added, removed: f.removed, t }),
          // 不可撤销的原因由 host 下发(undoBlockedBy),客户端不自行推断 ——
          // 否则「文件已被删除」会只留一个不可点的按钮而没有任何解释。
          // 用 Tag 而不是裸文字:它是个**状态**,该有状态的形状与底色。
          f.canUndo
            ? null
            : h(Tag, { tone: f.undoBlockedBy === 'hash-mismatch' ? 'warning' : 'danger' },
                t(f.undoBlockedBy === 'file-unreadable' ? 'striatum.unreadable'
                  : f.undoBlockedBy === 'hash-mismatch' ? 'striatum.conflict'
                    : 'striatum.noBaseline')),
          h('span', { style: rowSpacerStyle }),
          h('span', { style: rowActionsStyle },
            // 「diff」:打开该文件的预览(注册了改动渲染器的类型会抢先显示 diff)。
            onOpenDiff !== undefined
              ? h(Button, {
                  variant: 'ghost', size: 'sm',
                  onClick: () => { onOpenDiff(f.path) },
                }, t('striatum.viewDiff'))
              : null,
            h(Button, {
              variant: 'outline', size: 'sm',
              disabled: busyPath !== null, onClick: () => { void onKeep(f.path) },
            }, t('striatum.keep')),
            h(Button, {
              variant: 'outline', size: 'sm', style: dangerStyle,
              // 用 host 下发的 canUndo,不再自行推导(删掉的文件曾是"可点却失败")。
              disabled: busyPath !== null || !f.canUndo,
              onClick: () => { void onUndo(f.path) },
            }, t('striatum.undo')),
          ),
        )))
        : null,
      error !== null ? h('div', { style: { ...rowStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
    ),
  )
}

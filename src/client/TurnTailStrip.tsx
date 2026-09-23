/**
 * dsh-striatum — TurnTailStrip:每轮末尾的「本轮改动」确认条。
 *
 * 挂在 conversation.chat.turnTail(chain)。只在本轮涉及、且仍 pending 的
 * 文件存在时渲染;否则不占链。
 *
 * **刻意不列文件名**:同一个轮次末尾,官方 `ui-deliverables` 的 ChangedFiles 卡片
 * 已经列了一份「已编辑 N 个文件 + 每个文件的 +n -m」。两处都列就是同一信息画两遍,
 * 而真正属于 striatum 的差异(持久化、Keep/撤销)反被雷同的外壳盖住。这里只做
 * **一行状态**:改了几个文件、合计算了多少行、能不能撤销 —— 文件清单交给输入框
 * 上方那条总览(那里才是逐文件操作的地方)。
 *
 * 数据:从 host /striatum/api/state 的 records(带 turn)推导本 turn 涉及的路径,
 * 再与 files(pending)求交 —— 无需 client 侧事件推导。
 *
 * 文件级语义:Undo 是整文件回基线 —— 若某文件含更早轮次未确认改动,
 * 「全部撤销」会一并撤销(按钮旁有提示)。
 */
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileStateView } from '../shared/wire.ts'
import { fetchState, keep, undo } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { StatBadge, totalStats } from './StatBadge.tsx'
import { useEffect, useState, h, type CSSProperties } from './react.ts'

/** 本组件经槽位注入的能力。 */
export interface TurnTailStripInjected {
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * 本条的 props。
 *
 * 不再需要 `openFile`:本条的职责收敛成一行状态 + 批量操作,文件名清单归输入框
 * 上方那条总览(那里才有逐文件的打开/Keep/撤销)。少接一个能力,少一处不一致。
 */
export type TurnTailStripProps = Pick<TurnTailOwnerProps, 'turn'> & {
  /** 当前 sessionId(注册方注入)。 */
  sessionId: string
} & TurnTailStripInjected

const dangerStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

/** 从 state 推导「本 turn 涉及且仍 pending」的文件。 */
function pendingForTurn(state: { files: FileStateView[]; records: Array<{ turn: number; path: string }> }, turn: number): FileStateView[] {
  const pathsThisTurn = new Set(state.records.filter(r => r.turn === turn).map(r => r.path))
  return state.files.filter(f => pathsThisTurn.has(f.path))
}

/**
 * TurnTailStrip 主体。文件 pending 状态从 host state 拉取。
 * 注意:TurnTailOwnerProps.turn 是 TurnLocation 对象,数字轮次是 turn.turn。
 */
export function TurnTailStripBody({ turn, sessionId, t }: TurnTailStripProps) {
  const [files, setFiles] = useState<FileStateView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turnNum = typeof turn === 'number' ? turn : turn.turn

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      fetchState(sessionId)
        .then(state => {
          if (cancelled) return
          setFiles(pendingForTurn(state, turnNum))
        })
        .catch(() => {
          if (!cancelled) setFiles([])
        })
    }
    load()
    // 订阅 host 变更(OverviewStrip 的 keep/undo 也广播),让本条的
    // pending 状态与总览条同步 —— 否则总览条 keep 后本条仍显示陈旧改动。
    return subscribeStriatumEvents(() => { if (!cancelled) load() })
  }, [sessionId, turnNum]) // eslint-disable-line react-hooks/exhaustive-deps

  if (files === null || files.length === 0) return null

  const maxEarlier = Math.max(0, ...files.map(f => f.turns.filter(x => x < turnNum).length))
  const hasEarlier = maxEarlier > 0

  const onKeepAll = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await keep(sessionId)
      setFiles([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const onUndoAll = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      for (const f of files) await undo(sessionId, f.path)
      setFiles([])
    } catch (e) {
      setError(`${t('striatum.undoRefused')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(false) }
  }

  const totals = totalStats(files)

  return h('div', {
    'data-striatum-turn-tail': '',
    style: {
      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
      fontSize: '12px', padding: '4px 8px',
      // 允许收缩,子项里的省略号才有机会触发。
      minWidth: '0',
    },
  },
    // 一行状态:改了几个文件。
    h('span', { style: { fontWeight: 600, flex: 'none' } },
      t('striatum.turnTail.title', { count: String(files.length) })),
    // 合计增删(与官方卡片的 +n -m 同口径)。不列文件名 —— 见文件头注释。
    // 全部文件都统计不出来时给 undefined:宁可没有统计,也不显示 +0 -0 把
    // "不知道"谎报成"没改动"(与总览条同一处理)。
    StatBadge({
      added: totals.uncounted === files.length ? undefined : totals.added,
      removed: totals.uncounted === files.length ? undefined : totals.removed,
      t,
      title: totals.uncounted === 0
        ? undefined
        : t('striatum.stat.partial', { count: String(totals.uncounted) }),
    }),
    // 跨轮提示用 Tag:它是个状态,该有状态的形状,而不是一行黄字。
    hasEarlier
      ? h(Tag, { tone: 'warning' },
          t('striatum.earlierTurns', { count: String(maxEarlier) }))
      : null,
    h('span', { style: { flex: '1 1 auto' } }),
    h(Button, {
      variant: 'ghost', size: 'sm',
      disabled: busy, onClick: () => { void onKeepAll() },
    }, t('striatum.keepAll')),
    h(Button, {
      variant: 'ghost', size: 'sm', style: dangerStyle,
      disabled: busy, onClick: () => { void onUndoAll() },
      title: hasEarlier ? t('striatum.earlierTurns', { count: String(maxEarlier) }) : undefined,
    }, t('striatum.undoAll')),
    error !== null
      ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, error)
      : null,
  )
}

/**
 * dsh-striatum — TurnTailStrip:每轮末尾的「本轮改动」确认条。
 *
 * 挂在 conversation.chat.turnTail(chain)。只在本轮涉及、且仍 pending 的
 * 文件存在时渲染;否则不占链。
 *
 * 数据:从 host /striatum/api/state 的 records(带 turn)推导本 turn 涉及的路径,
 * 再与 files(pending)求交 —— 无需 client 侧事件推导。
 *
 * 文件级语义:Undo 是整文件回基线 —— 若某文件含更早轮次未确认改动,
 * 「全部撤销」会一并撤销(按钮旁有提示)。
 */
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { FileStateView } from '../shared/wire.ts'
import { fetchState, keep, undo } from './api.ts'
import { subscribeStriatumEvents } from './events.ts'
import { useEffect, useState, h, type CSSProperties } from './react.ts'

/** 本组件经槽位注入的能力。 */
export interface TurnTailStripInjected {
  t: (key: string, params?: Record<string, unknown>) => string
}

export type TurnTailStripProps = Pick<TurnTailOwnerProps, 'turn' | 'openFile'> & {
  /** 当前 sessionId(注册方注入)。 */
  sessionId: string
} & TurnTailStripInjected

const btnStyle: CSSProperties = {
  border: '1px solid #8886', borderRadius: '4px', background: 'transparent',
  padding: '2px 8px', fontSize: '12px', cursor: 'pointer', color: 'inherit',
}

const dangerStyle: CSSProperties = { ...btnStyle, borderColor: '#c0392b66', color: '#c0392b' }

/** 从 state 推导「本 turn 涉及且仍 pending」的文件。 */
function pendingForTurn(state: { files: FileStateView[]; records: Array<{ turn: number; path: string }> }, turn: number): FileStateView[] {
  const pathsThisTurn = new Set(state.records.filter(r => r.turn === turn).map(r => r.path))
  return state.files.filter(f => pathsThisTurn.has(f.path))
}

/**
 * TurnTailStrip 主体。文件 pending 状态从 host state 拉取。
 * 注意:TurnTailOwnerProps.turn 是 TurnLocation 对象,数字轮次是 turn.turn。
 */
export function TurnTailStripBody({ turn, sessionId, t, openFile }: TurnTailStripProps) {
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

  return h('div', {
    'data-striatum-turn-tail': '',
    style: {
      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
      fontSize: '12px', padding: '4px 8px',
    },
  },
    h('span', { style: { fontWeight: 600 } },
      t('striatum.turnTail.title', { count: String(files.length) })),
    h('span', { style: { opacity: 0.75, display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      files.map(f => h('button', {
        key: f.path,
        type: 'button',
        title: f.path,
        onClick: () => { openFile(f.path) },
        style: {
          border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
          fontSize: '12px', color: 'inherit', textDecoration: 'underline',
        },
      }, f.path.split('/').pop() ?? f.path))),
    hasEarlier
      ? h('span', { style: { color: '#b8860b' } },
          t('striatum.earlierTurns', { count: String(maxEarlier) }))
      : null,
    h('button', { type: 'button', disabled: busy, onClick: () => { void onKeepAll() }, style: btnStyle },
      t('striatum.keepAll')),
    h('button', {
      type: 'button', disabled: busy, onClick: () => { void onUndoAll() }, style: dangerStyle,
      title: hasEarlier ? t('striatum.earlierTurns', { count: String(maxEarlier) }) : undefined,
    }, t('striatum.undoAll')),
    error !== null ? h('span', { style: { color: '#c0392b' } }, error) : null,
  )
}

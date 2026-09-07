/**
 * dsh-striatum — client /striatum/events SSE 订阅。
 *
 * 模块级共享**单条** EventSource(host 广播对所有订阅者推送),每条 UI
 * (OverviewStrip / 每个 turnTail 实例)注册自己的回调;全部退订后关闭连接。
 * 收到任意广播(registered/kept/undone)即通知订阅者重新拉取 state ——
 * 各组件按自己的 sessionId 过滤,这里不做过滤。
 */
let sharedSource: EventSource | null = null
let subscriberCount = 0
const listeners = new Set<() => void>()

function ensureSource(): void {
  if (sharedSource !== null) return
  const source = new EventSource('/striatum/events')
  source.onmessage = () => {
    for (const listener of listeners) listener()
  }
  source.onerror = () => {
    /* EventSource 自动重连;静默 */
  }
  sharedSource = source
}

function releaseSource(): void {
  if (sharedSource === null) return
  sharedSource.close()
  sharedSource = null
}

/** 订阅 host 的 striatum 变更事件。返回取消函数。 */
export function subscribeStriatumEvents(onEvent: () => void): () => void {
  ensureSource()
  listeners.add(onEvent)
  subscriberCount += 1
  return () => {
    listeners.delete(onEvent)
    subscriberCount -= 1
    if (subscriberCount <= 0) releaseSource()
  }
}

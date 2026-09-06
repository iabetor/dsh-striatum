/**
 * dsh-striatum — client /striatum/events SSE 订阅。
 * 返回一个可订阅的「变更计数」源:每次 host 广播(registered/kept/undone),
 * 通知订阅者重新拉取 state。
 */
/** 订阅 host 的 striatum 变更事件。返回取消函数。 */
export function subscribeStriatumEvents(onEvent: () => void): () => void {
  const source = new EventSource('/striatum/events')
  source.onmessage = () => { onEvent() }
  source.onerror = () => { /* EventSource 自动重连;静默 */ }
  return () => { source.close() }
}

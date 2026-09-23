/**
 * dsh-striatum — 显示路径(给人看的短路径)。**只用于显示**。
 *
 * 与查表用的 `path` 严格分开:keep/undo/diff 一律传绝对路径(那是 registry 的键),
 * 这里只负责把它渲染成列表里好读的形态。此前客户端各自用 `basename()` 截断,于是
 * 同一目录下的多个 `index.ts` 在列表里完全无法区分。
 *
 * @module dsh-striatum/host/paths
 */
import { homedir } from 'node:os'
import { relative } from 'node:path'

/**
 * `child` 是否位于 `parent` 之内(含相等)。
 *
 * 比较前去掉尾斜杠:`/a/b/` 与 `/a/b` 必须视为同一目录,否则 `relative()` 会算出
 * 带 `..` 的假相对路径。
 * @param parent - 父目录(绝对路径)。
 * @param child - 待判定路径(绝对路径)。
 * @returns 是否在其内。
 */
export function isInside(parent: string, child: string): boolean {
  const base = parent.replace(/\/+$/, '')
  if (base === '') return false
  return child === base || child.startsWith(`${base}/`)
}

/**
 * 把绝对路径渲染成给人看的短路径。
 *
 * 规则(按序):
 *  1. **工作区内 → 相对工作区根**;
 *  2. 工作区外、home 内 → `~/${相对 home}`;
 *  3. 其余 → 原样的绝对路径。
 *
 * 工作区外的文件**不写成 `../…`**:那种形态越往上越多 `../`,反而比绝对路径更难
 * 定位,而且会随工作区深度变化。绝对路径始终保留在 UI 的悬停提示里。
 * @param path - 绝对路径。
 * @param cwd - 会话工作区根;未知时传 undefined。
 * @param home - home 目录;省略则取 `os.homedir()`。
 * @returns 短路径。
 */
export function displayPathOf(path: string, cwd: string | undefined, home: string = homedir()): string {
  if (cwd !== undefined && cwd !== '' && isInside(cwd, path)) {
    const rel = relative(cwd, path)
    // path === cwd 时 relative 得空串,那不是文件路径,继续往下走。
    if (rel !== '') return rel
  }
  if (home !== '' && isInside(home, path)) return `~/${relative(home, path)}`
  return path
}

/**
 * dsh-striatum — 文件资源地址的构造与解析。
 *
 * 与 `@deepseek-ai/dsh-util-workspace-path` 的 `dsh-resource://file/...` 文法一致,
 * 但**自带实现**:那个包不在 client 的平台模块表里,值导入会被 bundle 纯度门禁
 * 拒绝(见 tsdown.config.ts)。此处只需编码/解码,不碰文件系统。
 *
 * 也用不着 cwd:striatum 登记的路径来自 fs 工具,已是绝对路径,而该文法允许
 * path 段是绝对路径(host 会按会话 workspace root 解析)。
 * @module dsh-striatum/client/file-address
 */

const FILE_PREFIX = 'dsh-resource://file/'

/** 逐段编码,保留 `:` 以便 Windows 盘符按原样显示。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** 按 `/` 分段编码路径。 */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

/**
 * 构造某会话内一个文件的资源地址。
 * @param sessionId - 会话 id。
 * @param path - 绝对或工作区相对路径;反斜杠归一化为 `/`。
 * @returns `dsh-resource://file/session/<sessionId>/<path>`。
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/**
 * 解析文件资源地址。
 * @param address - 待解析地址。
 * @returns 会话 id 与路径;非 session 文件地址返回 null。
 */
export function parseFileAddress(address: string): { sessionId: string, path: string } | null {
  const prefix = `${FILE_PREFIX}session/`
  if (!address.startsWith(prefix)) return null
  const end = address.search(/[?#]/)
  const rest = address.slice(prefix.length, end === -1 ? undefined : end)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const rawPath = rest.slice(slash + 1)
  if (rawPath === '') return null
  try {
    return {
      sessionId: decodeURIComponent(rest.slice(0, slash)),
      path: rawPath.split('/').map(decodeURIComponent).join('/'),
    }
  } catch {
    // 非法百分号编码:按原样处理,交给 host 报 not-found。
    return { sessionId: rest.slice(0, slash), path: rawPath }
  }
}

/**
 * dsh-striatum — 「改动」渲染器要覆盖的文件类型。
 *
 * 清单来源:harness 预览器实际支持的类型(deepseek-harness 的
 * packages/client/ui-sidebar-documentpreview/src/client/code/languages.ts 的
 * CODE_EXTENSIONS,外加 markdown 的 md/markdown)。
 *
 * **刻意排除二进制**:image(png/jpg/...)、pdf —— 文本 diff 对它们无意义,
 * 且被 priority:'extension' 抢到默认渲染器只会得到坏体验。
 *
 * 为什么不用通配符:documentPreviews 的 extensions 只做 `name.endsWith('.x')`
 * 匹配,不支持 glob。所以无扩展名文件(Makefile、Dockerfile)覆盖不到 ——
 * 它们仍走官方兜底渲染器,只是看不到本改动视图。
 * @module dsh-striatum/client/changes-renderer
 */

/** 本渲染器在 documentPreviews 注册表中的实现名,也是内容座位所用的 key。 */
export const CHANGES_RENDERER_ID = 'dsh-striatum-changes'

/**
 * 可做文本 diff 的后缀(与 harness 预览器认得的文本类型一致)。
 * 顺序无意义 —— 匹配按后缀长度排序,不是按本数组顺序。
 */
export const DIFFABLE_EXTENSIONS: readonly string[] = [
  // 语言(CODE_EXTENSIONS)
  'ts', 'tsx', 'mts', 'cts',
  'js', 'jsx', 'mjs', 'cjs',
  'sh', 'bash', 'zsh',
  'json', 'jsonc', 'jsonl', 'ndjson',
  'py', 'pyw', 'pyi',
  'rb', 'rake', 'gemspec',
  'go', 'rs', 'java',
  'c', 'h',
  'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx',
  'cs', 'kt', 'kts', 'swift', 'php',
  'yaml', 'yml', 'toml', 'ini',
  'md', 'markdown', 'mdx',
  'html', 'htm', 'xhtml',
  'css', 'scss', 'less',
  'sql', 'xml', 'xsd', 'xsl', 'xslt', 'lua',
]

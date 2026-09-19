/**
 * dsh-striatum — 客户端语法高亮：复刻 harness 预览器的 shiki 配置。
 *
 * 为什么自带一份:官方 `highlightLines` **未从 ui-primitives 包根导出**
 * (构建产物的 export 列表里没有它),而跨包子路径导入会被 client bundle 的
 * 纯度门禁拒绝。所以这里用同一套公开 shiki API 自己建一个 —— 配置与
 * deepseek-harness 的 packages/client/ui-primitives/src/markdown/highlight.ts
 * **完全对齐**,颜色因此走同一批 `--shiki-*` 变量,观感与官方预览一致。
 *
 * 与官方的一处差异:官方把 26 种 grammar 里的 23 种做成懒加载(动态 import)。
 * 本插件是 **CJS 单文件 bundle**(`window.__ModuleLoader__` 包装),动态 import
 * 不适用,故全部静态内联 —— 代价是 bundle 变大,换来"任何语言首次即高亮、
 * 无异步回退闪烁"。
 * @module dsh-striatum/client/highlight
 */
import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import type { HighlighterCore } from 'shiki/core'

import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import langPython from '@shikijs/langs/python'
import langRuby from '@shikijs/langs/ruby'
import langGo from '@shikijs/langs/go'
import langRust from '@shikijs/langs/rust'
import langJava from '@shikijs/langs/java'
import langC from '@shikijs/langs/c'
import langCpp from '@shikijs/langs/cpp'
import langCsharp from '@shikijs/langs/csharp'
import langKotlin from '@shikijs/langs/kotlin'
import langSwift from '@shikijs/langs/swift'
import langPhp from '@shikijs/langs/php'
import langYaml from '@shikijs/langs/yaml'
import langToml from '@shikijs/langs/toml'
import langIni from '@shikijs/langs/ini'
import langMarkdown from '@shikijs/langs/markdown'
import langMdx from '@shikijs/langs/mdx'
import langHtml from '@shikijs/langs/html'
import langCss from '@shikijs/langs/css'
import langScss from '@shikijs/langs/scss'
import langLess from '@shikijs/langs/less'
import langSql from '@shikijs/langs/sql'
import langXml from '@shikijs/langs/xml'
import langLua from '@shikijs/langs/lua'

/** 一个高亮片段(与官方 HighlightSpan 同形)。 */
export interface HighlightSpan {
  text: string
  /** shiki 的 css-variables 颜色,如 `var(--shiki-token-keyword)`。 */
  color: string | undefined
}

/** 高亮结果:每条目对应源码的一行,每行是该行的片段序列。 */
export type HighlightedLines = readonly (readonly HighlightSpan[])[]

/**
 * 扩展名 → grammar id(与官方 `languageForPath` 的映射逐条对齐)。
 *
 * 对齐很重要:同一个文件在对话流 diff 卡片与本渲染器里必须解析到同一 grammar,
 * 否则同一段代码两处颜色会不同。JS 家族统一映射到 typescript(官方同此取舍:
 * shiki 的 TS grammar 对 JSX 是近似处理,换来只带一个 JS 家族 grammar)。
 */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  lua: 'lua',
}

/** 全部 grammar(静态内联;见文件头注释)。 */
const LANGS = [
  langTs, langBash, langJson, langPython, langRuby, langGo, langRust, langJava,
  langC, langCpp, langCsharp, langKotlin, langSwift, langPhp, langYaml, langToml,
  langIni, langMarkdown, langMdx, langHtml, langCss, langScss, langLess, langSql,
  langXml, langLua,
]

/** 全部 token 颜色走 `--shiki-*`(与官方同一批变量,故同一套配色)。 */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/** JS 正则引擎:不引入 oniguruma WASM,bundle 友好(与官方一致)。 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

/** 惰性构造高亮器(首次需要时才付初始化成本)。 */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
  return singleton
}

/**
 * 文件名 → grammar id。
 * @param path - 文件路径(只需扩展名)。
 * @returns grammar id;未知扩展名返回 undefined(渲染为纯文本)。
 */
export function languageForPath(path: string): string | undefined {
  const extension = /\.([^./\\]+)$/u.exec(path.replaceAll('\\', '/'))?.[1]?.toLowerCase()
  return extension === undefined ? undefined : EXTENSION_LANGUAGES[extension]
}

/**
 * 超过这个字节数就不着色。
 *
 * 着色成本随字节数近似线性增长 —— 但**仅当行长正常**。预热后实测(约 40 字符
 * 行长):34KB≈49ms、109KB≈127ms、257KB≈295ms、563KB≈652ms、1.1MB≈1310ms。
 * 取 256KB 是与 host 侧 `DIFF_TEXT_MAX` **同一个边界**:那份文本既然已被判定为
 * "太大不做逐行对比",也就不该再花 300ms 去着色;两边同数,省得日后解释为什么
 * 是两个阈值。
 *
 * 但这只是**第一道**卡口 —— 它防不住超长行,见 {@link HIGHLIGHT_MAX_LINE_WORK}。
 */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024

/**
 * 着色开销的代理值上限:Σ(行长的平方)。超过就不着色。
 *
 * 为什么字节上限不够:实测**总字节固定为 200KB** 时,只把行长从 36 拉到 1000,
 * 耗时就从 286ms 涨到 5004ms —— 17 倍。原因是引擎逐行做正则/TextMate 匹配,
 * **单行成本随行长近似平方增长**(实测单行 1000 字符 26ms、2000 字符 103ms、
 * 3000 字符 225ms,正是 4×/2.25× 的平方关系)。所以总成本 ≈ Σ Lᵢ²,而字节数
 * 对此完全无感:一行 50000 字符的 minified 产物只有 50KB,却要 **65 秒**。
 *
 * 阈值 12e6 由实测标定(每 1e6 代理值约 40ms):
 *  - **真实源码远在阈下**(实测本仓库最大文件 `ChangesBody.tsx` 仅 1.1M);
 *    40 字符/行的正常代码即使打满 256KB 字节上限也只有 10.7M → 仍全额着色;
 *  - 阈值内的最坏耗时实测 **约 490ms**(在 82 字符 × 2974 行处取得);
 *  - 超过即退回纯文本 —— 对超长行文件来说,这是从"卡死 65 秒"变成"没有颜色",
 *    而正文、改动块、折叠都照常。
 *
 * 取 12e6 而非更宽松的 20e6:后者阈值内最坏约 710ms,而同步阻塞主线程半秒以上
 * 已属可感卡顿,且换来的只是"某些 256KB 级、行长 60~80 的文件也能着色"。
 * 宁可在这类边缘大文件上不着色。
 */
export const HIGHLIGHT_MAX_LINE_WORK = 12_000_000

/**
 * 着色开销代理值 Σ L²。
 *
 * 独立成导出函数是为了可测:阈值标定依赖它,单测要能直接验证公式本身,
 * 而不是只能通过"跑一次着色看快不快"这种不稳定手段。
 * @param code - 源码全文。
 * @returns Σ(行长²);空文本为 0。
 */
export function highlightLineWork(code: string): number {
  let work = 0
  let start = 0
  while (start <= code.length) {
    const nl = code.indexOf('\n', start)
    const end = nl === -1 ? code.length : nl
    const length = end - start
    work += length * length
    // 超限即可提前返回:继续累加对结论无影响,还白扫剩余文本。
    if (work > HIGHLIGHT_MAX_LINE_WORK) return work
    if (nl === -1) break
    start = nl + 1
  }
  return work
}

/**
 * 逐行语法高亮。
 *
 * 整份文本**一次**着色再按行切分 —— 多行字符串、块注释、模板字面量等的颜色
 * 依赖跨行状态,逐片段高亮会算错(官方 ReadBlock 的同一条注释)。
 *
 * 两道卡口都收在这里(调用方无需各自判断):总量超 {@link HIGHLIGHT_MAX_BYTES}、
 * 或行长开销超 {@link HIGHLIGHT_MAX_LINE_WORK},都直接返回 undefined 让调用方
 * 退回纯文本。二者缺一不可 —— 见各自注释里的实测数据。
 * @param code - 源码全文。
 * @param lang - grammar id(来自 {@link languageForPath})。
 * @returns 每行的片段序列;语言未知、内容过大/超长行或着色失败时返回 undefined(退回纯文本)。
 */
export function highlightLines(code: string, lang: string | undefined): HighlightedLines | undefined {
  if (lang === undefined || code === '') return undefined
  if (code.length > HIGHLIGHT_MAX_BYTES) return undefined
  if (highlightLineWork(code) > HIGHLIGHT_MAX_LINE_WORK) return undefined
  let tokens
  try {
    ({ tokens } = highlighter().codeToTokens(code, { lang, theme: 'css-variables' }))
  } catch {
    // 未知 grammar / 着色器内部错误:退回纯文本,绝不因此让预览崩掉。
    return undefined
  }
  // shiki 对结尾换行会多出一个空行,而调用方的行数组没有它 —— 丢掉以保持对齐。
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  return lines.map(line => line.map(token => ({
    text: token.content,
    color: typeof token.color === 'string' ? token.color : undefined,
  })))
}

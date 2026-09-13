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
 * 逐行语法高亮。
 *
 * 整份文本**一次**着色再按行切分 —— 多行字符串、块注释、模板字面量等的颜色
 * 依赖跨行状态,逐片段高亮会算错(官方 ReadBlock 的同一条注释)。
 * @param code - 源码全文。
 * @param lang - grammar id(来自 {@link languageForPath})。
 * @returns 每行的片段序列;语言未知或着色失败时返回 undefined(调用方退回纯文本)。
 */
export function highlightLines(code: string, lang: string | undefined): HighlightedLines | undefined {
  if (lang === undefined || code === '') return undefined
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

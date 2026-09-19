/**
 * dsh-striatum — 语法高亮单测:语言映射与逐行对齐。
 *
 * 这里防的是**行错位**那类 bug:高亮的行数必须与文件行数严格相等,否则改动
 * 底色会画到错误的行上。另外核对颜色确实走 `--shiki-*` 变量 —— 与官方预览器
 * 共用同一批 token,是"两处观感一致"的前提。
 */
import { describe, expect, it } from 'vitest'
import {
  highlightLineWork, highlightLines, HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINE_WORK, languageForPath,
} from '../src/client/highlight.ts'
import { contentLines } from '../src/client/segments.ts'

describe('languageForPath', () => {
  it('maps the extensions the file manager can open', () => {
    expect(languageForPath('a.ts')).toBe('typescript')
    expect(languageForPath('a.go')).toBe('go')
    expect(languageForPath('a.py')).toBe('python')
    expect(languageForPath('a.rs')).toBe('rust')
    expect(languageForPath('a.md')).toBe('markdown')
    expect(languageForPath('a.yaml')).toBe('yaml')
  })

  it('maps the JS family onto the TypeScript grammar', () => {
    // 与官方同一取舍:shiki 的 TS grammar 对 JS/JSX 是近似处理,换来只带一个
    // JS 家族 grammar。两处必须解析到同一 grammar,否则同段代码颜色会不同。
    for (const name of ['a.js', 'a.jsx', 'a.tsx', 'a.mjs', 'a.cjs']) {
      expect(languageForPath(name)).toBe('typescript')
    }
  })

  it('is case-insensitive and ignores directory path', () => {
    expect(languageForPath('/a/b/MAIN.GO')).toBe('go')
    expect(languageForPath('src/deep/nested/x.Ts')).toBe('typescript')
  })

  it('accepts backslash paths', () => {
    expect(languageForPath('C:\\proj\\main.go')).toBe('go')
  })

  it('returns undefined for unknown or absent extensions', () => {
    expect(languageForPath('a.unknownext')).toBeUndefined()
    expect(languageForPath('Makefile')).toBeUndefined()
    expect(languageForPath('a.')).toBeUndefined()
  })

  it('does not treat a dotted directory as an extension', () => {
    // 只有最后一段是扩展名;目录名里的点不该被误认。
    expect(languageForPath('my.dir/file')).toBeUndefined()
  })
})

describe('highlightLines', () => {
  it('returns one entry per source line', () => {
    const code = 'const a = 1\nconst b = 2\nconst c = 3'
    const lines = highlightLines(code, 'typescript')
    expect(lines).toBeDefined()
    expect(lines).toHaveLength(3)
    expect(lines!.map(l => l.map(s => s.text).join('')).join('\n')).toBe(code)
  })

  it('aligns with contentLines for trailing-newline files', () => {
    // 关键不变量:预览壳用 contentLines 切行,高亮必须给出同样多的行。
    // shiki 对结尾换行会多出一个空行,若不过滤就会整体错位一行。
    for (const code of ['a\nb\n', 'a\nb', 'a\n', 'a', 'a\n\nb\n']) {
      const source = contentLines(code)
      const lines = highlightLines(code, 'typescript')
      expect(lines, `code=${JSON.stringify(code)}`).toHaveLength(source.length)
    }
  })

  it('aligns for an empty trailing line inside the file', () => {
    const code = 'a\n\nb\n'
    expect(contentLines(code)).toEqual(['a', '', 'b'])
    expect(highlightLines(code, 'typescript')).toHaveLength(3)
  })

  it('colors tokens through the shared --shiki-* variables', () => {
    const lines = highlightLines('const answer = 42', 'typescript')
    const colors = lines!.flat().map(s => s.color).filter((c): c is string => c !== undefined)
    expect(colors.length).toBeGreaterThan(0)
    for (const color of colors) expect(color).toMatch(/^var\(--shiki-/u)
  })

  it('highlights Go keywords and functions', () => {
    const lines = highlightLines('func main() {}', 'go')
    const colored = lines![0]!.filter(s => s.color?.includes('keyword') || s.color?.includes('function'))
    expect(colored.length).toBeGreaterThan(0)
  })

  it('keeps exact source text for every language', () => {
    for (const [lang, code] of [
      ['go', 'func main() {\n\tx := 42\n}'],
      ['python', 'def f(x):\n    return x'],
      ['rust', 'fn main() { let x = 1; }'],
    ] as const) {
      const lines = highlightLines(code, lang)
      expect(lines!.map(l => l.map(s => s.text).join('')).join('\n')).toBe(code)
    }
  })

  it('returns undefined for unknown or absent languages', () => {
    expect(highlightLines('x', undefined)).toBeUndefined()
    expect(highlightLines('x', 'not-a-grammar')).toBeUndefined()
  })

  it('returns undefined for empty input', () => {
    expect(highlightLines('', 'typescript')).toBeUndefined()
  })

  it('preserves multiline context instead of highlighting per line', () => {
    // 整段一起着色的理由:块注释/多行字符串的颜色依赖跨行状态。逐行高亮会把
    // 注释中间的行当成普通代码上色 —— 这里用"注释内若干行同色"来锁定该行为。
    const code = '/*\nstill comment\nstill comment\n*/\nconst x = 1'
    const lines = highlightLines(code, 'typescript')
    expect(lines).toHaveLength(5)
    const commentColors = [1, 2].map(i => lines![i]!.map(s => s.color).join('|'))
    expect(commentColors[0]).toBe(commentColors[1])
  })

  /**
   * 第一道卡口:总字节。着色是**主线程同步**的,耗时随字节数近似线性增长
   * (预热后实测 257KB≈295ms、1.1MB≈1310ms)。没有它,打开几万行的文件就是
   * 一两秒白屏。
   */
  it('skips highlighting once the text exceeds the byte cap', () => {
    const big = 'const x = 1\n'.repeat(Math.ceil(HIGHLIGHT_MAX_BYTES / 12) + 1)
    expect(big.length).toBeGreaterThan(HIGHLIGHT_MAX_BYTES)
    expect(highlightLines(big, 'typescript')).toBeUndefined()
  })

  it('highlights normal source right up to the byte cap', () => {
    // 卡口是 `>`,恰好等于上限仍着色 —— 且正常源码在 256KB 处远未触及第二道。
    const unit = 'const value = compute(1, "x");\n'
    const code = unit.repeat(Math.floor(HIGHLIGHT_MAX_BYTES / unit.length))
    expect(code.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_BYTES)
    expect(highlightLineWork(code)).toBeLessThan(HIGHLIGHT_MAX_LINE_WORK)
    expect(highlightLines(code, 'typescript')).toBeDefined()
  })
})

/**
 * 第二道卡口:行长开销。这是**字节上限挡不住**的那一类 —— 实测总字节固定
 * 200KB,只把行长从 36 拉到 1000,耗时就从 286ms 涨到 5004ms;单行 50000 字符
 * 的 minified 产物只有 50KB,却要 65 秒。根因是引擎逐行匹配,单行成本随行长
 * 近似平方增长。
 */
describe('highlightLineWork', () => {
  it('sums the square of every line length', () => {
    // 3 行 × 10 字符 → 300;公式本身要能被直接验证,而不是只能靠"跑着色快不快"。
    expect(highlightLineWork('0123456789\n0123456789\n0123456789')).toBe(300)
  })

  it('counts a trailing line without a newline', () => {
    expect(highlightLineWork('abc')).toBe(9)
    expect(highlightLineWork('abc\nde')).toBe(13)
  })

  it('is zero for empty text', () => {
    expect(highlightLineWork('')).toBe(0)
  })

  it('short-circuits once past the cap instead of scanning the rest', () => {
    // 提前返回:结论不变(仍超限),但省下扫描剩余文本。
    const huge = 'x'.repeat(50000) + '\n' + 'y'.repeat(50000)
    expect(highlightLineWork(huge)).toBeGreaterThan(HIGHLIGHT_MAX_LINE_WORK)
  })

  it('rejects the pathological single-line inputs that used to hang', () => {
    for (const code of ['x'.repeat(20000), 'x'.repeat(50000)]) {
      expect(highlightLineWork(code)).toBeGreaterThan(HIGHLIGHT_MAX_LINE_WORK)
      expect(highlightLines(code, 'typescript')).toBeUndefined()
    }
  })

  it('still accepts deeply ordinary files', () => {
    // 回归:真实源码必须全部通过 —— 本仓库最大的文件也只有约 1.1M。
    expect(highlightLineWork('const x = 1\n'.repeat(8000))).toBeLessThan(HIGHLIGHT_MAX_LINE_WORK)
  })
})

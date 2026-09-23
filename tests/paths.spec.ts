/**
 * dsh-striatum — 显示路径规则的单元测试。
 *
 * 这些断言刻意写死具体字符串:显示路径是给人看的,**想要的形态本身就是规格**。
 * 之前只改了一处显示点、另一处仍用 basename 截断,单看类型检查发现不了。
 */
import { describe, expect, it } from 'vitest'
import { displayPathOf, isInside } from '../src/host/paths.ts'

const CWD = '/Users/vinsonruan/Documents/workspace/deepseek/dsh-projects'
const HOME = '/Users/vinsonruan'

describe('isInside', () => {
  it('treats the directory itself and its children as inside', () => {
    expect(isInside(CWD, CWD)).toBe(true)
    expect(isInside(CWD, `${CWD}/a/b.ts`)).toBe(true)
  })

  it('ignores a trailing slash so /a/b/ and /a/b are the same directory', () => {
    expect(isInside(`${CWD}/`, `${CWD}/a.ts`)).toBe(true)
    expect(isInside(`${CWD}/`, CWD)).toBe(true)
  })

  it('rejects a sibling directory that merely shares the prefix', () => {
    // 前缀相同但不是子目录 —— 用 startsWith 直接比较会误判成 inside。
    expect(isInside(CWD, `${CWD}-other/a.ts`)).toBe(false)
    expect(isInside(CWD, '/Users/vinsonruan/Documents/workspace')).toBe(false)
  })

  it('rejects an empty parent rather than matching everything', () => {
    expect(isInside('', '/anything')).toBe(false)
    expect(isInside('/', '/anything')).toBe(false)
  })
})

describe('displayPathOf', () => {
  it('renders a file inside the workspace relative to its root', () => {
    expect(displayPathOf(`${CWD}/dsh-striatum/src/index.ts`, CWD, HOME))
      .toBe('dsh-striatum/src/index.ts')
  })

  it('keeps a file outside the workspace inside home as ~/…', () => {
    // 工作区外**不写成 ../…**:那种形态越往上越多 ../,比绝对路径更难定位,
    // 而且会随工作区深度变化。这是用户确认过的约定。
    expect(displayPathOf(
      '/Users/vinsonruan/Documents/workspace/deepseek/deepseek-harness/packages/a.ts',
      CWD,
      HOME,
    )).toBe('~/Documents/workspace/deepseek/deepseek-harness/packages/a.ts')
  })

  it('falls back to ~ for a file elsewhere in home', () => {
    expect(displayPathOf(`${HOME}/.dsh/striatum/session-x.jsonl`, CWD, HOME))
      .toBe('~/.dsh/striatum/session-x.jsonl')
  })

  it('keeps an absolute path when it is outside home and far from the workspace', () => {
    expect(displayPathOf('/tmp/somewhere/else.txt', CWD, HOME)).toBe('/tmp/somewhere/else.txt')
  })

  it('falls back to ~ when no workspace is known', () => {
    // cwd 未知时无法相对化,但 home 内仍可缩写成 ~/…(与官方 displayPathOf 一致)。
    expect(displayPathOf(`${CWD}/a.ts`, undefined, HOME)).toBe('~/Documents/workspace/deepseek/dsh-projects/a.ts')
    expect(displayPathOf(`${CWD}/a.ts`, '', HOME)).toBe('~/Documents/workspace/deepseek/dsh-projects/a.ts')
  })

  it('keeps an absolute path outside home when no workspace is known', () => {
    expect(displayPathOf('/tmp/x.txt', undefined, HOME)).toBe('/tmp/x.txt')
  })

  it('keeps sibling workspaces distinguishable', () => {
    // 回归:同一目录下的两个 index.ts 必须显示成不同的字符串。
    const one = displayPathOf(`${CWD}/dsh-striatum/src/index.ts`, CWD, HOME)
    const two = displayPathOf(`${CWD}/dsh-pineal/src/index.ts`, CWD, HOME)
    expect(one).not.toBe(two)
  })
})

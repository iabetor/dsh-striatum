/**
 * dsh-striatum — 总览条行内文案的纯判定逻辑。
 *
 * **独立成模块**而不是留在 OverviewStrip.tsx 里:那个文件会 import 官方
 * `ui-primitives`(浏览器侧由 shell 提供,Node 测试环境解析不到它的传递依赖),
 * 于是任何从它 import 的东西都跟着不可测。纯逻辑放这里,测试就不必碰组件。
 *
 * @module dsh-striatum/client/overview-rows
 */

/** 只取判定所需的最小形状,不绑 wire 类型。 */
export interface TurnBearing {
  readonly turns: readonly number[]
}

/**
 * 这批待确认改动是否跨了多个轮次。
 *
 * 只有一个轮次时,逐行标注「第 N 轮」是在 9 行里重复同一句话 —— 纯噪声。跨轮次时
 * 它才有用(能看出哪个文件是上一轮留下的)。判定问的是**整批**涉及的轮次总数,
 * 而不是逐行 `f.turns.length > 1`:一个文件只涉及一轮、但别的文件涉及另一轮时,
 * 这行同样需要标出轮次,否则读不出它属于哪一轮。
 * @param files - 待确认文件。
 * @returns 涉及的总轮次数是否大于一。
 */
export function spansMultipleTurns(files: readonly TurnBearing[]): boolean {
  const all = new Set<number>()
  for (const file of files) for (const turn of file.turns) all.add(turn)
  return all.size > 1
}

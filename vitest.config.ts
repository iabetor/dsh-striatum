/**
 * dsh-striatum — vitest 配置。
 *
 * 存在的唯一理由:客户端组件会 import 官方 `@deepseek-ai/dsh-client-ui-primitives`,
 * 而它**只发布已构建的 lib**(JS + `.module.css` + 类型,没有 src)。Node 原生不认
 * `.css`,所以这些包必须交给 Vite 处理,而不是被当作外部依赖丢给 Node 的 ESM 加载器。
 *
 * 浏览器侧不受影响 —— 那些组件由 shell 打包(见 deepseek-harness 的
 * packages/client/web/src/seed.ts),CSS 与 clsx 都在那里内联好了;本文件只解决
 * **测试环境**的解析问题。
 */
import { defineConfig } from 'vitest/config'

const STUB = '\0dsh-striatum:css-stub'

export default defineConfig({
  plugins: [
    {
      name: 'dsh-striatum:stub-css',
      enforce: 'pre',
      resolveId(id) {
        if (!id.endsWith('.css')) return null
        return STUB
      },
      load(id) {
        // CSS Modules 的类名不参与断言(断言的是渲染出的文本与结构),给个常量即可。
        // 用 Proxy 而不是 {}:`css.foo` 取到的是类名字符串,不是 undefined。
        if (id !== STUB) return null
        return 'export default new Proxy({}, { get: (_t, key) => String(key) })'
      },
    },
  ],
  test: {
    // 让 Vite 处理这些包(而非外部化给 Node):否则它们的 .css 请求不会经过上面的插件。
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})

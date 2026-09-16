import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'

// Read the manifest from cwd: `pnpm run build` runs here.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell
// seeds these specifiers into the frozen browser module table, so client
// bundles leave them to the injected `require` instead of inlining.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const requested = new Set([
  ...PLATFORM_MODULES,
  ...(pkg.dsh?.client?.external ?? []),
])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: a production dependency is on disk in a real install and stays
// an import; everything else inlines.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      __DSH_CTX_VERSION__: JSON.stringify(pkg.version),
      __DSH_CTX_REPO__: JSON.stringify(
        String((pkg.repository && pkg.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, ''),
      ),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${pkg.name}'s dsh.client.external — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])

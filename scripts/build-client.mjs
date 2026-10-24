/**
 * 把原生画布客户端打成一个 DSH 客户端模块。
 *
 * 产物形状（和官方客户端包一致）：
 *   window.__ModuleLoader__.load({ id: "dsh-jiashi", factory: (require) => { ... } })
 *   factory 里先建 module/exports，把 bundle 代码放进去，最后 return module.exports。
 *
 * 构建依赖（esbuild、tldraw、react 类型）来自架势源码目录的 node_modules，
 * 这样插件自己不背一份依赖树；换机器时用 JIASHI_SRC 指到 Framework。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = process.env.JIASHI_SRC ?? 'C:/Users/51931/WorkBuddy/2026-07-14-16-37-13/Framework'
const frameworkRequire = createRequire(resolve(srcRoot, 'package.json'))
const { build } = frameworkRequire('esbuild')

const entry = resolve(here, 'src/client/index.jsx')
const bundleFile = resolve(here, 'lib/client.bundle.js')
const outputFile = resolve(here, 'lib/client.js')

await mkdir(resolve(here, 'lib'), { recursive: true })

/** 依次替换（replace 的异步版），用于把 KaTeX 字体内联进 CSS 文本。 */
async function replaceAsync(text, regex, replacer) {
  const jobs = []
  text.replace(regex, (match, ...groups) => {
    jobs.push(Promise.resolve(replacer(match, ...groups)))
    return match
  })
  const values = await Promise.all(jobs)
  let index = 0
  return text.replace(regex, () => values[index++])
}

/**
 * KaTeX 的 CSS 用相对 url(fonts/...) 引用字体；CSS 作为文本注入 <style> 后，
 * 这些相对路径会解析到页面根而不是插件目录。构建时把 woff2 直接内联成 data URI。
 */
const katexInlineFontsPlugin = {
  name: 'jiashi-katex-fonts',
  setup(build) {
    build.onLoad({ filter: /katex[\\/]dist[\\/]katex\.min\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8')
      const fontsDir = resolve(srcRoot, 'node_modules/katex/dist/fonts')
      const contents = await replaceAsync(
        css,
        /url\((['"]?)fonts\/([^'")]+)\1\)/g,
        async (match, _quote, file) => {
          if (!file.endsWith('.woff2')) return match
          try {
            const bytes = await readFile(resolve(fontsDir, file))
            return `url(data:font/woff2;base64,${bytes.toString('base64')})`
          } catch {
            return match
          }
        },
      )
      return { contents, loader: 'text' }
    })
  },
}

const result = await build({
  entryPoints: [entry],
  outfile: bundleFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  minify: false, // 保留可读性，体积大一点但便于调试
  legalComments: 'none',
  plugins: [katexInlineFontsPlugin],
  // 宿主提供 React；tldraw 与它的依赖全部打进产物。
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  // JSX 走自动运行时（react/jsx-runtime 由宿主提供）。
  jsx: 'automatic',
  loader: {
    '.css': 'text',
    // 单文件产物：字体/图片一律内联，避免依赖 /plugins 路由下的相对资源
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.otf': 'dataurl',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
    '.webp': 'dataurl',
    '.gif': 'dataurl',
    '.svg': 'dataurl',
  },
  // 让 tldraw / react 类型从架势源码目录解析
  nodePaths: [resolve(srcRoot, 'node_modules')],
  logLevel: 'info',
  metafile: false,
})

if (result.errors.length > 0) {
  process.exitCode = 1
  console.error(result.errors)
} else {
  const bundle = await readFile(bundleFile, 'utf8')
  const wrapped = `window.__ModuleLoader__.load({
  id: 'dsh-jiashi',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
${bundle}
    return module.exports
  },
})
`
  await writeFile(outputFile, wrapped, 'utf8')
  const size = (await readFile(outputFile)).byteLength
  console.log(`[jiashi] wrote ${outputFile} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

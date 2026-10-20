/**
 * 构建前端产物并同步到插件 web/。
 *
 * 架势的源码不在这个插件仓库里，默认指向本机路径；换机器时用
 * JIASHI_SRC 覆盖，或在 Framework/vite.config.ts 里保持 base: './'。
 *
 * 用法：node scripts/build-web.mjs
 */
import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const src = process.env.JIASHI_SRC ?? 'C:/Users/51931/WorkBuddy/2026-07-14-16-37-13/Framework'
const dist = resolve(src, 'dist')
const target = resolve(here, 'web')

console.log(`[jiashi] building ${src}`)
execFileSync('npm', ['run', 'build'], { cwd: src, stdio: 'inherit', shell: true })

rmSync(target, { recursive: true, force: true })
cpSync(dist, target, { recursive: true })
console.log(`[jiashi] copied ${dist} -> ${target}`)

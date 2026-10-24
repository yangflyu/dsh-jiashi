/**
 * 架势画布（dsh-jiashi）— Host 半边。
 *
 * 只做一件事：把 Framework 的静态构建产物（web/）挂在 DSH 自己的 HTTP
 * 服务下，路径前缀 /jiashi/。之所以不自己起一个端口：
 *
 * - 同源：iframe 里的 localStorage / IndexedDB 和 DSH 页面同一个 origin，
 *   设置、对话、以后的画布快照都落在同一个域下，换端口也不会丢；
 * - 零配置：不用协调端口、不用处理 CORS，浏览器端直接相对路径访问；
 * - 生命周期：路由随插件 effect 注册/释放，关掉插件就 404，不占资源。
 *
 * 静态资源在 DSH 里本来就是公开的（只有 /api 需要会话 cookie），所以
 * /jiashi/ 不需要额外的鉴权层。
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'jiashi-web'

/** 硬依赖：没有 HTTP 服务就没有地方挂静态资源。 */
export const inject = ['webServer']

const ROOT = fileURLToPath(new URL('./web/', import.meta.url))
/** 路由注册用的前缀（webServer 的 prefix 匹配是 `${path}/`，不能再带尾斜杠）。 */
const ROUTE_PATH = '/jiashi'
/** 浏览器里的实际挂载根（带尾斜杠，相对资源才解析到 /jiashi/assets/）。 */
const BASE = `${ROUTE_PATH}/`
/** 客户端诊断日志落点：$DSH_HOME/jiashi/board.log。 */
const LOG_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'jiashi')
const LOG_FILE = join(LOG_DIR, 'board.log')
const LOG_PATH = `${BASE}api/log`
const CREATE_PATH = `${BASE}api/session/create`

/** Host 侧 sessionController 引用（由 apply 里的 inject 填充）。 */
let sessionController

/** 读一个 JSON 请求体（上限 64KB）。 */
async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 65536) {
      req.destroy()
      return ''
    }
  }
  return body
}

function writeJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * 建会话：客户端画布通过这个同源路由请求，宿主直接调 sessionController.create。
 * 不依赖客户端 Remote 服务的 inject，也不会弹任何选择框。
 */
async function handleCreateSession(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  let request = {}
  try {
    const body = await readBody(req)
    request = body === '' ? {} : JSON.parse(body)
  } catch {
    request = {}
  }
  try {
    if (sessionController === undefined || typeof sessionController.create !== 'function') {
      throw new Error('sessionController unavailable')
    }
    const value = await sessionController.create({
      ...(typeof request.workspaceId === 'string' && request.workspaceId !== ''
        ? { workspaceId: request.workspaceId }
        : {}),
      ...(typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : {}),
    })
    writeJson(res, { ok: true, sessionId: value?.sessionId ?? null })
  } catch (error) {
    writeJson(res, {
      ok: false,
      error: {
        code: String(error?.code ?? 'session/create-failed'),
        message: String(error?.message ?? error),
      },
    })
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
}

/** 把 /jiashi/<rel> 映射到 web/ 目录内的绝对路径；越界返回 undefined。 */
function resolveInside(rel) {
  const segments = rel
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (segments.some((segment) => segment === '..')) return undefined
  const file = resolve(ROOT, ...segments)
  if (file !== ROOT && !file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return undefined
  return file
}

async function sendFile(req, res, file, rel) {
  const info = await stat(file)
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' })
  const body = await readFile(file)
  const immutable = rel.startsWith('assets/')
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

/** 客户端诊断日志：POST 追加一行 JSON，GET 读回全部（方便宿主侧排查画布问题）。 */
async function handleLog(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      const text = await readFile(LOG_FILE, 'utf8')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : text)
    } catch {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('')
    }
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 65536) {
      req.destroy()
      return
    }
  }
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_FILE, `${new Date().toISOString()} ${body.slice(0, 65536)}\n`, 'utf8')
  } catch {
    /* 日志写不进去不影响画布本身 */
  }
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

async function serve(req, res) {
  try {
    const url = new URL(req.url ?? BASE, 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)
    if (pathname === LOG_PATH) {
      await handleLog(req, res)
      return
    }
    if (pathname === CREATE_PATH) {
      await handleCreateSession(req, res)
      return
    }
    let rel = pathname === ROUTE_PATH
      ? ''
      : pathname.startsWith(BASE) ? pathname.slice(BASE.length) : ''
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    const file = resolveInside(rel)
    if (file === undefined) throw Object.assign(new Error('forbidden'), { code: 'EACCES' })
    await sendFile(req, res, file, rel)
  } catch {
    // 单页应用：未知路径回落到 index.html（架势没有路由，这里只是兜底）。
    try {
      await sendFile(req, res, resolve(ROOT, 'index.html'), 'index.html')
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }
}

export function apply(ctx) {
  // 捕获 sessionController：画布的"新建会话"走本插件的同源路由，
  // 由宿主直接调 create，避开客户端 Remote 的 inject 限制。
  ctx.effect(
    () => ctx.inject(['sessionController'], (injected) => {
      sessionController = injected.sessionController
      return () => {
        sessionController = undefined
      }
    }),
    'jiashi-web: session controller',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: serve }),
    'jiashi-web: static route',
  )
  // /jiashi 没有尾斜杠时补一个跳转，保证相对路径资源解析到 /jiashi/assets/...
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/jiashi',
      handler: (_req, res) => {
        res.writeHead(301, { location: BASE })
        res.end()
      },
    }),
    'jiashi-web: slash redirect',
  )
  ctx.logger?.info?.(`[jiashi] serving ${ROOT} at ${BASE}`)
}

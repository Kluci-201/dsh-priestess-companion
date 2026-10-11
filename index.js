/**
 * dsh-priestess-companion — Host half.
 *
 * 悬浮在 DSH 网页里的普瑞赛斯挂件：她站在右下角，身旁一行浅白色的余额。
 *
 * 宿主这一半只做两件事，都是靠自己的 HTTP 路由：
 *
 *   1. `GET /dsh-priestess-companion/state.json` —— 余额与配置。
 *      账号凭据只活在宿主进程里（浏览器拿不到），所以余额必须由这里去取。
 *      三种来源，由配置 `source` 选：
 *        - `account`（默认）：读 DSH 自己的 DeepSeek 账号钱包；
 *        - `url`：去问一个任意 HTTP 接口，返回的数字或 JSON 里的 balance 都认；
 *        - `fixed`：写死一个数字，纯粹用来试样式。
 *   2. `GET /dsh-priestess-companion/image` —— 人物图（透明底 PNG）。
 *      浏览器读不到本地路径，图片只能由宿主供出去。
 *
 * 几处刻意的选择：
 *
 *   - **不导出 `Config`。** Cordis 要的是带 `validate` 的 schema 对象，裸 JSON
 *     Schema 会在解析期抛错，而抛错会让**整个插件都不激活**。配置全部由
 *     `normalizeOptions` 在运行期兜底，写坏的字段只会回落成默认值。
 *   - **账号服务是可选依赖。** 用 `ctx.get('deepseekAccount')` 惰性取，而不是写进
 *     inject——否则在没装账号插件的组合里，这个挂件会连图都不显示。
 *   - **缓存 + 穿透。** 远端余额不必每帧去问；默认 20 秒内复用上次结果，
 *     `?refresh=1` 强制穿透。响应里永远带 `fetchedAt` 与 `cached`，让页面知道
 *     自己看的是哪一刻的数字。
 *   - **每一次取数都写一行日志**：读不到宿主日志时，"挂件没显示余额"这件事分不出
 *     是路由没被请求、账号没登录、还是远端挂了。留下记录就不用猜。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包目录；自带图片相对它解析，所以 link 安装、npm 安装都找得到。 */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** 路由前缀（绝对路径，HTTP 与 IPC 两条通道共用）。 */
const BASE = '/dsh-priestess-companion'
const STATE_ROUTE = `${BASE}/state.json`
const IMAGE_ROUTE = `${BASE}/image`

const CORNERS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
const SOURCES = new Set(['account', 'url', 'fixed'])

/**
 * 配置默认值。纯对象而非 schema —— 理由见文件头。
 *
 * 这些值会原样交给浏览器那一半（响应里的 `options`），所以它们同时是
 * **外观与节奏的唯一旋钮**。
 */
export const DEFAULTS = {
  /** 总开关。关掉后页面那半不渲染任何东西。 */
  enabled: true,
  /** 余额来源：account / url / fixed。 */
  source: 'account',
  /** `source: 'url'` 时去问的接口地址。 */
  url: '',
  /** `source: 'fixed'` 时用的数字（字符串也认，便于试 12.34 这种）。 */
  fixedValue: '88.88',
  /** 固定来源时的货币符号。 */
  fixedSymbol: '¥',
  /** 初始贴哪个角；拖动过之后以记住的位置为准。 */
  corner: 'bottom-right',
  /** 距边缘的距离（px）。 */
  offsetX: 22,
  offsetY: 18,
  /** 人物图显示宽度（px）。高度按比例走，绝不拉伸。 */
  scale: 190,
  /** 人物图：包内相对路径、绝对路径，或 http(s) 地址。 */
  image: 'assets/priestess.png',
  /** 悬停时是否展开明细（充值 / 赠送 / 取数时刻）。 */
  showDetails: true,
  /** 页面自动重新取数的间隔（秒）；0 = 只在打开时取一次。 */
  refreshSeconds: 120,
  /** 宿主侧缓存秒数；0 = 每次都真的去问。 */
  cacheSeconds: 20,
}

const MAX_OFFSET = 400
const MAX_SCALE = 800
const MAX_SECONDS = 86400
const MAX_URL = 2048

function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/**
 * 把原始配置收成有效值。每个字段都兜底：写坏一个字段只会让那一个回落。
 * @param raw - 合并后的配置对象。
 * @returns 每个字段都存在且合法的配置。
 */
export function normalizeOptions(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    source: typeof input.source === 'string' && SOURCES.has(input.source) ? input.source : DEFAULTS.source,
    url: typeof input.url === 'string' ? input.url.trim().slice(0, MAX_URL) : DEFAULTS.url,
    fixedValue: typeof input.fixedValue === 'string' || typeof input.fixedValue === 'number'
      ? String(input.fixedValue)
      : DEFAULTS.fixedValue,
    fixedSymbol: typeof input.fixedSymbol === 'string' && input.fixedSymbol !== ''
      ? input.fixedSymbol
      : DEFAULTS.fixedSymbol,
    corner: typeof input.corner === 'string' && CORNERS.has(input.corner) ? input.corner : DEFAULTS.corner,
    offsetX: Math.round(clampNumber(input.offsetX, DEFAULTS.offsetX, 0, MAX_OFFSET)),
    offsetY: Math.round(clampNumber(input.offsetY, DEFAULTS.offsetY, 0, MAX_OFFSET)),
    scale: Math.round(clampNumber(input.scale, DEFAULTS.scale, 40, MAX_SCALE)),
    image: typeof input.image === 'string' && input.image.trim() !== ''
      ? input.image.trim().slice(0, MAX_URL)
      : DEFAULTS.image,
    showDetails: typeof input.showDetails === 'boolean' ? input.showDetails : DEFAULTS.showDetails,
    refreshSeconds: Math.round(clampNumber(input.refreshSeconds, DEFAULTS.refreshSeconds, 0, MAX_SECONDS)),
    cacheSeconds: Math.round(clampNumber(input.cacheSeconds, DEFAULTS.cacheSeconds, 0, MAX_SECONDS)),
  }
}

/** @returns 请求里某个查询参数。 */
function queryParam(req, key) {
  const url = String(req.url ?? '')
  const mark = url.indexOf('?')
  if (mark < 0) return undefined
  const value = new URLSearchParams(url.slice(mark + 1)).get(key)
  return value === null ? undefined : value
}

/** 货币符号。 */
function symbolOf(currency) {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return ''
}

/**
 * 从任意 JSON/文本里把"那个数字"捞出来。
 *
 * 认这些形状：裸数字、`"12.34"`、`{balance}`、`{data:{balance}}`，
 * 以及 total / amount / remaining 这几个常见别名。**换 API 时先看这里**：
 * 你的接口字段名不在列表里，就在 `KEYS` 里加一个。
 * @param payload - 已解析的响应体（或字符串）。
 * @returns 数字，或 null。
 */
export function pickNumber(payload) {
  const KEYS = ['balance', 'total', 'amount', 'remaining', 'available']
  const fromObject = (obj, depth) => {
    if (obj === null || typeof obj !== 'object' || depth > 2) return null
    for (const key of KEYS) {
      const raw = obj[key]
      if (raw === undefined || raw === null) continue
      const value = Number(raw)
      if (Number.isFinite(value)) return value
    }
    return fromObject(obj.data, depth + 1)
  }
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload
  if (typeof payload === 'string') {
    const value = Number(payload.trim())
    if (Number.isFinite(value)) return value
    try {
      const parsed = JSON.parse(payload)
      // 接口把数字包成 JSON 字符串（`"12.34"`）也是常见写法，一并认掉。
      if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : null
      if (typeof parsed === 'string') {
        const nested = Number(parsed.trim())
        return Number.isFinite(nested) ? nested : null
      }
      return fromObject(parsed, 0)
    } catch {
      return null
    }
  }
  return fromObject(payload, 0)
}

/** 小数位交给调用方，这里只负责"别把 43.7930418600000000 这种定点串端出去"。 */
function formatAmount(value, decimals = 2) {
  return Number.isFinite(value) ? value.toFixed(decimals) : null
}

/**
 * 读 DSH 自己的 DeepSeek 账号钱包。
 * @param account - `ctx.deepseekAccount`，可能不存在。
 * @param client - 请求方元信息（版本 / 语言 / 时区）。
 * @returns 统一的余额结果。
 */
async function readAccount(account, client) {
  if (account === undefined || account === null) {
    return { signedIn: false, balance: null, symbol: '', currency: '', bonus: null, error: 'account-service-missing' }
  }
  const view = await account.getState()
  if (view === null || view.status !== 'credential-stored') {
    return { signedIn: false, balance: null, symbol: '', currency: '', bonus: null, error: null }
  }
  const details = await account.getBalance(client)
  if (details === null || details === undefined) {
    return { signedIn: true, balance: null, symbol: '', currency: '', bonus: null, error: 'signed-out-during-query' }
  }
  if (details.status !== 'ready') {
    return { signedIn: true, balance: null, symbol: '', currency: '', bonus: null, error: 'balance-unavailable' }
  }
  const wallet = Array.isArray(details.value) && details.value.length > 0 ? details.value[0] : null
  const bonusWallet = Array.isArray(details.bonusWallets) && details.bonusWallets.length > 0 ? details.bonusWallets[0] : null
  const currency = wallet !== null && typeof wallet.currency === 'string' ? wallet.currency : 'CNY'
  return {
    signedIn: true,
    balance: wallet === null ? '0.00' : formatAmount(Number(wallet.balance)) ?? String(wallet.balance),
    symbol: symbolOf(currency),
    currency,
    bonus: bonusWallet === null ? null : formatAmount(Number(bonusWallet.balance)) ?? String(bonusWallet.balance),
    error: null,
  }
}

/**
 * 去问一个任意 HTTP 接口。
 * @param url - 接口地址。
 * @returns 统一的余额结果。
 */
async function readUrl(url) {
  if (url === '') return { signedIn: true, balance: null, symbol: '', currency: '', bonus: null, error: 'url-not-configured' }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: { accept: 'application/json, text/plain, */*' },
  })
  if (!response.ok) {
    return { signedIn: true, balance: null, symbol: '', currency: '', bonus: null, error: `http-${response.status}` }
  }
  const text = await response.text()
  const value = pickNumber(text)
  if (value === null) {
    return { signedIn: true, balance: null, symbol: '', currency: '', bonus: null, error: 'no-number-in-response' }
  }
  return { signedIn: true, balance: formatAmount(value), symbol: '', currency: '', bonus: null, error: null }
}

/** 固定值来源：纯粹用来试样式。 */
function readFixed(options) {
  const value = Number(options.fixedValue)
  return {
    signedIn: true,
    balance: Number.isFinite(value) ? formatAmount(value) : null,
    symbol: options.fixedSymbol,
    currency: '',
    bonus: null,
    error: Number.isFinite(value) ? null : 'fixed-value-not-a-number',
  }
}

/**
 * 解析要供出去的那张图。
 * @param reference - 配置里的 image。
 * @returns 远程地址交给页面自取；本地文件返回绝对路径。
 */
function resolveImage(reference) {
  if (/^https?:\/\//i.test(reference)) return { remote: reference, path: null }
  const path = isAbsolute(reference) ? reference : join(PACKAGE_DIR, reference)
  return { remote: null, path: existsSync(path) ? path : null }
}

/**
 * 图片的版本号：**文件内容**的短哈希。
 *
 * 这里是踩过的坑：一开始 `?v=` 填的是**路径字符串**，于是三次换图 URL 一个字都没变，
 * 而图片路由又发 `max-age=86400` —— URL 没变 + 缓存一天 = 浏览器压根不发请求，
 * 换完图页面上还是旧的那张。版本号必须跟着**内容**走，不能跟着配置走。
 *
 * 用 mtime+size 当键，变过才重算哈希：230KB 算一次很快，但没必要每个请求都算。
 * @param path - 本地图片绝对路径；没有图时给 'missing'。
 * @returns 12 位十六进制串。
 */
function imageVersion(path) {
  if (path === null) return 'missing'
  try {
    const stats = statSync(path)
    const key = `${stats.mtimeMs}:${stats.size}`
    if (key !== versionCache.key) {
      versionCache.value = createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 12)
      versionCache.key = key
    }
    return versionCache.value
  } catch {
    return 'missing'
  }
}

/** 内容哈希的小缓存，键是 mtime+size。 */
const versionCache = { key: '', value: 'missing' }

/** 把图片按 ETag 供出去。 */
function serveImage(res, path, req) {
  if (path === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('image not found')
    return
  }
  let bytes
  let stats
  try {
    stats = statSync(path)
    bytes = readFileSync(path)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('image unreadable')
    return
  }
  const etag = `"${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}"`
  const headers = {
    'Content-Type': 'image/png',
    // 每次都回源校验（没变就 304）。**不要**用 max-age：同名文件是会被整个换掉的，
    // 而客户端在拿到 state 之前会先用不带 ?v= 的裸地址渲染一次——裸地址一旦被长缓存，
    // 每次开页面都会先闪出旧的那张。
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(stats.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(bytes)
}

/**
 * 宿主半入口。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 本行的配置。
 */
export function apply(ctx, rawConfig) {
  const options = normalizeOptions(rawConfig)
  const image = resolveImage(options.image)

  /** 上一次成功读到的东西，连同它的时刻。 */
  let cache = null

  const snapshot = async (force, client) => {
    const now = Date.now()
    if (force !== true && cache !== null && options.cacheSeconds > 0
      && now - cache.at < options.cacheSeconds * 1000) {
      return { ...cache.payload, cached: true }
    }
    let read
    if (options.source === 'account') {
      // 账号服务是可选依赖：没有它也只是"读不到"，不该让挂件起不来。
      read = await readAccount(ctx.get('deepseekAccount'), client)
    } else if (options.source === 'url') {
      read = await readUrl(options.url)
    } else {
      read = readFixed(options)
    }
    const payload = {
      ok: read.error === null,
      version: 1,
      source: options.source,
      ...read,
      fetchedAt: new Date().toISOString(),
      cached: false,
      options: {
        enabled: options.enabled,
        corner: options.corner,
        offsetX: options.offsetX,
        offsetY: options.offsetY,
        scale: options.scale,
        showDetails: options.showDetails,
        refreshSeconds: options.refreshSeconds,
        // 远程图直接给地址；本地图走我们自己的路由，版本号取**内容哈希**
        // （见 imageVersion 的说明：跟路径走的版本号等于没有版本号）。
        image: image.remote ?? `${IMAGE_ROUTE}?v=${imageVersion(image.path)}`,
      },
    }
    // 只有"问到了东西"才写缓存：把一次失败缓存二十秒，等于把故障延长二十秒。
    if (read.error === null) cache = { at: now, payload }
    return payload
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const tz = Number(queryParam(req, 'tz'))
        const client = {
          version: '1.0.0',
          locale: queryParam(req, 'locale') ?? 'zh-CN',
          timezoneOffsetSeconds: Number.isFinite(tz) ? Math.round(tz) : -new Date().getTimezoneOffset() * 60,
        }
        let body
        try {
          body = await snapshot(queryParam(req, 'refresh') === '1', client)
        } catch (error) {
          // 远端、网络、凭据——任何一处出问题都只变成一条 error 字段，页面照常渲染。
          body = {
            ok: false, version: 1, source: options.source,
            signedIn: false, balance: null, symbol: '', currency: '', bonus: null,
            fetchedAt: new Date().toISOString(), cached: false, options: { ...options, image: image.remote ?? IMAGE_ROUTE },
            error: (error && (error.name || error.message)) || 'unknown',
          }
        }
        // 这一行是"页面那半到底跑起来没有"唯一的外部证据。
        ctx.logger.info(`dsh-priestess-companion: state served -> ${
          body.error !== null && body.error !== undefined
            ? `error=${body.error}`
            : body.balance === null
              ? (body.signedIn === true ? 'no-balance' : 'signed-out')
              : `${body.symbol}${body.balance}${body.cached ? ' (cached)' : ''}`}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(JSON.stringify(body))
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: IMAGE_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        serveImage(res, image.path, req)
      },
    }))

    ctx.logger.info(`dsh-priestess-companion: ready (source=${options.source}, image=${image.remote ?? image.path ?? 'MISSING'})`)
  })
}

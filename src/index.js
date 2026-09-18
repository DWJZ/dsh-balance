/**
 * dsh-balance — host half.
 *
 * Registers the `/balance` command, which reads the DeepSeek account balance
 * from the platform's `/user/balance` endpoint and renders it as the command's
 * text answer.
 *
 * The key is resolved on every invocation — config `apiKey` first, then the
 * credentials reference `apiKeyRef`, then the process environment — so a key
 * rotated through the credentials provider reaches the next `/balance` without
 * a restart. A short-lived cache keeps a burst of invocations from becoming a
 * burst of API calls; `/balance refresh` bypasses it.
 *
 * The plugin imports nothing at runtime, so it installs from a git checkout
 * with no dependency step.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-balance'

/** The command registry answers `/balance`. */
export const inject = ['commands']

/** Defaults for every deployment-varying setting; each is changeable from cordis.yml. */
const DEFAULTS = {
  apiKey: '',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 10000,
  cacheMs: 30000,
}

/**
 * Read one non-empty string setting.
 * @param value - raw value from cordis.yml.
 * @param fallback - value used when the setting is absent.
 * @param field - setting name, named in the failure.
 * @returns the validated string.
 */
function stringSetting(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`dsh-balance: config ${field} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one numeric setting.
 * @param value - raw value from cordis.yml.
 * @param fallback - value used when the setting is absent.
 * @param field - setting name, named in the failure.
 * @param minimum - smallest accepted value.
 * @returns the validated number.
 */
function numberSetting(value, fallback, field, minimum) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`dsh-balance: config ${field} must be a number >= ${String(minimum)}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Normalize the plugin configuration, failing loud on an unusable value.
 * @param config - raw config object from cordis.yml, possibly absent.
 * @returns the settings this plugin runs with.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  return {
    apiKey: stringSetting(raw.apiKey, DEFAULTS.apiKey, 'apiKey'),
    apiKeyRef: stringSetting(raw.apiKeyRef, DEFAULTS.apiKeyRef, 'apiKeyRef'),
    baseUrl: stringSetting(raw.baseUrl, DEFAULTS.baseUrl, 'baseUrl'),
    timeoutMs: numberSetting(raw.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs', 1000),
    cacheMs: numberSetting(raw.cacheMs, DEFAULTS.cacheMs, 'cacheMs', 0),
  }
}

/** Currency symbols used when the platform reports a known currency. */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

/**
 * Format one amount with two decimals and thousands separators.
 * @param value - the numeric amount.
 * @returns the formatted amount, without a currency symbol.
 */
function formatAmount(value) {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Render one balance figure with its currency.
 * @param balance - one normalized balance entry.
 * @returns the amount and its currency symbol or code.
 */
function formatMoney(balance) {
  const symbol = CURRENCY_SYMBOLS[balance.currency]
  return symbol === undefined
    ? `${formatAmount(balance.total)} ${balance.currency}`
    : `${symbol}${formatAmount(balance.total)}`
}

/**
 * Normalize one `/user/balance` response body.
 * @param data - parsed response body.
 * @returns account availability and one entry per reported currency.
 */
function normalizeBalance(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  return {
    isAvailable: data?.is_available === true,
    balances: infos.map((info) => ({
      currency: typeof info?.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
      total: toAmount(info?.total_balance),
      granted: toAmount(info?.granted_balance),
      toppedUp: toAmount(info?.topped_up_balance),
    })),
  }
}

/**
 * Coerce one API amount to a finite number; an unparseable amount reads as zero.
 * @param value - the raw amount.
 * @returns the number, or 0 when it is not finite.
 */
function toAmount(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

/**
 * Render one successful reading as the command's answer.
 * @param reading - the normalized response and when it was fetched.
 * @param ageMs - how old the reading is at render time.
 * @param servedFromCache - whether this answer reused a cached reading.
 * @returns the text shown by the dispatching UI.
 */
export function formatReading(reading, ageMs, servedFromCache) {
  const at = new Date(reading.fetchedAt)
  const stamp = `${at.toLocaleDateString('zh-CN')} ${at.toLocaleTimeString('zh-CN', { hour12: false })}`
  const lines = [`DeepSeek 账户余额（${reading.isAvailable ? '可用' : '不可用'}）`]
  // The platform lists every currency it knows, including empty ones; a
  // zero-balance line only earns space when there is nothing else to show.
  const funded = reading.balances.filter((balance) => balance.total > 0)
  const shown = funded.length > 0 ? funded : reading.balances
  if (shown.length === 0) {
    lines.push('平台未返回任何币种的余额。')
  }
  for (const balance of shown) {
    lines.push(`${balance.currency} 总余额 ${formatMoney(balance)} · 充值 ${formatMoney({ ...balance, total: balance.toppedUp })} · 赠送 ${formatMoney({ ...balance, total: balance.granted })}`)
  }
  const age = ageMs < 1000 ? '刚刚' : `${String(Math.round(ageMs / 1000))} 秒前`
  lines.push(`读取于 ${stamp}（${age}${servedFromCache ? '，来自缓存' : ''}）`)
  return lines.join('\n')
}

/**
 * Resolve the API key for one invocation, re-reading the credentials provider
 * every time so a rotated key is picked up without a restart.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param runtime - resolved plugin configuration.
 * @returns the key, or an empty string while none is configured.
 */
async function resolveKey(ctx, runtime) {
  if (runtime.apiKey !== '') return runtime.apiKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(runtime.apiKeyRef)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') return hit.value
    }
    catch {
      // An unresolvable reference is an unconfigured key; the caller reports that.
    }
  }
  return process.env[runtime.apiKeyRef] ?? ''
}

/**
 * Fetch and normalize the account balance.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param runtime - resolved plugin configuration.
 * @returns a discriminated outcome; `ok` carries the normalized reading.
 */
async function fetchBalance(ctx, runtime) {
  const key = await resolveKey(ctx, runtime)
  if (key === '') return { kind: 'missing-key' }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, runtime.timeoutMs)
  try {
    const response = await fetch(`${runtime.baseUrl.replace(/\/+$/u, '')}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { kind: 'http-error', status: response.status }
    const data = await response.json()
    const normalized = normalizeBalance(data)
    return { kind: 'ok', reading: { ...normalized, fetchedAt: Date.now() } }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'network-error', message }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Render one failure outcome as the command's error text.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param runtime - resolved plugin configuration.
 * @param outcome - a non-`ok` fetch outcome.
 * @returns the message shown by the dispatching UI.
 */
function failureText(ctx, runtime, outcome) {
  switch (outcome.kind) {
    case 'missing-key':
      return `没有找到 API Key：请设置 ${runtime.apiKeyRef}（$DSH_HOME/.credentials.yaml 或环境变量），或在插件配置里写 apiKey。`
    case 'http-error':
      ctx.logger.warn(`dsh-balance: DeepSeek API answered HTTP ${String(outcome.status)}`)
      return `DeepSeek 返回 HTTP ${String(outcome.status)}（${outcome.status === 401 ? 'API Key 无效或已失效' : '接口暂时不可用'}）。`
    case 'network-error':
      ctx.logger.warn(`dsh-balance: balance request failed: ${outcome.message}`)
      return `余额查询失败：${outcome.message}`
    /* v8 ignore next 2 -- the failure union is closed and every member is handled above */
    default:
      throw new TypeError(`unknown balance failure: ${String(outcome)}`)
  }
}

/**
 * Register `/balance` with a cache in front of the platform API.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param config - validated plugin configuration from cordis.yml.
 */
export function apply(ctx, config) {
  const runtime = resolveConfig(config)
  let cached = null
  let inflight = null

  /**
   * Read the balance, reusing a fresh cached reading unless forced.
   * @param force - whether to bypass the cache.
   * @returns the fetch outcome and whether it came from the cache.
   */
  const read = async (force) => {
    if (!force && cached !== null && Date.now() - cached.reading.fetchedAt < runtime.cacheMs) {
      return { outcome: { kind: 'ok', reading: cached.reading }, fromCache: true }
    }
    if (inflight === null) {
      inflight = fetchBalance(ctx, runtime).finally(() => { inflight = null })
    }
    const outcome = await inflight
    if (outcome.kind === 'ok') cached = { reading: outcome.reading }
    // A failed refresh answers with the last good reading when there is one,
    // so a transient outage does not hide the balance entirely.
    if (outcome.kind !== 'ok' && cached !== null) {
      return { outcome: { kind: 'ok', reading: cached.reading }, fromCache: true, degraded: outcome }
    }
    return { outcome, fromCache: false }
  }

  ctx.commands.register({
    name: 'balance',
    description: 'Show the DeepSeek account balance',
    input: { hint: '[refresh]' },
    handler: async (invocation) => {
      const argument = invocation.rawInput.trim().toLowerCase()
      if (argument !== '' && argument !== 'refresh') {
        return { kind: 'error', text: `用法：/balance [refresh]` }
      }
      const { outcome, fromCache, degraded } = await read(argument === 'refresh')
      if (outcome.kind !== 'ok') return { kind: 'error', text: failureText(ctx, runtime, outcome) }
      const ageMs = Date.now() - outcome.reading.fetchedAt
      const text = formatReading(outcome.reading, ageMs, fromCache)
      return {
        kind: 'success',
        text: degraded === undefined
          ? text
          : `${text}\n（本次刷新失败，显示的是上一次成功读取）`,
      }
    },
  })
}

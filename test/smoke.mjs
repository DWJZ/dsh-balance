/**
 * dsh-balance smoke test — drives the `/balance` handler against a stubbed
 * platform API, with no host and no network.
 *
 * Usage: `node test/smoke.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** Platform response body with one CNY balance. */
const BALANCE_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

/** One recording fetch stub; `answers` is consumed in order. */
function stubFetch(answers) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer instanceof Error) throw answer
    return {
      ok: answer.status === 200,
      status: answer.status,
      json: async () => answer.body,
    }
  }
  return calls
}

/** One Cordis-shaped context with an injected key and captured registration. */
function makeContext({ resolveKey } = {}) {
  const context = {
    logger: { warn: () => {} },
    commands: { register: (definition) => { context.definition = definition; return () => {} } },
    get: (service) => (service === 'credentials' ? { resolve: resolveKey ?? (async () => ({ value: 'test-key' })) } : undefined),
  }
  return context
}

const invoke = async (context, rawInput = '') => context.definition.handler({ rawInput, attachments: [], signal: new AbortController().signal })

console.log('config')
const defaults = plugin.resolveConfig(undefined)
check('defaults fill every setting', defaults.apiKeyRef === 'DEEPSEEK_API_KEY' && defaults.baseUrl === 'https://api.deepseek.com' && defaults.timeoutMs === 10000 && defaults.cacheMs === 30000, JSON.stringify(defaults))
check('a configured value wins', plugin.resolveConfig({ cacheMs: 0 }).cacheMs === 0)
let threw = false
try {
  plugin.resolveConfig({ timeoutMs: 10 })
}
catch {
  threw = true
}
check('an out-of-range setting fails loud', threw)
threw = false
try {
  plugin.resolveConfig({ baseUrl: '' })
}
catch {
  threw = true
}
check('an empty string setting fails loud', threw)

console.log('command')
const successContext = makeContext()
plugin.apply(successContext, {})
check('apply registers /balance', successContext.definition?.name === 'balance' && typeof successContext.definition.handler === 'function')
check('the command advertises its argument', successContext.definition.input?.hint === '[refresh]')

const calls = stubFetch([{ status: 200, body: BALANCE_BODY }])
let result = await invoke(successContext)
check('a successful read reports success', result.kind === 'success', JSON.stringify(result))
check('the answer carries the formatted total', result.text.includes('¥110.00'), result.text)
check('the answer splits topped-up from granted', result.text.includes('充值 ¥100.00') && result.text.includes('赠送 ¥10.00'), result.text)
check('the answer states availability', result.text.includes('可用'), result.text)
check('the request targets /user/balance', calls[0].url === 'https://api.deepseek.com/user/balance', calls[0].url)
check('the request authenticates with the resolved key', calls[0].options.headers.authorization === 'Bearer test-key', JSON.stringify(calls[0].options.headers))

await invoke(successContext)
check('a second call reuses the cache', calls.length === 1, `fetches=${String(calls.length)}`)
await invoke(successContext, 'refresh')
check('/balance refresh bypasses the cache', calls.length === 2, `fetches=${String(calls.length)}`)

console.log('empty currencies')
const twoCurrencies = stubFetch([{
  status: 200,
  body: {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
    ],
  },
}])
const funded = makeContext()
plugin.apply(funded, {})
const fundedText = (await invoke(funded)).text
check('a zero-balance currency is hidden while another is funded', fundedText.includes('CNY') && !fundedText.includes('USD'), fundedText)
check('exactly one platform request was made', twoCurrencies.length === 1, `fetches=${String(twoCurrencies.length)}`)

stubFetch([{ status: 200, body: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] } }])
const empty = makeContext()
plugin.apply(empty, {})
check('an all-zero account still reports its currency', (await invoke(empty)).text.includes('USD'), 'empty account')

console.log('failures')
const missingKey = makeContext({ resolveKey: async () => undefined })
plugin.apply(missingKey, {})
result = await invoke(missingKey)
check('a missing key is an error that names the reference', result.kind === 'error' && result.text.includes('DEEPSEEK_API_KEY'), JSON.stringify(result))

stubFetch([{ status: 401, body: {} }])
const unauthorized = makeContext()
plugin.apply(unauthorized, {})
result = await invoke(unauthorized)
check('HTTP 401 explains the key state', result.kind === 'error' && result.text.includes('401') && result.text.includes('API Key'), JSON.stringify(result))

stubFetch([new Error('socket hang up')])
const offline = makeContext()
plugin.apply(offline, {})
result = await invoke(offline)
check('a transport failure is reported', result.kind === 'error' && result.text.includes('socket hang up'), JSON.stringify(result))

await invoke(offline, 'refresh')
check('an unknown argument is refused', (await invoke(offline, 'nonsense')).text.includes('用法'), 'usage')

console.log('stale reading')
stubFetch([{ status: 200, body: BALANCE_BODY }, { status: 500, body: {} }])
const flaky = makeContext()
plugin.apply(flaky, {})
await invoke(flaky)
result = await invoke(flaky, 'refresh')
check('a failed refresh still shows the previous reading', result.kind === 'success' && result.text.includes('¥110.00'), JSON.stringify(result))
check('and says so', result.text.includes('上一次成功读取'), result.text)

threw = false
try {
  await invoke(flaky, 'anything')
}
catch {
  threw = true
}
check('an unknown argument never throws', threw === false)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

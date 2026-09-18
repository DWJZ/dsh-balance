---
description: "dsh-balance: the /balance command shows the DeepSeek account balance inside a session."
---

# dsh-balance

English | [中文](README.zh.md)

The `/balance` command for DeepSeek Harness: reads the DeepSeek account balance and answers in the session, without a browser panel or a settings page.

```
/balance
DeepSeek 账户余额（可用）
CNY 总余额 ¥293.58 · 充值 ¥293.58 · 赠送 ¥0.00
读取于 2026/9/18 13:20:41（刚刚）
```

## What it does

- Registers `/balance` with the command registry. The answer is the command's own text, so it renders in the session that invoked it and never reaches the model.
- Reads `GET {baseUrl}/user/balance` with the resolved API key and reports every funded currency, with the topped-up and granted parts of each.
- `/balance refresh` bypasses the cache.
- The key is resolved per invocation: config `apiKey`, then the credentials reference `apiKeyRef` (`DEEPSEEK_API_KEY` by default — `$DSH_HOME/.credentials.yaml` or the process environment). A rotated key reaches the next invocation without a restart.
- A failed refresh still shows the last successful reading and says so, instead of hiding a known balance behind a transient outage.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:DWJZ/dsh-balance

# local development (the profile links the checkout, so edits apply on restart)
dsh plugin --profile web add link:/path/to/dsh-balance
```

## Configuration

Optional; write it into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-balance
  config:
    apiKey: ''                        # explicit key; empty means "use apiKeyRef"
    apiKeyRef: DEEPSEEK_API_KEY       # credentials / environment reference
    baseUrl: https://api.deepseek.com
    timeoutMs: 10000
    cacheMs: 30000                    # how long one reading answers later calls
```

An unusable value (a non-string reference, a timeout below one second) fails loud at load instead of being silently replaced.

## Test

```sh
node test/smoke.mjs
```

Drives the handler against a stubbed platform API: success formatting, the cache and `/balance refresh`, a missing key, HTTP 401, a transport failure, the stale-reading fallback, and the zero-balance currency rule.

## License

[MIT](LICENSE)

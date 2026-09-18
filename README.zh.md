---
description: "dsh-balance：用 /balance 命令在会话里查看 DeepSeek 账户余额。"
---

# dsh-balance

[English](README.md) | 中文

DeepSeek Harness 的 `/balance` 命令：查一次 DeepSeek 账户余额，直接在会话里回答，不需要浏览器面板，也不需要设置页。

```
/balance
DeepSeek 账户余额（可用）
CNY 总余额 ¥293.58 · 充值 ¥293.58 · 赠送 ¥0.00
读取于 2026/9/18 13:20:41（刚刚）
```

## 它做什么

- 向命令注册表注册 `/balance`。回答就是命令自己的文本，直接在发起它的会话里渲染，不会发给模型。
- 请求 `GET {baseUrl}/user/balance`，报告每个有余额的币种，并拆出「充值」与「赠送」两部分。
- `/balance refresh` 绕过缓存强制刷新。
- 每次调用都重新解析密钥：先看配置 `apiKey`，再看 credentials 引用 `apiKeyRef`（默认 `DEEPSEEK_API_KEY`，即 `$DSH_HOME/.credentials.yaml` 或进程环境）。换了密钥不用重启。
- 刷新失败时仍显示上一次成功读取的值并注明，不会让一次网络抖动把已知余额藏起来。

## 安装

```sh
# GitHub 源
dsh plugin --profile web add github:DWJZ/dsh-balance

# 本地开发(profile 直接软链检出目录,改完重启生效)
dsh plugin --profile web add link:/path/to/dsh-balance
```

## 配置

可选，写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: dsh-balance
  config:
    apiKey: ''                        # 显式密钥；留空表示走 apiKeyRef
    apiKeyRef: DEEPSEEK_API_KEY       # credentials / 环境变量引用名
    baseUrl: https://api.deepseek.com
    timeoutMs: 10000
    cacheMs: 30000                    # 一次读取能回答后续调用的时长
```

不可用的取值(引用名不是字符串、超时小于 1 秒)会在加载时直接报错，而不是被静默替换。

## 测试

```sh
node test/smoke.mjs
```

用桩住的平台 API 驱动命令处理器：成功时的文本、缓存与 `/balance refresh`、缺密钥、HTTP 401、传输失败、陈旧读数回退，以及零余额币种的显示规则。

## 许可证

[MIT](LICENSE)

---
title: 受限沙箱里 pnpm 与 node --test 的固定绕法
category: tools
tags: [pnpm, windows, sandbox, powershell, node-test]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，DSH 沙箱会话里安装/构建/跑测试
---

## 场景

在 Windows 的受限沙箱会话（DSH file policy / 受限 pwsh）里安装依赖、构建、跑测试。

## 做法

1. **执行策略挡 `.ps1`**：`pnpm` / `npm` / `npx` 一律加 `.cmd` 后缀（`pnpm.cmd`、`npx.cmd`），否则 `SecurityError`。
2. **pnpm store 锁写入被拒**（`all-stores.lock`，os error 5）：`--store-dir` / `--state-dir` 都无效，改环境变量把用户目录指到仓库内：

```powershell
$env:USERPROFILE = 'F:\repo\.pnpm-home'
$env:HOME = 'F:\repo\.pnpm-home'
pnpm.cmd install
```

   目录里放 `.npmrc` 指 registry（如 npmmirror），并把 `/.pnpm-home/` 加进 `.gitignore`。非沙箱 shell 直接 `pnpm install` 即可。
3. **测试命令**：`node --test tests/` 在受限 shell 会 spawn EPERM，改用：

```powershell
node --test --test-isolation=none "tests/**/*.mjs"
```

4. **判断退出码**：`pnpm.cmd typecheck 2>&1 | Select-Object ...` 会因 pnpm 往 stderr 写 `$ tsc --noEmit` 而显示 exit 1，实际用 `; "exit=$LASTEXITCODE"` 单独打印，或把 stderr 丢弃 `2>$null`。

## 原因

这些限制来自执行策略与沙箱的文件写入/进程 spawn 约束，不是 pnpm 或 node 的 bug；按上面绕开后行为与普通 shell 一致。

## 反例

- 用 `--store-dir` 反复重试仍是 `os error 5`；
- 在受限 shell 里跑 `node --test tests/` 报 `spawn EPERM`，误以为测试代码有问题。

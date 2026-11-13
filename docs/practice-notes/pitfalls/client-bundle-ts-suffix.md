---
title: 浏览器端 client bundle 引用同包模块要写显式 .ts 后缀
category: pitfalls
tags: [tsdown, rolldown, client-bundle, dsh, module-loader]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，client 引用 helpers 的打包排错
---

## 场景

DSH 打包插件的浏览器端入口 `src/client/index.tsx`（产出 `lib/client.js`，CJS ModuleLoader 闭包）需要引用同包的 `src/helpers.ts`，例如 `cachedSuffix`。

## 做法

```ts
import { cachedSuffix } from '../helpers.ts'   // 显式 .ts
```

而不是 `from '../helpers'`。

## 原因

client bundle 走浏览器模块加载器，裸写 `'../helpers'` 在产物里会残留一条 `require("../helpers")`，运行时该 specifier 不存在而失败。写 `.ts` 让 bundler 在构建期识别源文件并内联进同一个 bundle。宿主侧（`src/index.ts`，node ESM）则相反，产出独立 `lib/helpers.js`，运行时按 `.js` 解析。

## 反例

- 产物 `lib/client.js` 里出现 `require("../helpers")` → 面板报错、`cachedSuffix` undefined。
- 改 `'../helpers'` 后 tsdown 报 `[UNRESOLVED_IMPORT] Could not resolve "./helpers.js" in src/index.ts`：这是 **host 侧**的 warning，无害，产物仍独立生成 `lib/helpers.js`；不要为消警告去改 import。

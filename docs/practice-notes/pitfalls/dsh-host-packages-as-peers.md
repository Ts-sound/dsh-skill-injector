---
title: DSH 打包插件的宿主接口包必须放 peerDependencies
category: pitfalls
tags: [dsh, pnpm, peer-dependencies, plugin]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，原版 skill-injector-plugin 故障分析 + 本项目修复 7f4e083
---

## 场景

写 DSH 打包型插件（`dsh.bundle.patch` + `dsh.client`），代码里 import `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-llm` 这类**宿主提供的接口包**，需要决定它们写在 `dependencies` 还是 `peerDependencies`。

## 做法

宿主接口包只进 `peerDependencies`，不进 `dependencies`：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-skill": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-llm": ">=0.2.0-rc.1 <0.3.0-0"
},
"devDependencies": {
  "@deepseek-ai/dsh-skill": "^0.2.1-rc.5",
  "@deepseek-ai/dsh-llm": "^0.2.1-rc.5"
}
```

- peer 范围要能覆盖宿主当前 0.2.x 各 rc（`^0.2.1-rc.5` 匹配不到 `0.2.2-rc.x`）；
- 同时留在 devDependencies 供本地构建/typecheck/测试；
- 普通库（如 `@deepseek-ai/schemastery`）不是宿主服务，留在 dependencies 没问题；
- 构建时把 peer 外置（tsdown 默认 external peer），产物里保持裸 import。

安装后验证：profile 目录下不应出现被平铺的宿主包：

```powershell
Get-ChildItem C:\Users\<user>\.dsh\profiles\web\node_modules\@deepseek-ai -ErrorAction SilentlyContinue
```

## 原因

宿主包写进 dependencies，pnpm 会把它装进 profile 的 `node_modules/@deepseek-ai/`，宿主启动时优先解析到这份**旧副本**；版本不兼容触发兼容性预检，内置 `skills` 等服务被禁用，于是所有 skills 消费者卡住。peer 声明把"这份由宿主提供"的语义交给宿主，不再重复安装。

## 反例

原版 `skill-injector-plugin@1.2.0` 的故障链：

1. dependencies 里 `@deepseek-ai/dsh-skill: ^0.2.1-rc.5`；
2. pnpm 平铺 0.2.1-rc.5 到 profile `node_modules/@deepseek-ai/`；
3. 宿主加载旧副本 → 兼容性预检禁用内置 skill 服务；
4. 所有 skills 消费者停在 `pending (waiting for service: skills)`，插件自己也列不出技能。

例外说明：用 `link:` 方式安装时 pnpm 不为 link 依赖安装其 deps，所以本地 link 安装**看不出**这个坑——只有按 registry 普通安装才复现。

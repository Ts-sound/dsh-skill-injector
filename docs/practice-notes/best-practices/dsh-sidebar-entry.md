---
title: DSH 插件接入主界面侧边栏的两个关键约定
category: best-practices
tags: [dsh, sidebar, slots, cordis, layout]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，dsh-skill-injector 侧边栏入口 + 全局面板（提交 039a41a 前身）
---

## 场景

想让打包型 DSH 插件在左侧导航栏加一行入口，点开是一个全局面板（而不是只藏在设置页里）。

## 做法

1. 行：`sidebar.panellist`（list root slot），注册选项 `{ id, order, label }`，组件 props `{ size, active }`；点击时侧边栏自动调 `ctx.layout.selectPanel(id)`。
2. 面板：`main` keyed slot，`key` **必须与行 id 完全相同**：

```ts
slots.inject('sidebar.panellist', () =>
  slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: 'Skill Injector' }, Row),
)
slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel))
```

3. 返回会话：`ctx.get('layout')?.selectPanel(null)`。
4. 注册**不要**包 `ctx.effect`：`slots.inject` 自带生命周期（回调内的注册在声明折叠时销毁、恢复时重装）。

## 原因

`main` 面板靠 key 与行 id 绑定，错一个字符 `selectPanel` 就抛 `main panel "x" is not registered`。`ctx.effect` 在 cordis 里要求回调返回 disposer，把注册塞进去会 TS2769，且与 slot 生命周期重复。

## 反例

- 只注册 `main` 未注册 `sidebar.panellist`：行不存在，没有任何入口。
- 行 id 与面板 key 不一致：点行直接 throw，面板永远打不开。
- 用 `ctx.effect(() => { slots.register(...) })`：类型报错，或注册被提前销毁。

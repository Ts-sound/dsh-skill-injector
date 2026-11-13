---
title: 判断运行中的 DSH 加载的是哪份代码
category: tools
tags: [dsh, debugging, http, restart]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，面板显示旧字段（缺 path/source/workspaces）时的排查
---

## 场景

改了插件代码，界面上行为却像旧版本：字段缺失、新 UI 不出现、或怀疑宿主加载了旧构建。

## 做法

1. **认准真运行时端口**：`npx @deepseek-ai/dsh web` 起的服务是 `http://127.0.0.1:3080`，插件路由由它提供。桌面 GUI 的 `127.0.0.1:58441` 只是外壳，对插件路由返回 404、对 `/api` 返回 401，**不能用来探活**。
2. **分层判断刷新还是重启**：
   - client bundle（`lib/client.js`）在页面刷新时从磁盘重新读 → 改前端只要刷新页面；
   - host 半（`lib/index.js`）由进程加载 → 必须完整退出并重启 DSH。
3. **用字段形态探活**，比看版本号可靠：

```powershell
$j = (Invoke-WebRequest 'http://127.0.0.1:3080/dsh-skill-injector/api' -UseBasicParsing).Content | ConvertFrom-Json
($j.PSObject.Properties.Name | Sort-Object) -join ','
```

出现新加的字段（如 `workspaces`、`effective`）说明宿主已加载新构建；只有 `name, description` 这类旧形态说明宿主是旧的。

4. 确认 profile 用的是本地仓库：`link:` 安装时 `profiles/web/node_modules/<pkg>` 是 Junction，`lib/` 即时可见，重启即生效。

## 原因

前端与宿主是两套加载/缓存机制，混在一起判断会把"宿主未重启"误判成"代码没生效"，白改一轮代码。

## 反例

面板里所有技能都落在 `Other (37)`：客户端已按 `path` 分组，但宿主返回的 `available[]` 只有 name/description——旧宿主没透传 `path`。修宿主代码后没重启，刷新页面依旧全在 Other。

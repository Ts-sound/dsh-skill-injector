# AGENTS.md — Guide for AI agents

`dsh-skill-injector` 是一个打包型 **Cordis 插件（DSH 0.2.x）**：把用户选中的技能注入会话——`each-prompt`（每次组装系统提示时由 `systemPrompt.section` 渲染）或 `start-only`（`agent/created` 时 `agent.inject()` 一条去重的 `skill-invocation` 消息）。宿主半声明 Loader **Config**（`mode`/`selected`/`showDock`）、经 `GET /dsh-skill-injector/api` + `PUT /dsh-skill-injector/api/config` 提供快照与写入；客户端半 5s 轮询，渲染 `settings.section` 与 `conversation.composer.dock`。客户端↔宿主只有 **HTTP** 一条缝。

目标版本：`@deepseek-ai/dsh-skill` / `dsh-llm` `^0.2.1-rc.5`，`@deepseek-ai/cordis` `^4.0.5`。

## 仓库布局

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主半：`Config`（三字段全 `.volatile()`）、`resolveSelection`（目录快照 + 五态分类 + last-good 正文表）、section（order 150）、两遍 `agent/created` stamp、两条路由。 |
| `src/helpers.ts` | 纯函数（独立构建入口）：`validateSelection`、`escapePromptBraces`、`buildInjectionMessage`、`classifySelection`、`applyBodies`、`cachedSuffix`、`isSkillName`、`MAX_SELECTED`、类型。 |
| `src/client/index.tsx` | 浏览器半：5s 轮询、设置页 `dsh-skill-injector`（order 60）、Dock 行 `dsh-skill-injector-dock`（order 10）。 |
| `cordis.patch.yml` | `dsh.bundle.patch`：插入 `{id: dsh-skill-injector, name: 'dsh-skill-injector'}`。 |
| `tsdown.config.ts` | host → `lib/index.js`、helpers → `lib/helpers.js`、client → `lib/client.js`（CJS ModuleLoader 闭包，bundle id = 包名）。 |
| `tests/invariants.test.mjs` | 16 条行为契约（7 helpers + 9 host），打的是 `lib/` 构建产物。 |
| `tests/fixtures/sample-skill.json` | `ctx.skills.get` 真实返回形状。 |
| `docs/design/README.md` | 设计文档：术语、命名空间、16 条契约、边界场景。 |
| `docs/plans/` | 实施计划（历史记录）。 |

## Key behaviors（不要破坏）

1. **打包插件，不是动态插件**：用 `dsh plugin add` 安装；不要退回 `cordis_define` 形态。
2. **客户端只经 HTTP 与宿主通信**：轮询 `/dsh-skill-injector/api`，PUT `/dsh-skill-injector/api/config`；没有 `harness.handle`/`host.call`。
3. **配置就是 Loader Config，三个字段必须保持 `.volatile()`**：volatile 输出是带 `.get()` 的引用，必须经 `readLive()`/`config()` 读；`settings.update(entryId, patch)` 拒绝非 volatile 字段，Loader 只对纯 volatile 变更**原地提交**并发 `loader/volatile-update`。`entryId` 从 `ctx.get('loader').entries()` 按 `name === 'dsh-skill-injector'` 解析，回退包名。插件自带设置页，故 `settings.configure({ auto: false })`（try/catch 包裹）。
4. **技能正文只从 `ctx.skills` 读**：`skills.snapshot(options)` 拿目录与 `complete`，只为目录里出现的名字 `skills.get`，last-good 放进程内 `Map`（`applyBodies` 仅在 `ready` 时替换）。**查询必须带 live agent 的 scope**（filesystem provider 注册在 agent preset 层）：`{ scope: agent, cwd: agent.session.header.cwd }`。
5. **`{{` 只转义 section 路径**：`renderActiveSkills` 用 `escapePromptBraces(renderSkillContent(...))`；start-only 消息保留原始正文。`renderSkillContent` 需要完整已加载定义。
6. **start-only 去重 + 两遍 stamp**：`alreadyInHistory` 扫本会话 `user/message` 且 `data.source.kind === 'skill-invocation'`；进程内 `injectedByAgent` 兜底。`agent/created` 串行且 create 完成前被 await，所以正确；第二遍 await 解析，上限 `STAMP_RESOLVE_DEADLINE_MS = 3000`，失败或超时只吞掉，绝不让会话创建失败。`historyEvents` 只读 `session.ownEvents()`。
7. **路由任何路径都回 JSON**：200 成功 / 400 非法 / 500 意外；PUT 先 `validateSelection` 再 `settings.update`，回显校验结果并后台预热缓存。路由经 `registerRoute` 注册，重复注册被吞掉（`(kind, path)` 重复会 throw）。
8. **`resolveSelection` 有 in-flight memo**：key = `scoped:`/`unscoped:` + selection，`.finally` 清理；`passSeq` 单调递增，防止晚到的 pass 覆盖新结果。
9. **`injectedByAgent` 上限 200**，超限按最旧驱逐。
10. **`unknown` 是唯一终态失败**：只有“完整且带 scope”的目录读取里确实没有该名字才是 `unknown`；`complete: false` → `unavailable`，无 scope → `no-scope`。快照的 `canRemove` 只有跑过 scoped 解析后才为 true。
11. **scope 要能跨重载恢复**：插件可能被重新 apply，`lookupOptions()` 回退到 `ctx.get('agents').list()` 的最后一个存活 agent，`agent/disposed` 清除记忆中的 agent。

## 命名空间

| 项 | 值 |
| --- | --- |
| 插件名 / 条目名 | `dsh-skill-injector` |
| section | `dsh-skill-injector:active`（order 150） |
| 路由 | `/dsh-skill-injector/api`、`/dsh-skill-injector/api/config` |
| 设置页 id | `dsh-skill-injector`（order 60） |
| Dock id | `dsh-skill-injector-dock`（order 10） |
| CSS 前缀 | `dsi-` |

## 常见任务

- **改轮询间隔**：`POLL_MS = 5000`（`src/client/index.tsx`）。
- **加配置字段**：`Config` 里加 `.volatile()` → `config()` 读取 → 客户端表单 → `tests/invariants.test.mjs` 的契约 8。
- **加注入模式**：`Config.mode` union + `helpers.ts` 的 `MODES` + 宿主分支 + 客户端 radio + 契约测试。
- **重建**：`pnpm install && pnpm build`，再 `pnpm typecheck`。
- **更新已安装的 profile**：重建后重启 DSH（宿主半改动需重启；客户端改动按 lib/client.js 哈希重发）。

## 环境事实（已探明，不要重复探测）

- Windows 受限 shell：`pnpm.ps1`/`npm.ps1` 被执行策略挡住，用 `pnpm.cmd`；pnpm store 锁写入被拒时把 `USERPROFILE`/`HOME` 指到 `.pnpm-home`。
- `webServer.register` 形状 `{kind:'exact'|'prefix', path, handler(req,res)}`，node:http 语义。
- 宿主事件（0.2.x）：`agent/created`（串行、create 前 await、payload `{agent, source}`）、`agent/disposed`、`settings/document-updated(ns, revision)`、`loader/volatile-update`、`skills/change`。`agent/session-start`、`settings/updated` 不存在。
- `agent.session.ownEvents()` 是非弃用的会话日志读法；`agent.session.header.cwd` 仍带工作区路径。
- `renderSkillContent` 来自 `@deepseek-ai/dsh-skill`，`createUserMessage` 来自 `@deepseek-ai/dsh-llm`。
- 可选服务用 `ctx.get(name)`（loader、agents）；只有硬依赖进 `inject`。

## 测试

```bash
pnpm.cmd build
pnpm.cmd typecheck
node --test --test-isolation=none "tests/**/*.mjs"   # 16 条契约
```

测试跑构建产物；受限 shell 下不要用 `node --test tests/`（spawn EPERM）。

手工验收：`GET /dsh-skill-injector/api` 返回 `{ok, mode, selected, available, unresolved, injected, canRemove, showDock}`；设置页保存后下一轮即生效；`start-only` 每个会话只 stamp 一次（冷进程首个会话也是）；删除技能文件后该名字变 `unknown` 且其余照常注入。

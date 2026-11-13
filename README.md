# dsh-skill-injector · 自动向 DeepSeek Harness (DSH) 注入技能

`dsh-skill-injector` 是一个打包型 DSH 插件：把用户选中的技能（如 `caveman`、`ponytail`）自动注入每个会话——要么每轮提示都注入（`each-prompt`），要么只在会话开始时注入一次（`start-only`）。自带设置页与输入区指示行，配置写进 profile，重启后依旧生效。

- 目标版本：DSH **0.2.x**（`@deepseek-ai/dsh-skill` / `dsh-llm` `^0.2.1-rc.5`）
- 技能正文全部来自运行时 `ctx.skills` 注册表，仓库里不存任何技能副本
- 客户端与宿主之间只有 HTTP 一条缝（`/dsh-skill-injector/api`），没有 RPC

## ✨ 功能

| 能力 | 说明 |
| --- | --- |
| 两种注入模式 | `each-prompt` 走 `systemPrompt.section`（每次组装系统提示时重渲染）；`start-only` 在 `agent/created` 时通过 `agent.inject()` 投递一条 `skill-invocation` 用户消息 |
| 多技能选择 | 勾选列表，最多 `16` 个（`MAX_SELECTED`），名字必须是 kebab-case 且符合技能名规则 |
| 实时状态 | 每个被选技能五态：`ready` / `unknown` / `unavailable` / `load-failed` / `no-scope`；只有 `unknown` 是终态失败 |
| 保留 last-good 正文 | 技能文件临时读失败（或发现未完成）时继续注入上一份好正文，只有 `unknown` 会丢弃 |
| 设置页 | `settings.section` id `dsh-skill-injector`（order 60）：勾选、模式、`showDock`、保存、逐条 Retry / Remove |
| 左侧边栏入口 | `sidebar.panellist` id `dsh-skill-injector`（order 10）：图标行，点击切到全局面板 |
| 全局面板 | `main` keyed slot，key `dsh-skill-injector`：顶行是简介 + GitHub 链接，下面复用设置页的选择/模式控件，整体居中（max-width 720px），带「Back to conversation」返回 |
| 按目录分组 | 技能按 `SKILL.md` 所在目录分组（取最近的 `skills` 根之下的相对路径，如 `skills-tong / engineering`；根下的技能与无路径的虚拟技能归入 `Other`），组名后显示条数 |
| 输入区指示 | `conversation.composer.dock` id `dsh-skill-injector-dock`（order 10）：`Injected Skills: … · Mode: … (· N unresolved)`，可在设置页隐藏 |
| 重启存续 | 打包插件，`dsh plugin add` 安装一次，每次 DSH 启动自动加载 |

## 🏗️ 工作原理

```
src/index.ts      宿主半：Config / 解析 / 两遍注入 / HTTP 路由
src/helpers.ts    纯函数（独立构建入口，供单测）：校验、转义、分类、缓存
src/client/index.tsx  浏览器半：5s 轮询 → 设置页 + 侧边栏入口 + 全局面板 + Dock 行
```

1. **配置就是插件的 Loader Config**。`src/index.ts` 导出 schemastery 的 `Config`（`mode` / `selected` / `showDock`），Loader 校验后交给 `apply(ctx, config)`。三个字段都是 `.volatile()`：`settings.update(entryId, patch)` 只接受 volatile 字段，Loader 对纯 volatile 变更**原地提交**并触发 `loader/volatile-update`，不重载插件——因此路由、正文缓存、agent scope 在保存后依然存活。
2. **读技能必须带 agent scope**。`dsh-skill-filesystem` 注册在 agent preset 层，宿主全局查询为空。插件在 `agent/created` 记住 agent，或从 `ctx.get('agents').list()` 恢复最后一个存活 agent，再用 `{ scope: agent, cwd }` 查询。
3. **一次解析 = 一次目录快照 + 逐名加载**。`skills.snapshot(options)` 报告发现是否 `complete`；只为目录里出现的名字 `skills.get(...)`；结果经 `classifySelection` 分五态，经 `applyBodies` 合并进 last-good 表。
4. **并发去重**。同一 selection + scope 的并发解析共享一次飞行中的 pass（`refreshInFlight`）；`passSeq` 保证晚到的 pass 不会覆盖新结果。
5. **两遍 stamp**。`agent/created` 是串行的、create 完成前会被 await：第一遍用热缓存立即注入，第二遍在（最多 3000ms 的）解析之后补齐冷缓存；靠进程内 `injectedByAgent`（上限 200，超限按最旧驱逐）与会话日志去重，恢复会话不会重复注入。
6. **`{{` 只转义 section 路径**。section 文本走严格的 `{{variable}}` 插值，所以 `renderActiveSkills` 用 `escapePromptBraces`；`start-only` 的消息不插值，保留原始正文。

快照结构：`{ ok, mode, selected, available, unresolved, injected, canRemove, showDock }`。

## 🚀 快速开始

```bash
# 在本仓库目录先构建（lib/ 不随仓库分发）
pnpm install && pnpm build

# 安装到 web profile
dsh plugin --profile web add ./dsh-skill-injector
```

安装后重启 DSH，打开 设置 → Skill Injector，勾选技能、选择模式、保存。保存立即生效，不需要重启。

## ⚙️ 配置

配置保存在 profile patch 的本插件条目下（条目名 `dsh-skill-injector`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | `each-prompt` \| `start-only` | `each-prompt` | 每轮注入，还是仅会话开始注入一次 |
| `selected` | `string[]` | `[]` | 选中的技能名，最多 16 个，必须是合法 kebab-case |
| `showDock` | `boolean` | `true` | 是否在输入区上方显示注入指示行 |

体量常量：轮询 `5s`、冷缓存 stamp 等待上限 `3000ms`、每 agent 注入记录上限 `200`、section order `150`。

## ❓ 常见问题

**为什么保存后立刻生效？** 三个字段都是 volatile，Loader 原地换值并通知插件重新解析，不重载条目。

**为什么刚启动时列表是空的？** 还没有任何 agent 提供 scope，所有选中项显示 `no-scope`，`canRemove` 为 false。打开一个会话后自动恢复。

**某个技能显示 `unavailable` / `load-failed`，还要保留吗？** 会保留：这是瞬时状态，last-good 正文仍在注入。只有 `unknown`（一次完整、带 scope 的目录读取里确实没有该名字）才意味着技能不存在，可以直接 Remove。

**删除技能文件后会怎样？** 该名字变成 `unknown`，其余技能继续注入；界面上可 Retry 后 Remove。

**`start-only` 会重复注入吗？** 不会。进程内记录 + 会话日志双重去重，恢复（resume）也不重复；冷缓存靠第二遍 stamp 补齐。

**子代理会话也会注入吗？** 会。插件不区分主会话与子代理。

**能关闭输入区那一行吗？** 可以，设置页取消“Show the injected-skills line under the composer”即可。

## ⚠️ 安全说明

- 插件只读技能注册表里的正文，从不复制、缓存到仓库或跨进程持久化。
- 注入内容只来自用户明确勾选的技能；`each-prompt` 的正文经过 `{{` 转义，不会破坏系统提示插值。
- 客户端只通过同源 HTTP 路由与本插件宿主通信，不接触其他插件的数据。
- HTTP 路由全部返回 JSON（成功 200，非法请求 400，意外 500）；写入前一律经 `validateSelection`（模式白名单、去重、kebab-case、上限 16）。

## 📦 项目结构

```
.
├── src/
│   ├── index.ts           宿主半：Config、解析、两遍注入、路由
│   ├── helpers.ts         纯函数与类型（单测直接打这个构建产物）
│   └── client/index.tsx   浏览器半：设置页 + Dock 行
├── tests/
│   ├── invariants.test.mjs  16 条行为契约（7 helpers + 9 host）
│   └── fixtures/sample-skill.json
├── docs/
│   ├── design/README.md   设计文档（术语、契约清单、边界场景）
│   └── plans/            实施计划
├── cordis.patch.yml       dsh.bundle 挂载行
├── tsdown.config.ts       三个构建入口（host / helpers / client）
└── package.json
```

## 🧪 开发

```bash
pnpm install
pnpm build        # lib/index.js + lib/helpers.js + lib/client.js
pnpm typecheck
node --test --test-isolation=none "tests/**/*.mjs"
```

测试跑的是构建产物，所以先 `pnpm build`。受限 shell 下用上面这条 `node --test` 形式（`node --test tests/` 会因 spawn 被拒）。

## 📄 许可证

MIT。见 [LICENSE](LICENSE)。

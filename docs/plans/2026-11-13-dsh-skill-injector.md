# dsh-skill-injector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 参考 `temp/skill-injector-plugin/` 同功能重构出 `dsh-skill-injector`——契约先行：先移植关键不变量测试，再重写三文件实现。

**Architecture:** DSH 0.2.x 打包 profile 插件，host 半（volatile Config + live `ctx.skills` 读取 + each-prompt section / start-only stamp 两模式 + HTTP 路由）与 client 半（5s 轮询 + 设置页 + dock 行）通过 HTTP-only 接缝连接。全新命名空间（包名/路由/ID/CSS 前缀均带 `dsh-skill-injector` / `dsi-`）。

**Tech Stack:** TypeScript、tsdown（host node ESM + client browser CJS ModuleLoader）、pnpm（`nodeLinker: hoisted`）、node:test、DSH 0.2.x（`@deepseek-ai/dsh-skill@^0.2.1-rc.5`、`dsh-llm`、`schemastery`、`cordis@^4.0.5`、react peer）。

**Testing Scenarios**（来自设计文档边界场景节）:
1. 首个 session 前 GET API → 无 scope：`available: []`、全选技能 `no-scope`、`canRemove: false`
2. 会话中删技能文件 → `unknown` → body 丢弃，其余技能照常注入
3. provider 报错/discovery 未完成 → `unavailable`/`load-failed` → last-good 继续注入
4. 重启后 start-only resume → `ownEvents()` 查旧 stamp → 不双 stamp
5. 空 selected → 不注入，一切正常
6. profile patch 无 config 块 → default `{mode:'each-prompt', selected:[], showDock:true}`

**Boundary Conditions:**
- 路由任何路径均返回 JSON（200/400/500），永不非 JSON 崩溃
- `agent/created`（serial 事件）内 resolve 超 3000ms 放弃 pass2，stamp 抛错吞掉，不 fail 会话创建
- `injectedByAgent` 上限 200 驱逐最老；`passSeq` 防旧 pass 覆盖新 pass
- `{{` 转义仅 section 路径；start-only 消息保持原文
- `MAX_SELECTED=16`、非 kebab 名拒收、重复名去重

**Design doc:** `docs/design/README.md`（术语表、16 条行为契约、精简点、伪代码）。

**原版参考（只读，勿改）:** `temp/skill-injector-plugin/`（src/、tests/、AGENTS.md 行为清单）。

---

## Execution Strategy

全部任务强耦合（同一插件、契约测试贯穿），**顺序执行，不并行**。

- Task 1-2 → 单 subagent（骨架+helpers 红）
- Task 3 → 单 subagent（helpers 绿）
- Task 4 → 单 subagent（host 红）
- Task 5 → 单 subagent（host 绿）
- Task 6 → 单 subagent（client）
- Task 7 → 单 subagent（文档+总验收）

### 环境注意（所有任务通用）

- Windows 受限 shell 下测试用：`node --test --test-isolation=none "tests/**/*.mjs"`（`node --test tests/` 会 spawn EPERM）
- 测试跑的是构建产物：先 `pnpm build` 再 `node --test`
- 原版 AGENTS.md 的 Key behaviors 1-11 是 load-bearing 清单，重写时逐条对照 `temp/skill-injector-plugin/AGENTS.md`

---

### Task 1: 包骨架与构建链

**Files:**
- Create: `package.json`（name `dsh-skill-injector`，version 1.0.0，exports `.`/`./client`，`dsh.bundle.patch`、`dsh.client{platform:'web',inject:[]}`，deps 对齐原版 package.json，keywords 换新）
- Create: `tsdown.config.ts`（host node ESM → `lib/index.js`；helpers node ESM → `lib/helpers.js`；client browser CJS ModuleLoader 闭包 → `lib/client.js`，bundle id = `dsh-skill-injector`，external react）
- Create: `cordis.patch.yml`（插入 `{id: dsh-skill-injector, name: 'dsh-skill-injector'}` 行）
- Create: `pnpm-workspace.yaml`（`nodeLinker: hoisted` + `allowBuilds: {esbuild: false}`）
- Create: `tsconfig.json`、`.gitignore`（追加 `lib/`、`node_modules/`）
- Copy: `LICENSE`（保留仓库现有 MIT）

**Acceptance Criteria:**
- [ ] `pnpm install && pnpm build` 通过（此时 src 可为最小占位：`index.ts` 导出 name/Config/inject/apply 骨架，`helpers.ts`、`client/index.tsx` 空实现）
- [ ] `lib/client.js` 含 ModuleLoader 包装（`id: "dsh-skill-injector"`）

**Verification:** `pnpm build` 退出码 0；`node -e "import('./lib/index.js').then(m=>console.log(m.name))"` 打印 `dsh-skill-injector`。

**Reference:** 原版 `tsdown.config.ts`、`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`。

---

### Task 2: 契约测试红——helpers 部分 + fixture

**Files:**
- Create: `tests/fixtures/sample-skill.json`（从原版拷贝，形状 = `ctx.skills.get` 返回值）
- Create: `tests/invariants.test.mjs` helpers 段（设计文档契约 1-7 条）

**Acceptance Criteria:**
- [ ] 契约 1-7 全部落为断言：validateSelection（去重/>16 拒/非 kebab 拒/非法 mode 拒/showDock 缺省 true）、escapePromptBraces、buildInjectionMessage 形状、classifySelection 五态+「incomplete/unscoped 永不 unknown」、applyBodies 四规则、cachedSuffix 三分支+空、isSkillName 边界
- [ ] 测试 import `../lib/helpers.js`，此刻构建缺函数 → 全红

**Verification:** `pnpm build; node --test --test-isolation=none "tests/**/*.mjs"` → helpers 断言失败数 = 预期红。

**Reference:** 原版 `tests/helpers.test.mjs`（32 条，从中挑契约骨干）、设计文档「行为契约」节。

---

### Task 3: src/helpers.ts 实现（helpers 绿）

**Files:**
- Create: `src/helpers.ts`（从原版 `src/helpers.ts` 移植：重命名无需大改，类型/常量保留 `MAX_SELECTED=16`；可精简注释但保留关键不变量说明）

**Acceptance Criteria:**
- [ ] 契约 1-7 测试全绿
- [ ] 导出面：`validateSelection`、`escapePromptBraces`、`buildInjectionMessage`、`classifySelection`、`applyBodies`、`cachedSuffix`、`isSkillName`、`MAX_SELECTED`、`InjectMode`、`InjectorConfig`、`SkillState`、`ClassifiedSkill`、`CatalogObservation`、`LoadOutcome`

**Verification:** `pnpm build && node --test --test-isolation=none "tests/**/*.mjs"` → 0 失败。

**Reference:** 原版 `src/helpers.ts`（几乎直移）；设计文档行为契约 1-7。

---

### Task 4: 契约测试红——host smoke 部分

**Files:**
- Modify: `tests/invariants.test.mjs`（追加 host 段 = 设计文档契约 8-16 条）

**Acceptance Criteria:**
- [ ] stub ctx（参照原版 `tests/host.test.mjs` 的 fake webServer/settings/skills/systemPrompt/on 形状）驱动 `apply(ctx, config)`
- [ ] 契约 8：Config 三字段 `.volatile()`
- [ ] 契约 9：路由注册 + GET 快照全 JSON、字段齐全（无 `missing`）
- [ ] 契约 10：PUT 合法/非法/非 JSON/异常 → 200 回显/400/400/500 且全 JSON
- [ ] 契约 11：瞬态失败后 section 渲染 last-good；`unknown` 后消失
- [ ] 契约 12：冷缓存两遍 stamp + resume 不双 stamp（fake session `ownEvents()`）
- [ ] 契约 13：`canRemove` 仅 scoped resolve 后 true
- [ ] 契约 14：`agent/disposed` 清 scope、`agents.list()` 恢复
- [ ] 契约 15：`injectedByAgent` 200 上限驱逐
- [ ] 契约 16：`loader/volatile-update` 触发 re-resolve
- [ ] 此刻 → 红

**Verification:** 同上，host 断言失败 = 预期红。

**Reference:** 原版 `tests/host.test.mjs`（10 条 smoke，核心形状照搬、名字换新）；设计文档契约 8-16。

---

### Task 5: src/index.ts host 半实现（host 绿）

**Files:**
- Create: `src/index.ts`（按设计文档重写：替换原版 674 行为 ≤450 行）

**Acceptance Criteria:**
- [ ] 全部精简点落实：`historyEvents` 仅 `ownEvents()`；快照无 `missing`；`settings.configure` 直调（try/catch 包裹）；其余 load-bearing 行为逐条保留（见设计文档「精简点」节）
- [ ] 命名空间：`name='dsh-skill-injector'`、路由 `/dsh-skill-injector/api`(+`/config`)、section `dsh-skill-injector:active`(order 150)
- [ ] 两遍 stamp 伪代码语义与设计文档一致（deadline 3000ms、幂等、stamp 抛错吞掉）
- [ ] in-flight memo（key=scoped/unscoped+selection）+ `passSeq` 保留
- [ ] 契约 8-16 全绿，全套测试 0 失败

**Verification:** `pnpm build && pnpm typecheck && node --test --test-isolation=none "tests/**/*.mjs"` 全绿。

**Reference:** 原版 `src/index.ts` 逐段对照重写；原版 AGENTS.md Key behaviors 1-11；设计文档伪代码节。

---

### Task 6: client 半 src/client/index.tsx

**Files:**
- Create: `src/client/index.tsx`（≤300 行；替换原版 354 行）

**Acceptance Criteria:**
- [ ] 5s 轮询 `fetch('/dsh-skill-injector/api')`；`pollSeq` 防旧响应覆盖
- [ ] settings.section id `dsh-skill-injector`（order 60）：勾选列表、模式 radio、showDock、Save、unresolved 行（reason + `cachedSuffix` + Retry + Remove 仅 `canRemove`）
- [ ] dock id `dsh-skill-injector-dock`（order 10）：`Injected Skills: … · Mode: …(· N unresolved)`，`showDock:false` 隐藏
- [ ] CSS 前缀全 `dsi-`，颜色用 `--dsw-alias-*` token；React.createElement，无 JSX 运行时依赖
- [ ] 快照 normalize 容错旧 host 字段（`showDock` 缺省 true），无 `missing` 引用
- [ ] `pnpm build` 产物 `lib/client.js` 含 `id: "dsh-skill-injector"` 与 `inject = ["slots"]`

**Verification:** `pnpm build` 后 grep `lib/client.js`：含 `/dsh-skill-injector/api`、`dsi-`、不含 `missing`；全套测试仍绿。

**Reference:** 原版 `src/client/index.tsx`；注意原版对 `../helpers.ts` 的显式扩展名内联注释（browser 打包 gotcha），保持同法。

---

### Task 7: 文档 + 总验收

**Files:**
- Create: `README.md`（中文为主，替换现有 2 行壳：特性表、How it works、Quick start `dsh plugin --profile web add ./dsh-skill-injector`、Config 表、FAQ 精选、安全说明、结构）
- Create: `AGENTS.md`（精简版：repo 一览、load-bearing Key behaviors、常见任务、测试命令、命名空间表）
- Modify: `.gitignore` 收尾

**Acceptance Criteria:**
- [ ] `pnpm install && pnpm build && pnpm typecheck && node --test --test-isolation=none "tests/**/*.mjs"` 全绿（契约测试 ~16 条全过）
- [ ] README 无原版包名残留（grep `skill-injector-plugin` 于新文件中 0 命中，temp/ 除外）
- [ ] git 全部提交，工作区干净

**Verification:** 上述命令逐条跑，贴退出码；`git log --oneline` 显示各任务提交。

**Reference:** 原版 `README.md`/`README.zh.md`（结构参照，内容换新身份）；设计文档全篇。

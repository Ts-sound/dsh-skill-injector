# 实践笔记索引

从会话里沉淀的可复用过程知识。分类说明见文末。

| 标题 | 分类 | tags | 路径 | 更新时间 |
| --- | --- | --- | --- | --- |
| DSH 插件接入主界面侧边栏的两个关键约定 | best-practices | dsh, sidebar, slots, cordis, layout | [best-practices/dsh-sidebar-entry.md](best-practices/dsh-sidebar-entry.md) | 2026-11-13 |
| DSH 打包插件的宿主接口包必须放 peerDependencies | pitfalls | dsh, pnpm, peer-dependencies, plugin | [pitfalls/dsh-host-packages-as-peers.md](pitfalls/dsh-host-packages-as-peers.md) | 2026-11-13 |
| 浏览器端 client bundle 引用同包模块要写显式 .ts 后缀 | pitfalls | tsdown, rolldown, client-bundle, dsh, module-loader | [pitfalls/client-bundle-ts-suffix.md](pitfalls/client-bundle-ts-suffix.md) | 2026-11-13 |
| 改含中文/特殊字符的文件不要用 PowerShell 管道回写 | pitfalls | powershell, encoding, utf8, gbk, bom | [pitfalls/powershell-rewrite-encoding.md](pitfalls/powershell-rewrite-encoding.md) | 2026-11-13 |
| 判断运行中的 DSH 加载的是哪份代码 | tools | dsh, debugging, http, restart | [tools/dsh-running-code-check.md](tools/dsh-running-code-check.md) | 2026-11-13 |
| 受限沙箱里 pnpm 与 node --test 的固定绕法 | tools | pnpm, windows, sandbox, powershell, node-test | [tools/pnpm-sandboxed-windows.md](tools/pnpm-sandboxed-windows.md) | 2026-11-13 |

## 分类

- `workflow/` 流程、顺序、协作约定
- `best-practices/` 推荐做法、可复用模式
- `pitfalls/` 易错点、反例
- `tools/` 命令、参数、环境配置

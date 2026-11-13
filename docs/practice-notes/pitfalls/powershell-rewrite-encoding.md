---
title: 改含中文/特殊字符的文件不要用 PowerShell 管道回写
category: pitfalls
tags: [powershell, encoding, utf8, gbk, bom]
created: 2026-11-13
updated: 2026-11-13
source: 2026-11-13 会话，用 Get-Content -Raw | Set-Content 改测试文件后乱码
---

## 场景

在 Windows 上用 PowerShell 批量替换含中文、`·`、`—` 等非 ASCII 字符的文件（测试 fixture、中文 README、含注释的源码）。

## 做法

- 单点修改用 `edit` 工具，或 `node -e` 里 `fs.readFileSync(p,'utf8')` / `fs.writeFileSync(p, s, 'utf8')`；
- 批量修改写成临时 `.cjs` 脚本再 `node scripts/x.cjs`，跑完删除；
- 不要把多行中文/正则塞进单行 `node -e`（反斜杠与引号层层转义，容易 `Invalid string escape` / `Expected unicode escape`）。

## 原因

`Get-Content -Raw` 在中文 Windows 上按 GBK/ACP 解码无 BOM 的 UTF-8 文件，`Set-Content` 再按默认编码写回，等于整文件转码；还会顺手加 BOM。源码与断言里的字符串因此改变，测试报 raw string 不一致，且 diff 全红。

## 反例

改 `tests/invariants.test.mjs` 后出现：

- `· still` → `路 still`、`— the` → `鈥?the`；
- 文件头多出 BOM，`node --test` 报语法/字符串不匹配；
- `Get-Content` 显示 `鈫?` 只是终端解码假象：用 node 以 utf8 读同一文件是正常的，不要据此判断文件已坏。

修复方式：用 node 显式 utf8 逐处替换（`路`→`·`、`鈥?`→`—`）并去 BOM。

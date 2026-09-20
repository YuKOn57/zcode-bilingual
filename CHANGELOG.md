# 更新日志 / Changelog

## Unreleased — 2026-09-21（失效排查记录 / diagnostics）

> 本次 **没有改动任何代码**，不影响插件版本号。以下是一次用户报障「悬停翻译失效」的
> 完整排查记录，结论对后续排障有直接参考价值。

**症状**：ZCode 界面悬停不出中文，但 `status` 显示一切正常。

**根因：ZCode 自动版本更新（3.14.0 → 3.14.1）替换了 `app.asar`**

- ZCode 自身的更新器会用缓存重建 `app.asar`，**并且连同修改时间一起还原**。
  表现出来的现象是「补丁自己消失了」，连 state 里的补丁记录都原样留着。
- ⛔ **`patched: true` 不可信**。唯一可靠的判据是**在 `app.asar` 原始字节里搜 `__zcodeZhTitle3`**
  （自己解析 asar header 极易因偏移算错给出假阴性）。
- 另两个强判据：`patchedSize` 与 `app.asar` 实际大小不符；`app.asar` 的 mtime **早于** state 的
  `at` —— 时间倒挂是普通文件操作不可能造成的，只能是更新器还原。

**第二重故障：自愈没有兜住**

- 自 `2026-09-19 15:11` 起 `hook.log` 再无任何新行 → hook 从未触发；
  7 个 sentinel worker PID 全部失效，`self-heal status` 显示 `worker.alive=false`。
- ⛔ **自愈能否生效的唯一判据是 `hook.log` 有没有新行**。hook 静默时，补丁丢了也没人知道。
- hook 脚本本身可单独冒烟验证，用于排除「脚本坏了」这一可能：
  `echo '{"hook_event_name":"SessionStart","source":"startup"}' | node hooks/session-start.mjs`

**修复与验证**

- ZCode 完全退出后重跑 `apply`，补丁已重建在 **3.14.1** 上，**choke-point 模式仍然可用**
  （目标 chunk 随版本变化：`IntlProvider-DCo4gdAe.js` → `IntlProvider-DW5rmeLm.js`）。
- 验证结果：`__zcodeZhTitle3` ×2、`__zcodeZhDict` ×6、烤入词典 **651** 条
  （+7 filename hints、121 zh overrides）；`upToDate=true`、`dictStale=false`、`codeStale=false`。

**仍然未决**

1. ZCode 自动更新会反复抹掉补丁，自愈只能缩短失效窗口。**根治需要关闭 ZCode 自动更新。**
2. hook 自 09-19 15:11 起静默的原因尚未确证（hook 脚本本身完好）。下次复发优先查这条。

## v0.4.5 — 2026-09-20

**修复：会话窗口 `/技能`、`/智能体` 弹出面板悬停无翻译（用户报障）**

用 CDP 接管真实 ZCode 界面逐行审计后定位到三个原因（都不是词典缺口）：

1. **弹出面板的文本带前缀**：行渲染为 `"<来源标签> · <描述>"`（**一个文本节点**），名字渲染为 `"$name"` / `"/name"`。
   词典是整串精确匹配 → 必然落空。现在按 **原文 → 去掉首个 `· ` 之后 → 去掉 `$ / @ ! >` 首符** 三个变体依次查找。
2. **虚拟列表回收行 DOM**：旧译文残留会显示**别的行**的翻译（实测 `$commit` 挂着"切换到计划模式"，比没有更糟）。
   现在记录产生 tooltip 的源文本，**只有当它已从该元素的 textContent 中消失**（= 真被回收）才清除。
3. **祖先上溯过宽**：整个滚动 listbox 会继承某一行的 tooltip。现在挂到行（button/li/role=option…）时加了
   **体积上限**（源文本长度 ×1.5 + 40）。

**同时修复**

- **contenteditable 子树现在会被处理**（弹出面板是编辑器内部的装饰节点，`isContentEditable` 是继承属性，
  早先整块跳过 → 整个编辑器连同面板都没被处理）；但**编辑器内的文本只挂 `title`、绝不改写**，
  避免 Lexical/ProseMirror 文档模型失步。
- **`<code>`/`<pre>` 内的短文本（≤80 字符）挂悬停**——技能/智能体的名字常渲染成 `<code>` chip；长代码块仍完全不碰。
- **名字类条目收录**：`skill.name` / `agent.name` / `plugin.name`（此前按"标识符不译"跳过，但 UI 那栏就是英文名）。
- **补丁器护栏**：ZCode 运行中调用 `apply` 会**直接拒绝且不碰任何文件**（此前"先还原再重打"在文件被占用时会
  把补丁打没）。
- 词典 739 → **775** 条（含硬编码字面量 `Built-in`/`Workspace`/`User`）。

**验证**

- 单测：`_helper_picker_test.mjs` 9/9、`_helper_editor_test.mjs` 5/5、`_helper_code_test.mjs` 6/6、
  `_patch_fn_test.mjs` 24/24。
- 实机 CDP 逐行审计：纯英文行全部挂上 tooltip；剩余未覆盖行均为**本身已含中文**的描述。

## v0.4.4 — 2026-09-20

- 会话窗口弹出面板：允许处理 contenteditable 子树（只挂 `title`、不改写）。
- `apply` 护栏：ZCode 运行中拒绝打补丁，杜绝"补丁被打没"。

## v0.4.3 — 2026-09-20

- 覆盖 `skill.name` / `agent.name` / `plugin.name` 等名字类条目（用户报"子智能体和技能里的英文没悬浮翻译"）。
- `<code>`/`<pre>` 短文本挂悬停；守卫规则与"故意不收录"清单更新。

## v0.4.2 — 2026-09-19

- **版本免疫加固**：i18n 关键函数改为按当前构建的压缩标识符动态重建（此前硬编码 `g/e/t/n/r`，换构建会 crash）；
  目标发现改为「渲染树优先 + 全归档兜底」。
- **`codeStale`**：补丁器/词典升级后自动重烤。
- **一键完美卸载**：卸载时先停自愈 worker、移除登录兜底 `.vbs`。
- 稳定性审计：60s 病态 churn 无泄漏、0 错误；hooks 170–469ms；补丁 chunk 通过 ESM 语法检查；插件**零网络出口**。

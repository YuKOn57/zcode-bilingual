# 更新日志 / Changelog

## v0.4.7 — 2026-09-28（内联双语提取：悬停必出中文 / inline bilingual extraction）

- **用户追加需求**：`/` 面板里**所有英文**——包括右侧已带中文对照的——悬停都要显示中文翻译。
  行内中文用浅灰色渲染看不清（`/apply  Enable hover-to-translate tooltips in ZCode /
  启用界面悬停翻译（原文与排版不变）`），不如气泡清晰；且 v0.4.6 的截断兜底只在被裁切时才挂。
- **实现**：`rendererHelper` 新增 `inlineZh()`——双语描述的中文半段就在文本里（最后一个
  ` / ` 之后），直接提取为悬停译文，**无需词典、不看布局**（截断、完整可见、未渲染一律生效）。
  词典命中仍优先（权威译文）。纯英文未收录 + 被裁切时依旧落到 v0.4.6 的 `truncFull()` 看全文。
- **误报防护**（`_helper_trunc_test.mjs` 13 项全过）：
  - 分隔符必须是 `空格 + / + 可选空格`，`C:/path`、`https://…` 不命中；
  - 斜杠右侧必须以 CJK（含全角/CJK 标点）开头，`TCP / IP`、`on / off` 不命中；
  - 斜杠左侧必须含拉丁字母**且不能以 CJK 结尾**——`设置 / 语言`、`…设置 / 语言, path…`
    这类纯中文/混合串不命中；
  - 中文段长度 2–800 字符；
  - 行回收照常走 `__zzhSrcV` 清除（换行即换 tooltip / 短文本即清空）。
- **回归**：picker 9 / code 6 / editor 5 全过。

## v0.4.6 — 2026-09-28（截断兜底：双语描述悬停看全文 / truncation fallback for clipped bilingual text）

- **用户报障**：`/` 命令面板里**插件自带双语描述**（`English / 中文` 形式，如
  `/mimosa-deep-audit` 的 "Reproducible, sealed Mimosa deep security audit. / 运行可复核的 Mi…"）
  悬停**没有任何气泡**；而行内 CSS `truncate` 把中文尾部截掉了，内容根本看不全。
- **根因**：这类描述整串（英文+中文）在词典里没有对应键（词典只收纯英文条目，
  「本身已含中文」的描述本来就故意不收录），辅助脚本词典未命中后什么都不挂。
- **修复**：`rendererHelper` 新增 `truncFull()` 截断兜底——词典未命中且文本 ≥20 字符时，
  用真实布局判断元素是否真的被裁切（`scrollWidth/Height` 超出 `clientWidth/Height`），
  命中则把该元素的**完整 textContent**（剥掉 `<来源标签> · ` 前缀）挂为 `title`，
  并照常把悬停目标加宽到所在行。纯英文未收录文本被截断时同样受益（悬浮看英文全文）。
- **护栏**（全部有测试钉死，`_helper_trunc_test.mjs` 10 项）：
  - 只在**真实发生裁切**时才挂——完整可见的长文本绝不长出冗余气泡；
  - 宽度/高度为 0（未渲染）的元素忽略；
  - 祖先回溯仅接受「行形」元素（li/button/a/label/tr/role=option…），大滚动列表容器
    （普通 div，即使 `overflow-y-auto` 被裁切）永远不会变成一整份列表的 tooltip；
  - 候选元素 textContent 上限 600 字符；
  - 虚拟列表行回收：旧行全文 tooltip 照常走 `__zzhSrcV` 清除逻辑（换行换文即清）。
- **生效方式**：补丁器改动 → `status` 报 `codeStale: true` → 常驻哨兵在 ZCode 完全退出后
  自动 `apply --force` 重打并重启（无需手动操作）。既有 3 个 helper 测试全部回归通过
  （picker 9 / code 6 / editor 5）。

## Unreleased — 2026-09-24（登录看门狗默认关闭 / logon watchdog off by default）

- **变更**：`self-heal.mjs` 的 `cmdSchedule()` 不再无条件重写启动目录的
  `zcode-bilingual-watchdog.vbs`；改为 opt-in（`ZCB_WATCHDOG=1` 或
  `self-heal-config.json` 里 `"watchdog": true`）。`run.mjs install` 同理。
  `arm-watchdog` / `unwatch` 手动命令保留。
- **原因**：360 的「关键位置保护」（引擎：木马云查杀）把 Startup 里的 `.vbs` 当持久化模式
  秒删。实测每次 ZCode 启动 → SessionStart hook → `schedule` → 重写 VBS → 1 秒内被删
  （`hook.log` 04:57:26Z/05:02:27Z 对应 360 的 04:57:27/05:02:28）。它从未真正执行过，
  只是在持续制造告警。真正的自动触发源一直是 SessionStart hook。
- **影响**：功能零损失；机器上不再有杀软告警拉锯战。

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

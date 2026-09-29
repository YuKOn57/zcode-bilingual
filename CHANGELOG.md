# 更新日志 / Changelog

## v0.5.2 — 2026-09-29（翻译模型可自选：Ctrl+Alt+M 窗口面板 + 发布前安全/稳定性加固）

- **翻译模型不写死**：解析优先级 `live-config.json` 的 `backend.model` > 顶层 `"model"` >
  wb2api config 自带字段 > 内置兜底 `deepseek-v4.1-flash`；`/translate` 每请求重读配置、
  `/ping` 实时解析——改文件或点面板即生效，无需重启；所选来源记在 `modelSource`
  （/ping、status、启动日志均可见）。
- **窗口内模型自选面板（Ctrl+Alt+M）**：helper 绘制的深色面板（Shadow DOM、
  `pointer-events` 不遮蔽），列表 = 当前 → 常用（选择历史，去重上限 12）→
  网关 `/v1/models` 目录（10 分钟缓存）→ 内置候选；支持自由输入模型 ID、
  「恢复默认（不指定）」一键还原。点选即 `POST /model`，**由 server 写配置，
  渲染层不碰文件**。 Esc / 点击面板外关闭。
- **helper marker `__zcodeZhTitle4` → `__zcodeZhTitle5`**（self-heal / session-start /
  hot-inject 的 CURRENT_MARKER 同步升级）。
- **安全加固（发布前审计）**：dict-server 新增 Origin/Host 回环门禁——无 Origin
  （本机脚本/钩子）、`null`（file:// 渲染层）、`file://`/`app://` 放行；任何 http(s)
  来源与反弹 Host 一律 403。此前仅绑定 127.0.0.1 + `ACAO:*`，本机任意网页仍可驱动
  `/translate` 烧 LLM 配额、`POST /model` 改配置——现已封死。
- **长时运行修复（发布前审计）**：
  - `lastRequestAt` 初始化为 0 且只被 /translate 刷新 → 「启动 60 秒内没有翻译请求的
    实例必被 idle-2h 误杀」（服务反复消失的真因）；改为启动即计时，任何请求都刷新时钟。
  - 收割批处理加**重入保护**（LLM 响应慢于 30s tick 时不再堆叠并发批）。
  - 清单扫描缓存改为纯时间窗（空结果不再每 30s 触发全盘重扫）。
  - 渲染层 `LM` 按需翻译缓存加上限（1000 条 FIFO），长会话不再无界增长。
- **测试**：`_server_scan_test` 41 项（新增门禁/写入路径/目录聚合）、`_helper_live_test`
  25 项（新增面板开合/点选/POST/提示条），六套共 99 项全过；面板探针
  `scripts/_probe_picker.mjs` 入库。

## v0.5.1 — 2026-09-29（模型选择收敛为配置文件）

- 短暂引入的 `live-ctl set-model/clear-model` 子命令按用户要求移除；模型选择改为
  手动编辑 `live-config.json`（保存即生效），`live-ctl` 恒为 ensure/status/stop。

## v0.5.0 — 2026-09-29（实时悬浮翻译 / live hover translation）

- **方向**：从「词典精确匹配」升级为「通用悬浮翻译软件」——任何新增的英文（新装插件、
  新市场卡片、新 UI 面）悬浮即出翻译，不再要求「先补词典、再重打补丁」。
- **前置实锤（CDP 探针）**：ZCode 3.14.4 渲染层**无 CSP 限制**，页面内 `fetch` 到
  `127.0.0.1:17981` 直接 200 → 运行时热更新词典 + 按需翻译可行；本机 wb2api 网关
  （`127.0.0.1:7863`，OpenAI 兼容）`deepseek-v4.1-flash` 短句翻译 1-2s 出结果。
- **`scripts/dict-server.mjs`（新增，回环服务 17981-17985）**：
  - `GET /dict`：热词典 = `buildDictionary()`（dictionary.json + description_i18n 全量）∪
    learned 缓存；helper 每 5 分钟拉取合并 → **新装插件几分钟内免重打直接可译**。
  - `GET /translate?q=`：按需翻译，`learned.json` 永久缓存（LRU 5000 条），方向自动
    （纯英文→中文、纯中文→英文）；限速 30/min，防重复在途请求。
  - **清单收割**：启动+每 10 分钟扫描插件 cache/marketplaces/`plugins.dirs`/`~/.zcode/agents`
    的全部 UI 字符串（v0.5.0 实测 1953 条），**仅在用户没有悬停操作时**每 30s 批量译 12 条
    进 learned → 新插件文案几分钟内进入热词典。
  - 生命周期对齐 wb2api 政策：ZCode 关闭 3 分钟/空闲 2h/满 24h 自动退出，由 hooks 复活；
    `live-config.json` 可禁用（`disabled`）、换端口、换后端（默认自动探测 `~/.dsh/wb2api`）。
- **helper 实时层（marker `__zcodeZhTitle3`→`__zcodeZhTitle4`）**：
  - 词典未命中的文本在渲染时标记 `__zzhMiss`；**悬停才发起翻译**（单一委托 mouseover
    捕获监听，不扫描、不为没人看的文本发请求）；结果挂 `title` 并合并进 `D`（下次瞬时）。
  - 指针仍悬停时弹**小气泡**（`position:fixed`+shadow DOM，`pointer-events:none` 不挡点击，
    6s 自动消失、滚动即隐）；词典/catalog 命中仍走原生 title，零行为变化。
  - 全部 fail-silent：server 不在/被禁 → 行为与 v0.4.x 完全一致；`window.__zcodeZhLive=false`
    全局禁用。
- **`buildDictionary()` 合入 learned.json**：用户悬停学到的每个词条在下一次重打时烤进
  asar → 离线/无 server 机器也保留全部已学翻译。
- **hooks**：SessionStart → `live-ctl.mjs ensure`（探针 + 拉起 detached server）；
  UserPromptSubmit → pid 文件轻量复活检查（活=一次 read+kill(0)）。marker 常量同步 v4。
- **`status` 新增 `live` 字段**（探测回环服务，600ms 上限，绝不影响 status 本身）。
- **`scripts/hot-inject.mjs`（新增）**：CDP 把新 helper 注入运行中的渲染层，更新不用等重启
  （临时桥接，重打后以烤进 asar 的为准）。
- **验证**：6 套测试 67 项全过（新增 `_helper_live_test` 19 项、`_server_scan_test` 15 项）；
  实机全链路：server 起动→/translate 双向正确→learned 落盘→/dict 合流；CDP 热注入后
  运行中的 ZCode 里未知英文悬浮出中文（"Zephyr Quorum Resonator Probe" →
  "Zephyr Quorum 谐振器探针"）；收割器 30s/批稳定运行。

## v0.4.8 — 2026-09-29（ZCode 3.14.4 兼容性验证 / verified against ZCode 3.14.4）

- **触发**：ZCode 自动更新到 3.14.4，`app.asar` 被整体替换（`patched:false / needsRepatch:true`），
  常驻哨兵照常布防，等完全退出后自动重打。
- **副本试打验证**（隔离副本，不动实机）：3.14.4 上 `apply` **exit 0**，choke point 仍是
  `IntlProvider-*`（chunk 名 `BMWo3Clv` → `BNDfn-Cj`）且 **exact 命中**；副本 status
  `patched:true / patchMode:choke-point / dictStale:false`，词典 655 条原样注入。
- **文案缺口扫描（新方法）**：新旧 asar 的渲染资源按「去哈希 basename」配对，真实变化仅 4 处
  （host/main 进程 chunk、`previewPaneOfficeContent` 同尺寸拆文件、`styles` +443 字节）；
  对 `styles` chunk 做新旧**字符串集合差集为零**，`IntlProvider` chunk **字节数相同**
  （catalog 译文原地微调，catalog 悬停自动覆盖）→ **3.14.4 无新增未覆盖英文，词典零改动**。
  插件元数据侧复核（含当日重发布的 computer-use 0.6.3）同样全覆盖。
- **回归**：helper 测试 4 套 33 项全过；`validate-dict` OK（0 重复键）。
- **打包**：安装包内容与 v0.4.7 相同，仅排除开发用 `tests/` 与 `.mimosa` 会话状态残留；
  构建脚本由 python 移植为 `dist_src/build.mjs`（本机已无 python 运行时）。
- 代码与词典相对 v0.4.7 **零改动**，本版仅为 3.14.4 验证发版。

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

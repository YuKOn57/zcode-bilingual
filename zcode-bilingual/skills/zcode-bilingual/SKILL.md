---
name: zcode-bilingual
description: Use when the user wants hover-to-translate for ZCode's UI, Chinese localization of English UI, 汉化 ZCode, 悬停显示中文/英文, 中文提示, or asks whether the zcode-bilingual patch is active, how to apply/restore it, how a ZCode update wiped the translation and whether it will come back by itself, or how to add dictionary entries. Explains the mechanism, coverage, safety, and the commands to run.
---

# ZCode 界面悬停翻译 / ZCode hover-to-translate

## 这个插件做什么

在不改动任何原有文字、也不改变任何排版的前提下，鼠标悬停在 ZCode 桌面版的界面文案上时，
自动浮出另一种语言的翻译气泡，移开即隐藏：

- 英文界面 → 悬停显示中文；
- 中文界面（ZCode 默认）→ 界面保持中文，悬停显示英文。

## 为什么需要补丁而不是普通插件

ZCode 桌面版是 Electron 应用，界面文案全部来自打包进 `app.asar` 的渲染层代码。
ZCode 插件 API 只能贡献命令、技能、子智能体、MCP 与 hooks，**没有任何接口可以修改
客户端自身的界面渲染**。因此本插件采用"插件 + 补丁器"的结构：

- 插件本体（命令 / 技能 / hook）负责分发、状态提示与操作入口；
- `bin/zcode-zh.mjs` 负责真正生效的界面补丁。

## 原理

渲染层里所有可翻译文案都收敛到唯一一个函数：

```js
function w(e){let t=g[e]??g[`zh-CN`];return{formatMessage({id:e},n){ ... }}}
```

其中 `g = { "zh-CN": p, "en-US": m }` 是两套已经内置在包里的文案目录。
补丁只改这一个函数：**按当前语言显示原文，并把另一种语言作为悬停译文**。

同时向该 bundle 注入一小段渲染层辅助脚本：它在渲染时立即把隐藏的译文从文本里剥离出来，
**让页面可见文字精确保留为当前语言的原文**（因此排版零改动），并把译文写入对应元素
（及其所在行）的原生 `title` 属性；悬停时由浏览器/Electron 自身弹出提示，不依赖自定义浮层
或鼠标事件。因为没有改动文案目录本身，原文保持逐字节不变。

### 动态文字词典

插件 / 技能 / 子智能体 / MCP 的名称与描述、插件命令描述属于清单元数据，不在客户端文案目录里，
由插件根目录的 `dictionary.json`（英文→中文）覆盖。打补丁时词典与已安装插件自带的
`description_i18n` 会一起编译进渲染层；辅助脚本做精确匹配（忽略首尾/连续空白），命中即挂译文，
**不修改原文**。

> ⚠️ **运行时加载的插件内容（插件市场「技能」列表描述等）也是悬停，不是可见替换。**
> 这些描述来自插件 zip / 市场数据，**不在客户端文案目录、也不走 `formatMessage`**，但渲染层辅助脚本
> 同样能命中它们：对**命中用户词典 `D` / 覆盖 `OVT` / 文件名提示**的文本节点，仍然**只把译文挂到 `title`
> （悬停），可见英文一个字不变**——与走 `formatMessage` 的客户端文案完全一致。用户确认的核心设计是
> 「原英文显示一律保留，中文只在鼠标悬停时出现」。守卫：`INPUT/TEXTAREA/CODE/PRE/SCRIPT/STYLE/contentEditable`
> 内的文本节点不处理。验证：模拟 DOM 跑真实 helper，断言 `nodeValue` 仍为英文、`title` 含中文。

**覆盖哪些元数据源**（`scripts/_scan_missing.py` 全都会扫）：

| 来源 | 取什么 | 出现在哪 |
|---|---|---|
| `<plugin>/plugin.json` | `name` / `description` / `author` | 设置 → 插件、市场列表 |
| `<plugin>/skills/*/SKILL.md` | frontmatter `name` / `description` | 设置 → 技能、`/` 面板 Skills 段 |
| `<plugin>/commands/*.md` | frontmatter `description` | **`/` 命令面板**（如 `/workflow`） |
| `<plugin>/agents/*.md` | frontmatter `name` / `description` | **子智能体列表**、`@` 提及 |
| `~/.zcode/agents/*.md` | 同上 | 用户自建子智能体 |
| `config.json` → `plugins.dirs` | 上面全部 | 本地注册的插件目录 |

⚠️ **2026-09-19 踩坑**：`commands/*.md` 与 `agents/*.md` **在 v0.4.1 之前从未被扫描收录**，
所以「会话窗口的 `/workflow` 没翻译」「子智能体没翻译」看起来像插件坏了，其实是词典缺这两类来源。
排查手法：`python scripts/_scan_missing.py`，报告里 `<- ['command.desc']` / `<- ['agent.desc']` 就是它。
`argument-hint` **故意不收录** —— 那是参数语法（`<system-dir> [target-stack]`），翻译会误导用户怎么输入。

⚠️ **同一个坑的第三种形态**：**插件市场列表**只显示 `plugin.json` 的 `name` + `description`，
而这两项走的是另一条扫描路径（`plugin.json` 而非 `commands/` `agents/`）。
只补了 commands/agents 时，市场里仍是大片英文 —— 用户报的「插件市场内的英文没有翻译」就是它。
**判据：`_scan_missing.py` 报告里出现 `<- ['plugin.desc']` / `<- ['plugin.name']`**。
`author` **故意不收录**（Anthropic / GitHub / HashiCorp 这类公司名，译中文只是噪音）。

⚠️ **第四种形态（更深入）：市场「技能」列表里每个技能的描述。**
这些描述来自插件 zip / 市场数据，**运行时加载、不在渲染包内、不走 `formatMessage`**，但渲染层辅助脚本
同样能命中：把官方市场 40 个插件的技能 / 子智能体描述全量扫进 `dictionary.json`（`_enum_market_skills.py`
枚举 → 127 条技能描述 + 11 条子智能体描述），命中即**悬停出中文、可见英文不变**。`_scan_missing.py`
+ `_enum_market_skills.py` 双跑，两者都 0 剩余才说明面向用户的英文已全覆盖。

词典是在**打补丁时**编译进 asar 的，所以改完 `dictionary.json` 不会立即生效，需要一次
**强制重打**。v0.4.1 起这一步已自动化：`status` 会多报 `dictHash` / `dictHashNow` / `dictStale`，
SessionStart hook 发现「词典或补丁器比状态文件新」时会自动布防自愈，等你完全退出 ZCode 后
自动 `apply --force` 重打并重启（`self-heal.log` 里能看到 `dictionary refresh`）。

手动路径仍然可用：`apply --force`（只改词典时 marker 不变，不带 `--force` 的 `apply`
会报 "Already patched" 直接跳过、不重新注入词典），也可用 `apply --dict <file>` 追加词典。

文件名尾匹配：`dictionary.json` 里以 `~` 开头的键（如 `"~stop-hook.mjs"`）不参与整句
精确匹配，而是命中任何以该脚本文件名结尾的文本（钩子命令 `node ${ZCODE_PLUGIN_ROOT}/.../stop-hook.mjs`、
含引号变体均可）。给插件钩子脚本加悬停说明时用这种键，一条短条目覆盖整条命令。

官方中文值覆盖：`dictionary.json` 里以 `@` 开头的键按 **i18n key** 替换 ZCode 自带的 zh-CN
文案（`"@settings.mcp.form.type.sse": "SSE 服务端推送（单向流式）"`）。用于官方中文里仍
残留英文的情况（如 `settings.mcp.form.type.sse` 原文是「SSE（Server-Sent Events）」）。
替换后：中文界面直接显示覆盖值，英文界面显示英文、悬停显示覆盖值。

硬编码英文：少数 UI 值被写成 JSX 字面量（`children:`HTTP``），根本不经过 `formatMessage`，
i18n 目录里查不到，只能靠动态词典补。排查脚本 `scripts/_scan_hardcoded.py <chunk关键字>`
（已知案例：新建 MCP 的类型下拉 `HTTP`，同下拉的 stdio/sse 走 i18n）。

**2026-09-19 新增案例（ZCode 3.14.0）**：新版引入的 **Office 预览面板**（DOCX / XLSX / PPTX）
与图表查看器，整套 UI 文案都是硬编码英文 —— 分布在 `previewPaneOfficeLegacyDocContent-*.js`、
`previewPaneOfficeXlsxContent-*.js`、`pptxRendererPreviewEngine-*.js`，以及 `styles-*.js`
里的主题名（Catppuccin / Vitesse / GitHub 等）。同版本还换了官方插件集
（`document-skills` → `documents` / `spreadsheets` / `presentations` / `image-search` /
`plugin-creator` / `node-repl-host` / `dynamic-workflows`），旧词条作废、新名称未收录。
表现就是「ZCode 升级后有些内容不翻译了」——**不是补丁坏了**。
排查入口：`Documents\zcode\_scan_gap.py`（拿 catalog 的值与词典键做减法，列出未覆盖的英文），
已收录的条目见 `dictionary.json`。
注意：判重时要看该字符串是否在**别的 key** 下出现过（如 `HTTP` 是别的词条的英文值），
否则会误判为「已覆盖」。

⚠️ 历史坑（2026-09-17）：某次 apply 用了 `dist/zcode-bilingual-setup-v0.3.0/app/` 里的旧
dictionary.json（73 条）打补丁，主仓库后来补的 30 条（钩子事件名、诊断技能描述）从未注入，
表现为「设置-技能」描述、「设置-钩子-事件」事件名悬停无中文。排查手法：从 asar 提取
`window.__zcodeZhDict=Object.assign(window.__zcodeZhDict||{},` 之后的 JSON 数一数条数；
主仓库与 dist 两份 dictionary.json 必须同步。

## 覆盖范围

- 覆盖：所有走 `formatMessage` 的界面文案，包括设置页（常规/外观/模型/记忆/子智能体/
  插件/MCP/技能/命令/自动化/Hooks…）、`/` 命令面板、弹窗、按钮、提示、空状态等。
  中英来自同一份 key，天然一一对应；按当前语言显示原文，译文只在悬停时出现，不占布局。
- 动态文字：插件/技能/子智能体/MCP 的名称与描述、插件命令描述，由 `dictionary.json`
  与各插件自带的 `description_i18n` 覆盖；词典未收录且清单无中文的第三方文本无法离线翻译。
- 不覆盖：终端 TUI（若使用 ZCode CLI）以及用户自己输入的内容。

## 安全性

- 补丁前会把 `app.asar` 备份为 `app.asar.zcode-zh.bak`。
- **备份会随 ZCode 版本轮换**：ZCode 升级会整体替换 `app.asar`，沿用旧备份会导致
  `restore` 把上一个版本 ZCode 的 asar 写回去、弄坏安装。所以 `apply` 发现
  「没有任何补丁标记」（= 当前是干净原版，说明刚升级过）时，会把旧备份挪到
  `app.asar.zcode-zh.bak.previous`，再从当前 `app.asar` 重取还原点。
- 只替换归档内的 1 个文件，其余 2 万多个文件逐字节不变（可用 `apply --dry-run` 与
  校验脚本确认）。
- 补丁前会检测 Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse；若该构建启用了
  完整性校验，会拒绝打补丁（否则会导致应用无法启动）。
- i18n choke point 的定位是容错的：优先 `IntlProvider-*.js`，否则扫描 `/out/renderer/**/*.js`
  的特征；三级定位 `exact` / `regex` / `anchor`，都不中才报错退出（绝不瞎改）。
- `restore` 用备份逐字节还原。
- 当前 MARKER `__zcodeZhTitle3`；旧版全部登记在 `LEGACY_MARKERS`，`apply` 会先还原再重打。
- ZCode 升级会覆盖 `app.asar`，但**不需要用户手动重跑**：见下节「升级自愈」。

## 升级自愈（v0.4.0 引入，v0.4.1 起改为常驻哨兵，核心）

ZCode 每次升级都会整体替换 `app.asar`，补丁随之消失；而 asar 在 ZCode 运行期间被占用，
只能等它完全退出后才能重打。自愈系统把这段空档自动化了：

| 触发源 | 时机 | 依赖 ZCode hook |
|---|---|---|
| SessionStart hook → **常驻哨兵** | 每次会话开始布防，跨会话存活 | 是 |
| UserPromptSubmit hook → **确保哨兵在跑** | 每次发消息（哨兵活着时读一个文件即退出，静默） | 是 |
| 登录看门狗 `.vbs` | 每次 Windows 登录 | **否**（独立于 ZCode） |
| `/zcode-bilingual:repair`、`repair.cmd` | 手动 | 否（.cmd） |

> ⚠️ **两条 hook 不是冗余，是必要**：实测（2026-09-19）ZCode 重启后**会话已创建
> （`session_create.completed`）但 SessionStart hook 没跑**（`hook.log` 无新行）。
> 只靠 SessionStart 就会漏掉布防，而哨兵必须在更新发生**之前**就活着。
> 因此再加 `UserPromptSubmit`：哨兵已活时只做「读锁文件 + `process.kill(pid,0)`」，
> 无子进程、无输出（实测整条 hook ~0.4s）；只有真的没哨兵时才 spawn，并带 60s 节流
> （`sentinel-arm.stamp`），避免"worker 反复夭折 → 反复 spawn"的风暴。

> ⚠️ 登录看门狗在部分机器上会被安全策略拦截（`.vbs`/`.cmd` 写入启动目录后数秒被删；
> `schtasks`/`Run` 注册表项被拒绝访问）。这类机器上实为 **hook 单触发源**，功能不受影响；
> 是否生效看 `self-heal.mjs status` 的 `watchdogInstalled`。

### 为什么要"常驻"哨兵

ZCode 用 **electron-updater**：**在 ZCode 关闭期间**替换 `app.asar`，**然后由安装器自己重新启动 ZCode**。
所以"事后才被唤醒"的一次性 worker 帮不上忙 —— 等它反应过来，用户已经对着一个没翻译的界面在用了。
这正是「每次更新就失效」的成因。

`self-heal.mjs sentinel` 因此做成常驻：

- hook 每次会话开始都布防（`schedule --sentinel`，幂等，已存活则返回 `already-running`）；
- 哨兵**故意活过 ZCode 的退出**，在 ZCode 关闭后的前 90 秒以 2 秒间隔盯 `app.asar`；
- 一旦签名（`size:mtime`）连续两次不变（= 安装器写完了）就立刻 `apply --force`，
  并**自动重启 ZCode** —— 安装器拉起的那个进程因而直接带着补丁；
- 打完补丁**不退出**，继续待命等下一次更新；只有在「ZCode 已离开 30 分钟且补丁校验通过」、
  请求被 `cancel`、或 72h 到期时才退出；
- 同一签名连续失败 2 次进入退避，不再反复折腾。

判据（`self-heal.log`）：

```
sentinel start pid=… poll=5000ms watch=2000/90000ms idleExit=30min deadline=72h
sentinel: patch missing after an archive change; applying --force
sentinel: apply exit=0
sentinel: relaunching …\ZCode.exe
sentinel: ok (mode=choke-point dict=381 asar=311.8 MB)
sentinel: ZCode long gone and the patch verifies; exiting
```

### 版本韧性：补丁点找不到也能打

原来的补丁要改 ZCode 里那个被压缩过的 `w(e)` 函数。定位是三级容错的
（`exact` / `regex` / `anchor` + 扫全部 renderer chunk），但它终究耦合在**代码形状**上 ——
真遇到 i18n 重构就只能报 `exit 4`，翻译彻底失效。

v0.4.1 起加了 **catalog 锚定兜底**：定位不到 `w(e)` 时，改为找**两个大对象字面量**
（按 CJK 密度区分 zh/en，向前扫 `=` 取变量名），把 helper 追加到同一个 chunk，并把这两个变量
作为 `{"en-US":m,"zh-CN":p}` 交给 helper。**完全不依赖函数形状。**

helper 的目录映射来源按优先序：
1. 应用自己的 locale 表标识符（从 `<ident>[<quote>zh-CN<quote>]` 探测，如 `g`）；
2. 上面那两个 catalog 变量；
3. 都没有 → 只挂词典（dictionary-only，无 catalog 悬停）。

`status` 的 `patchMode` 会写明走的是哪条路（`choke-point` / `catalog-only`）。
> ⚠️ catalog-only 模式下没有 `formatMessage` 包装，`@{i18n.key}` 覆盖无法作用于可见文字，
> 因此打补丁时会把覆盖**解析成「英文原文→中文」的文本对**（`__zcodeZhOverrideText`），
> 至少保证悬停仍有中文。

边界与安全：

- **单实例锁**：多会话重复布防只会拉起一个 worker（`self-heal-worker.lock\`，pid 校验 + 陈旧锁回收）。
- **退避**：同一 `app.asar` 签名（`size:mtime`）连续失败 2 次即停止自动重试，改为提示
  「此版本可能不兼容」，避免每次登录都折腾一遍；手动 `repair` 可越过退避。
- **超时**：72h 内没等到 ZCode 关闭 → 写 `timeout` 结果、保留请求，下次会话/登录再布防。
  （不把「用户一直没关 ZCode」误判为不兼容。）
- **尊重 restore**：`restore` 是显式退出，会清除待修复请求；hook 对 `patched:false`
  状态只提示、不自动布防。

### 自愈没生效怎么查（v0.4.1 新增）

**先看 hook 自己的痕迹** —— `%LOCALAPPDATA%\zcode-bilingual\hook.log`（v0.4.1 起每次
SessionStart 都会追加一行）。这一行就能区分三种完全不同的失败：

```
SessionStart source=startup asar=… st=ok patched=true marker=__zcodeZhTitle3 replaced=false staleInputs=false worker=false
armSelfHeal(dictionary) status=0 signal= request=true ok=true out={"scheduled":true,...}
```

| hook.log 里看到 | 含义 |
|---|---|
| **完全没新增行** | hook 根本没跑：插件没被加载（看 ZCode 日志 `plugins.completed` 的 `hookCount`），或这次启动没开会话 |
| 有 `staleInputs=false` | 词典本来就没变，不需要刷新 —— 不是故障 |
| 有 `staleInputs=true` 但没有 `armSelfHeal` 行 | 布防前就异常退出了，把该行贴出来 |
| `armSelfHeal(...) ok=false` | `schedule` 调到了但失败 —— 看 `status=` / `out=` 字段 |

**再看两个状态**：`node bin/zcode-zh.mjs status`（`dictStale` 是否为 `true`）与
`node scripts/self-heal.mjs status`（`request` 是否挂着、`worker.alive`）。

⚠️ **别被 `hookCount` 的波动误导**：实测 `example-plugin` 的 MCP 服务连接超时会让 ZCode
把它整个剔除，`plugins.completed` 就从 `18 / 12 / 15 / 7` 掉到 `17 / 10 / 15 / 7` ——
**少的是 example-plugin 的 1 插件 2 hook，与 zcode-bilingual 无关**。判定 zcode-bilingual
是否加载，看 `commandRootCount` / `skillRootCount` 有没有变，或直接看 hook.log 有没有新行。

⛔ **别在工具/沙箱会话里期望 worker 长期存活**：由会话工具起的 detached worker 会被
job object 清掉（`self-heal.log` 只写到 `worker start pid=…` 就断；锁文件仍在 = `finally`
没跑 = 被强杀）。要真实交付就让用户侧触发：双击 `repair.cmd`，或让 hook 布防。
- 开关：`%LOCALAPPDATA%\zcode-bilingual\self-heal-config.json` → `{"autoHeal": false}` 停用自动布防，
  `{"relaunch": false}` 只打补丁不自动重启。
- 取证：`self-heal.log`（上限 ~256KB）、`self-heal-result.json`、`self-heal-request.json`。

worker 的完整设计（锁/稳定性窗口/重启规则/失败退避的实现细节）见交接文档
`zcode-bilingual-HANDOFF-v0.4.0.md`。

## 部署到其他电脑

`dist/zcode-bilingual-setup-v<版本>.zip`（约 31 MB，自带 Node 运行时）。解压后：

- `安装.cmd` —— 完全退出 ZCode 后双击。也可把 `app.asar` 拖到它上面指定自定义安装位置。
- `卸载.cmd` —— 逐字节还原界面、注销插件、删除所有残留（含备份与插件副本），幂等。
- `检查状态.cmd` —— 打印 `status`。

安装目标：`%LOCALAPPDATA%\zcode-bilingual\app`；路径记录在
`%LOCALAPPDATA%\zcode-bilingual\zcode-path.txt`。
`.cmd` 内容纯 ASCII，中文输出全部由 node 在 `chcp 65001` 之后打印。

## 命令

```bash
node bin/zcode-zh.mjs status     # 查看状态（快）
node bin/zcode-zh.mjs apply      # 打补丁（需先完全退出 ZCode）
node bin/zcode-zh.mjs apply --force   # 已打补丁时强制重打（如更新词典后）
node bin/zcode-zh.mjs restore    # 还原（同时清除待执行的自动修复）
node bin/zcode-zh.mjs apply --asar <path>   # 指定自定义安装路径

node scripts/self-heal.mjs schedule --reason manual   # 布防：退出 ZCode 后自动打补丁并重开
node scripts/self-heal.mjs status                     # 自愈状态：请求/结果/worker/看门狗
node scripts/self-heal.mjs cancel                     # 取消待执行的自动修复并停止 worker
node scripts/self-heal.mjs arm-watchdog | unwatch     # 安装 / 移除登录看门狗
```

## 重要：必须先退出 ZCode

`app.asar` 在 ZCode 运行期间被占用，无法替换，所以打补丁只能发生在 ZCode 完全退出之后。

- **正常情况什么都不用做**：升级后 hook / 登录看门狗会自动布防，退出 ZCode 即自动修复并重开。
- 想立刻安排：`/zcode-bilingual:repair`，或双击插件目录里的 `repair.cmd`（ZCode 运行中也可以）。
- 手动路径（ZCode 已完全退出、含托盘图标）：
  - `install.cmd` —— 注册插件 + 打补丁 + 启动 ZCode
  - `apply.cmd` / `repair.cmd` / `restore.cmd` / `status.cmd`

## 排查

- 界面没有中文、`status` 显示 `patched: false`：先跑 `node scripts/self-heal.mjs status`。
  有存活 worker 或 pending 请求 → 告诉用户「完全退出 ZCode 即自动修复」，不要让他手动跑脚本。
- `result.ok === false` 且 `failCount >= 2`：自动修复在该版本上已连续失败，看
  `%LOCALAPPDATA%\zcode-bilingual\self-heal.log` 尾部与 `apply` 的退出码
  （4 = 找不到 choke point，说明该 ZCode 版本需要适配插件，不要反复重试）。
- 报错 "Could not replace app.asar because it is in use" → ZCode 未完全退出。
- 打完补丁界面没有中文 → 确认已重启 ZCode；用 `status` 确认 `patched: true`。
- 想彻底还原 → 运行 `restore`（会同时取消待执行的自动修复、移除看门狗请用 `unwatch`），
  或删除 `app.asar.zcode-zh.json` 状态文件后从 `app.asar.zcode-zh.bak` 手动还原。
- 怀疑"插件整个失效"（技能/命令都不见了）：先看 `~/.zcode/cli/log/zcode-*.jsonl` 里
  `bootstrap.app.startup.plugins.completed` 的 `hookCount`/`skillRootCount` 是否比正常值少 1
  —— 在设置里禁用过再启用，**已存在的会话不会恢复**，需要新开会话。

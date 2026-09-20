# zcode-bilingual — ZCode 界面「悬停翻译」插件

鼠标悬停在 ZCode 桌面版的界面文案上时，自动弹出另一种语言的原生悬停提示（浏览器 `title` 提示）：

- 英文界面 → 悬停显示**中文**；
- 中文界面（ZCode 默认）→ 界面**保持中文不变**，悬停显示**英文**。

**原有文字一个字符都不改、排版完全不变**（不换行、不改宽度、不遮挡原有内容）。

> Hover ZCode UI text to see a translation tooltip: English UI → Chinese, Chinese UI → English.
> The original text and the layout are left completely untouched.

---

## 1. 为什么是“插件 + 补丁器”

ZCode 桌面版是 Electron 应用。它的界面文案全部打包在 `app.asar` 的渲染层里，
而 ZCode 插件 API 只能贡献命令 / 技能 / 子智能体 / MCP / hooks，**无法修改客户端自身的界面渲染**。
所以本插件由两部分组成：

| 部分 | 作用 |
|---|---|
| 插件本体（`plugin.json` / 命令 / 技能 / hook） | 分发、状态提示、操作入口 |
| `bin/zcode-zh.mjs` 补丁器 | 真正让界面实现悬停翻译 |

---

## 2. 原理（为什么能覆盖全部界面文案）

渲染层里所有可翻译文案都收敛到**唯一一个函数**：

```js
function w(e){let t=g[e]??g[`zh-CN`];return{formatMessage({id:e},n){ ... }}}
```

`g = { "zh-CN": p, "en-US": m }` 是 ZCode 包里**本来就自带**的中英两套文案目录。
补丁只改这一个函数：**按当前语言显示原文，并把另一种语言作为悬停译文**。

再向同一个 bundle 末尾注入一小段渲染层辅助脚本：它在渲染时立即把隐藏的译文从文本里
剥离出来，**让页面中可见的文字精确保留为当前语言的原文**（所以排版完全不变），并把译文
写入对应元素（及其所在行）的原生 `title` 属性；鼠标悬停时由浏览器/Electron 自己弹出提示，
无需任何自定义浮层或鼠标事件，因此不受窗口层级、滚动容器、遮挡等影响。因为**没有改动
中英文案目录本身**，原文逐字节不变。

### 动态英文（插件 / 技能 / 子智能体 / MCP）

`/` 命令面板、插件列表、技能列表、子智能体、MCP 里的**条目名称与描述**来自各自的清单文件，
不在客户端文案目录里，因此无法从包里取到译文。这部分由 **`dictionary.json` 词典**覆盖：

- 打补丁时会把词典（以及已安装插件自带的 `description_i18n`）编译进渲染层；
- 辅助脚本对页面上任意文本做**精确匹配**（忽略首尾 / 连续空白），命中即挂上译文气泡，**不修改原文**；
- 想补充更多条目，编辑插件根目录的 `dictionary.json`，然后重新运行 `apply` 即可。

词典键必须与界面上显示的文字完全一致（含标点）。当前已内置本机官方插件 / 技能的名称与描述，
以及若干插件命令描述。

实测（本机 ZCode 3.11.2 / Electron 41）：

- 归档内 27,281 个文件，补丁后 **27,280 个逐字节不变**，只有 `IntlProvider-*.js` 一个文件被改写；
- 当前语言为 zh-CN 时 `formatMessage` 返回 `设置␣Settings`（可见中文、悬停英文）；
  为 en-US 时返回 `Settings␣设置`（可见英文、悬停中文）；带参数时两种语言都会正确代入；
- 词典精确匹配：`browser-use` → 悬停「浏览器自动化」；长描述也能命中；
- 未翻译的 key（中英相同）只显示一次，未知 key 原样返回。

---

## 3. 覆盖范围

**覆盖**：所有走 `formatMessage` 的界面文案 —— 设置页（常规 / 外观 / 模型 / 记忆 /
子智能体 / 插件 / MCP / 技能 / 命令 / 自动化 / Hooks / 索引 / 浏览器 / 电脑使用 / 用量…）、
`/` 命令面板的界面文字、弹窗、按钮、提示语、空状态等。这些文案平时显示当前语言原文，
鼠标悬停时才浮出另一种语言，因此不占布局、不会挤压或遮挡原有界面。

**动态条目文字**：插件 / 技能 / 子智能体 / MCP 的名称与描述、插件命令描述，由
`dictionary.json` 词典覆盖（详见上一节）。未收录的条目不会被翻译。

**不覆盖**：

- 词典里没有、且 manifest 也未提供 `description_i18n` 的第三方英文文本（离线无法凭空翻译）。
- 终端 TUI（若使用 ZCode CLI），以及用户自己输入 / 粘贴的内容。

---

## 4. 安装与使用

### 方式 A：一键脚本（推荐，Windows）

1. **完全退出 ZCode**（包括托盘 / 菜单栏图标）。
2. 双击插件目录下的 **`install.cmd`**：注册插件 → 打补丁 → 自动启动 ZCode。
3. 启动后即可看到中英字幕。

### 方式 B：命令行

```bash
# 需先完全退出 ZCode
node scripts/install.mjs install      # 注册插件
node bin/zcode-zh.mjs apply           # 打补丁
node bin/zcode-zh.mjs status          # 查看状态
node bin/zcode-zh.mjs restore         # 还原
node bin/zcode-zh.mjs apply --dry-run # 只演练不写入
node bin/zcode-zh.mjs apply --asar "<自定义路径>/app.asar"
node bin/zcode-zh.mjs apply --dict "<额外词典.json>"   # 追加动态文本词典

# 自愈（ZCode 运行中也能用）
node scripts/self-heal.mjs schedule --reason manual   # 布防：退出 ZCode 后自动打补丁并重开
node scripts/self-heal.mjs status                     # 请求 / 结果 / worker / 看门狗
node scripts/self-heal.mjs cancel                     # 取消待修复
```

### 升级后恢复（平时无需操作）

ZCode 升级把界面补丁冲掉时，**只要完全退出一次 ZCode**，自愈会自动重打补丁并重新打开
ZCode。若想立刻安排（ZCode 运行中也可以）：双击 **`repair.cmd`**，或运行
`/zcode-bilingual:repair`，或上面的 `self-heal.mjs schedule`。

### 卸载

**完全退出 ZCode** 后双击 `uninstall.cmd`（= 还原界面 + 注销插件），
或手动执行 `node bin/zcode-zh.mjs restore && node scripts/install.mjs uninstall`。

---

## 5. 安全性与可逆性

- 打补丁前把 `app.asar` 备份为 `app.asar.zcode-zh.bak`；`restore` 逐字节还原。
- **备份会随 ZCode 版本轮换**：ZCode 升级会整体替换 `app.asar`。
  如果沿用旧备份，一旦执行 `restore` 就会把**上一个版本 ZCode 的 asar 写回去**，
  等于把安装弄坏。所以 `apply` 在「没发现任何补丁标记」（= 当前是干净的原版，
  说明刚被升级过）时，会把旧备份挪到 `app.asar.zcode-zh.bak.previous`，
  再从当前 `app.asar` 重新取一份还原点。
- 打补丁前会检测 Electron fuse `EnableEmbeddedAsarIntegrityValidation`。
  **若该构建启用了完整性校验，补丁器会拒绝执行**（否则会导致应用无法启动）。
  本机实测为 disabled，且 `OnlyLoadAppFromAsar` 也是 disabled。
- 只改归档内 1 个文件；不新增/删除其他文件。
- **补丁的定位是容错的**：优先找 `IntlProvider-*.js`；如果 ZCode 改了分包/命名，
  会退化为扫描 `/out/renderer/**/*.js` 里的 i18n choke point 特征；再不行才报错退出
  （绝不瞎改）。三级定位分别是 `exact` / `regex` / `anchor`。
- 补丁版本用 MARKER 管理。当前 MARKER 是 `__zcodeZhTitle3`，旧版全部登记在
  `LEGACY_MARKERS`（`__zcodeZhTitle2` / `__zcodeZhInline` / `__zcodeZhTitle` /
  `__zcodeZhHover*` / `__zcodeZhBilingual`），`apply` 遇到旧版会**先还原再重打**。
- ZCode 官方升级会覆盖 `app.asar`，但**不需要你手动重跑任何脚本**：见 §9「升级自愈」。
  会话启动时的 hook 会用一次 `stat()` 廉价判断「asar 比状态文件新」，发现被升级覆盖后
  自动布防；即使 hook 因将来的 ZCode 版本变化而失效，还有登录看门狗兜底。
- 插件注册只修改 `~/.zcode/cli/config.json`（把插件目录加入 `plugins.dirs`，
  并启用 `zcode-bilingual@inline`），修改前会备份为 `config.json.zcode-zh.bak`；
  卸载时精确移除，不影响其他插件。

### `status` 输出字段

| 字段 | 含义 |
|---|---|
| `patched` / `marker` | 是否已打补丁、打的是哪个版本 |
| `upToDate` | `marker` 是否等于当前版本 |
| `needsRepatch` | 需要重新 `apply`（没打 / 打了旧版 / 被升级覆盖） |
| `zcodeVersion` | 从归档内 `package.json` 读出的 ZCode 版本 |
| `backupStale` | 备份比 `app.asar` 旧且当前未打补丁 → 备份已过期，`apply` 会轮换它 |
| `integrityFuse` | Electron ASAR 完整性校验状态（必须是 `disabled` 才能打补丁） |
| `dictHash` / `dictHashNow` | 打进 asar 的词典指纹 / 当前 `dictionary.json` 的指纹 |
| `dictStale` | 两者不一致（或旧状态文件没记录）→ 需要一次**强制重打**才能让新词条生效 |
| `dictEntriesNow` | 当前词典条目数（含已安装插件贡献的 `description_i18n`） |
| `patchMode` | 补丁走的是哪条路：`choke-point`（改 `w(e)` 函数）/ `catalog-only`（找不到函数，改用消息目录锚定） |

> 注意：`app.asar` 在 ZCode 运行期间被占用，**apply / restore 必须在 ZCode 完全退出后执行**。
> 这是唯一的手动步骤。
> v0.4.1 起 `dictStale` 也会触发自愈，所以「改完词典」同样只需要**退出一次 ZCode**。

---

## 6. 目录结构

```
zcode-bilingual-plugin/
├─ .zcode-plugin/plugin.json     # 插件清单
├─ bin/zcode-zh.mjs              # 补丁器：asar 解析 / 改写 / 备份 / 还原 / 状态
├─ scripts/self-heal.mjs         # 自愈：等 ZCode 退出 → 打补丁 → 重开；含登录看门狗
├─ commands/                     # /zcode-bilingual:status | apply | repair | restore
├─ skills/zcode-bilingual/       # 技能说明
├─ hooks/                        # SessionStart hook：提示状态 + 发现升级即自动布防
├─ scripts/install.mjs           # 插件注册 / 注销
├─ install.cmd / uninstall.cmd   # 一键启用 / 卸载
├─ apply.cmd / repair.cmd / restore.cmd / status.cmd
└─ README.md
```

---

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 双击 `.cmd` 一闪而过 | 旧版脚本为 LF 换行导致 cmd 解析失败；现已改为 CRLF + Node 驱动（`scripts/run.mjs`）。若仍异常，在 cmd 窗口手动运行 `node scripts\run.mjs status` 看具体报错。 |
| 脚本提示 “ZCode 正在运行” | 需完全退出 ZCode（含托盘图标）后再双击。这是刻意的保护，避免写入被占用的 `app.asar`。 |
| `Could not replace app.asar because it is in use` | 同因：ZCode 未完全退出。退出后重试。 |
| 打了补丁但界面没有中文 | 未重启 ZCode；或 ZCode 刚升级过被覆盖。先跑 `node scripts/self-heal.mjs status`：有存活 worker 就说明会自动恢复——**完全退出 ZCode 即可**，不用手动跑脚本。 |
| 升级后中文没了，怎么恢复 | 完全退出 ZCode 即自动恢复并重开（见 §9）。想立刻安排：双击 `repair.cmd` 或 `/zcode-bilingual:repair`。 |
| 升级后「有些内容不翻译了」（不是全没了） | **不是补丁坏了**——ZCode 新版引入的新界面文案不在它的 i18n 目录里，`formatMessage` 补丁够不着，只能靠 `dictionary.json` 补。典型：3.14.0 的 Office 预览面板（DOCX/XLSX/PPTX）、图表查看器、主题名，以及它换掉的那批官方插件名称/描述。处理：把缺的英文加进 `dictionary.json`（用 `_scan_gap.py` 找缺口），保存后**退出一次 ZCode** 即自动重打生效。 |
| **插件市场里的英文没翻译** | 市场列表只显示 `plugin.json` 的 `name` + `description`，它们走的是**另一条扫描路径**（`plugin.json`，不是 `commands/` `agents/`）。只补了命令/子智能体时市场仍是大片英文。判据：`python scripts/_scan_missing.py` 报告里出现 `<- ['plugin.desc']` / `<- ['plugin.name']`。`author` 故意不译（公司名）。 |
| 改了 `dictionary.json` 但界面没变 | 词典是在打补丁时编译进 asar 的，改文件本身不生效。`status` 的 `dictStale` 为 `true` 即表示待刷新；完全退出 ZCode 会自动 `apply --force` 重打（v0.4.1+）。手动兜底：`node bin/zcode-zh.mjs apply --force`。 |
| 退出并重启了 ZCode，界面还是没变 | 说明**补丁压根没重打**。查 `%LOCALAPPDATA%\zcode-bilingual\hook.log`：没有新增行 = SessionStart hook 没跑（插件未加载，或这次启动没开会话）；有 `armSelfHeal(…) ok=false` = 布防失败。最快的兜底：**确保 ZCode 已完全退出**，然后 `node bin/zcode-zh.mjs apply --force`（几秒完成，当前状态会写进 `app.asar.zcode-zh.json`）。 |
| 自动修复一直没发生 | `self-heal.mjs status` 看 `result`：`failCount >= 2` 表示该 ZCode 版本上连续失败，停止自动重试；看 `%LOCALAPPDATA%\zcode-bilingual\self-heal.log` 尾部与 `apply` 退出码（4 = 找不到 choke point，说明插件需要适配该版本）。 |
| 技能 / 命令整个不见了 | 多半是在设置里禁用过插件再启用，而当前会话不会恢复——**新开一个会话**。可用日志 `~/.zcode/cli/log/zcode-*.jsonl` 里 `plugins.completed` 的 `hookCount` / `skillRootCount` 是否少 1 来判断。 |
| 想彻底还原 | `restore`（会同时取消待执行的自动修复）；或删除 `app.asar.zcode-zh.json` 后从 `app.asar.zcode-zh.bak` 手动覆盖。移除登录看门狗用 `self-heal.mjs unwatch`，或删除启动目录里的 `zcode-bilingual-watchdog.vbs`。 |
| 插件列表里没有 | 需重启 ZCode；确认 `config.json` 的 `plugins.dirs` 含本插件目录（绝对路径），且目录存在、`.zcode-plugin/plugin.json` 可读。 |

---

## 8. 长时间运行 / 稳定性

注入的渲染层辅助脚本会长期驻留在 ZCode 的 renderer 里，所以它必须便宜且不能泄漏。
用 `_zh_test/stress.mjs`（puppeteer-core 驱动真实 Chromium，60fps 满负荷 DOM churn）实测：

| 指标 | 结果 |
|---|---|
| GC 后 JS 堆增长 | **−0.04 ~ −0.15 MB**（多个变体、多轮，全部回到基线以下） |
| 运行期报错 | **0** |
| DOM 节点数 | 稳定在 130，无堆积 |
| 辅助脚本占主线程时间 | 极端 churn 下约 **0.9~1.1 s / 45 s**（合成负载，真实 UI 远低于此） |
| 单次回调平均耗时 | **0.14 ms** |

加固点：

- MutationObserver 回调、文本处理、属性清理**全部包裹 try/catch**，单个坏节点不会中断整批处理；
- DOM 遍历有**深度上限 60**，极深结构不会爆栈；
- `title` 注入**幂等且自替换**（`el.__zzhT`），元素文案变化时不会累积垃圾；
- 去掉了每个属性 mutation 上一次的 `setTimeout` 分配；
- **无定时器、无逐节点监听、无增长型数组**，不持有任何引用。

> 曾经的优化尝试：把 `MutationObserver` 改成 `attributeFilter` 只观察 6 个属性名。
> 实测**被证伪**——Chromium 本来就按微任务批次派发回调，回调次数完全不变
> （6.6k vs 6.6k），墙钟时间在噪声范围内，却会静默丢掉列表外属性的处理。
> 因此保留了完整的 `attributes:true` 覆盖。详见 `bin/zcode-zh.mjs` 顶部注释。

---

## 9. 升级自愈（v0.4.0 新增）

ZCode 每次升级都会整体替换 `app.asar`，补丁随之消失；而 asar 在 ZCode 运行期间被占用，
只能等它完全退出后才能重打。自愈把这段空档自动化了：**升级后你只需完全退出一次 ZCode，
补丁就会自动回来，ZCode 也会被自动重新打开。**

### 三层触发

| 触发源 | 时机 | 依赖 ZCode hook | 会自动重开 ZCode |
|---|---|---|---|
| SessionStart hook（改造） | 每次会话开始 | 是 | 是 |
| 登录看门狗 `zcode-bilingual-watchdog.vbs` | 每次 Windows 登录 | **否**（独立于 ZCode） | 否（只静默打补丁） |
| `repair.cmd` / `/zcode-bilingual:repair` | 手动 | 否（.cmd） | 是 |

> ⚠️ **登录看门狗在部分机器上会被安全策略拦截**：启动目录里的 `.vbs` / `.cmd` 可能被写入后
> 数秒内删除（`schtasks` / `Run` 注册表项也可能被拒绝）。这类机器上实际是"**SessionStart hook
> 单触发源**"——功能不受影响（升级后开会话即自动布防），只是少了登录兜底。判断是否生效看
> `self-heal.mjs status` 的 `watchdogInstalled`（`arm-watchdog` 报 installed 只代表写入成功）。

### 执行流程

1. 触发源调用 `self-heal.mjs schedule [--sentinel]`：写一个请求文件，并拉起**独立进程 worker**
   （幂等，多会话重复触发只会有一个 worker，靠 `self-heal-worker.lock\` 的 pid 锁去重）。
2. worker 每 5s 检查：`ZCode.exe` 是否已退出、`app.asar` 的 `size:mtime` 是否连续两轮不变
   （避开升级安装器正在替换文件的窗口）。
3. 条件满足 → 调用补丁器 `apply` → 写结果文件 → 消费请求 → 按规则重新打开 ZCode。

### 常驻哨兵（`--sentinel`，v0.4.1 起为默认）

ZCode 用 **electron-updater**：**在 ZCode 关闭期间**替换 `app.asar`，**然后由安装器自己重启 ZCode**。
"事后才被唤醒"的一次性 worker 帮不上忙——等它反应过来，用户已经对着没翻译的界面了。这就是
「每次更新就失效」的根因，因此默认改成常驻哨兵：

- hook 每次会话开始都布防（幂等）；
- 哨兵**故意活过 ZCode 退出**，在关闭后的前 90 秒以 2 秒间隔盯 `app.asar`；
- 签名连续两次不变（安装器写完了）就立刻 `apply --force` + **自动重启 ZCode**，
  安装器拉起的进程因而直接带补丁；
- 打完**不退出**，继续待命；仅当「ZCode 已离开 30 分钟且补丁校验通过」/ 请求被 `cancel` /
  72h 到期时退出。

`repair.cmd` 同样走哨兵，所以手动修复之后也持续受保护。

**两条 hook 一起兜底**（不是冗余）：实测 ZCode 重启后会话已创建、但 SessionStart hook 没跑
（`hook.log` 无新行）。哨兵必须在更新发生**之前**就活着，所以 `UserPromptSubmit` 上再加一道
`ensure-sentinel`：哨兵已活时只读一个文件即静默退出，没有子进程；真的没哨兵时才 spawn，
并带 60s 节流（`sentinel-arm.stamp`）防止 spawn 风暴。

### 版本韧性：补丁点找不到也能打

补丁原本要改 ZCode 里被压缩的 `w(e)`。定位是三级容错（`exact`/`regex`/`anchor` + 扫全部
renderer chunk），但终究耦合**代码形状**——遇到 i18n 重构只能 `exit 4`，翻译彻底失效。

现在加了 **catalog 锚定兜底**：找不到 `w(e)` 时改找**两个大对象字面量**（按 CJK 密度区分
zh/en，向前扫 `=` 取变量名），把 helper 追加到同一 chunk，把这两个变量作为
`{"en-US":m,"zh-CN":p}` 交给 helper。**完全不依赖函数形状**；`status` 的 `patchMode`
会写明走的是 `choke-point` 还是 `catalog-only`。

### 安全边界

- **不打扰**：由登录看门狗触发且 ZCode 未运行时，只静默打补丁，**不会**擅自启动 ZCode。
  想把自动重启也关掉：`%LOCALAPPDATA%\zcode-bilingual\self-heal-config.json` 写
  `{"relaunch": false}`；整个自动布防关掉写 `{"autoHeal": false}`。
- **退避**：同一 `app.asar` 签名（`size:mtime`）连续失败 2 次即停止自动重试，改为提示
  「该版本可能不兼容」——不会每次登录都折腾；手动 `repair` 可越过退避。
- **超时**：72h 没等到 ZCode 关闭 → 记 `timeout` 并保留请求，下次会话/登录重新布防
  （不把「一直没关 ZCode」误判为不兼容）。
- **尊重还原**：`restore` 是显式退出，会清除待修复请求；hook 对「未启用」状态只提示、不自动布防。
- **可取证**：`self-heal.log`、`self-heal-result.json`、`self-heal-request.json`
  都在 `%LOCALAPPDATA%\zcode-bilingual\`。

### 已完成验证（2026-09-19，ZCode 3.12.3 → 3.14.0 实机升级）

- 升级后 `status` 报 `patched:false / needsRepatch:true / zcodeVersion:3.14.0`，hook 实测输出
  「检测到 ZCode 已更新…自动修复已待命」；worker 真实存活等待（pid 4188）。
- `apply --dry-run` 在 3.14.0 上仍是 `exact match`（chunk 名从 `IntlProvider-DvAen4Dk.js`
  变成 `IntlProvider-DCo4gdAe.js`，容错定位未受影响），词典 171 条。
- **副本闭环测试**（隔离数据目录，不动实机）：schedule → worker 等稳定性窗口 → `apply`
  **exit 0** → 副本 `patched:true / marker:__zcodeZhTitle3`、请求被消费、备份已生成，全程 10.0s。
- 依赖 `tasklist` 判进程、`repair.cmd`（CRLF + 纯 ASCII）均已实测通过。
- ⚠️ 登录看门狗：`.vbs` 写入成功但**在本机 5~8 秒内被安全策略删除**（非沙箱假象，已用非沙箱视角复核）；
  `schtasks` 与 `HKCU\...\Run` 均「拒绝访问」。因此本机当前是 **hook 单触发源**，功能正常。

---

## 10. 部署到其他电脑（一键安装包）

`dist/zcode-bilingual-setup-v<版本>.zip`（约 31 MB）是自带 Node 运行时的独立安装包，
目标电脑**不需要装任何东西**（只要有 ZCode）。

```
zcode-bilingual-setup-v0.3.0/
├─ 安装.cmd            ← 双击 = 一键安装（也可把 app.asar 拖到它上面）
├─ 卸载.cmd            ← 双击 = 一键完美卸载
├─ 检查状态.cmd
├─ 使用说明.txt
├─ setup.mjs           ← 安装/卸载逻辑
├─ runtime/node.exe    ← 自带 Node 运行时
└─ app/                ← 插件本体
```

**安装**：完全退出 ZCode（含托盘图标）→ 双击 `安装.cmd`。
脚本会：定位 `app.asar` → 复制插件到 `%LOCALAPPDATA%\zcode-bilingual\app`
→ 注册 inline 插件 → 备份并打补丁 → 记住路径。

- 找不到 `app.asar` 时，把 `app.asar` 文件拖到 `安装.cmd` 上再松手即可。
- 装完可以把这个文件夹整个删掉，插件已经复制到 `%LOCALAPPDATA%` 了。

**卸载**：完全退出 ZCode → 双击 `卸载.cmd`。
会逐字节还原 `app.asar`（并校验大小）、注销插件、删除备份/状态文件/路径记录/插件副本，
最后做一次残留检查。**重复卸载是安全的（幂等）。**

`.cmd` 内容**纯 ASCII**（中文全部由 node 在 `chcp 65001` 之后输出）——
因为 cmd.exe 是按当前代码页读取批处理文件的，`.cmd` 里写中文是个跨机器编码陷阱。


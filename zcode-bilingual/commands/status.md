---
description: Show whether ZCode's hover-to-translate patch is active / 查看「悬停翻译」是否已启用
---

The user wants to know the status of the `zcode-bilingual` plugin's UI patch.

Locate this plugin's bundled patcher (`bin/zcode-zh.mjs` inside the plugin's own
directory — the one registered in `~/.zcode/cli/config.json` under `plugins.dirs`,
plugin id `zcode-bilingual@inline`) and run:

    node <plugin-root>/bin/zcode-zh.mjs status

Report the result to the user in their language. If `upToDate` is `true`, hovering
English UI text shows the Chinese translation.

If the patch is missing, check whether self-heal is already handling it:

    node <plugin-root>/scripts/self-heal.mjs status

That prints the pending request, the last outcome, whether a worker is alive, and
whether the logon watchdog is installed. A live worker means the patch will be
re-applied automatically as soon as ZCode is fully quit, so tell the user exactly
that instead of sending them off to run scripts by hand. `result.ok === false`
(especially with `failCount >= 2`) means auto-repair gave up on this ZCode build:
report that plainly and point at `%LOCALAPPDATA%\zcode-bilingual\self-heal.log`.

Do not attempt to modify any file unless the user asks for `apply`, `repair` or
`restore`.

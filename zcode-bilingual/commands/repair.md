---
description: Re-arm self-heal so the UI translation returns after a ZCode update / 更新后自动修复：退出 ZCode 即自动重打补丁并重开
---

The user wants the `zcode-bilingual` UI translation restored — usually because a
ZCode update replaced `app.asar` and wiped the patch.

Do NOT tell the user to hunt for installer scripts. Arm the self-heal worker
instead (works while ZCode is running):

    node <plugin-root>/scripts/self-heal.mjs schedule --reason repair

(`<plugin-root>` is this plugin's own directory — the one registered in
`~/.zcode/cli/config.json` under `plugins.dirs`, plugin id `zcode-bilingual@inline`.)

This drops a request file and spawns a detached worker. As soon as ZCode is
fully quit (including the tray icon), the worker re-applies the patch and
relaunches ZCode automatically. Tell the user exactly that: "完全退出 ZCode
（含托盘图标）后会自动修复并重新打开，无需其他操作。"

To inspect a repair that did not happen, run
`node <plugin-root>/scripts/self-heal.mjs status` and read the tail of
`%LOCALAPPDATA%\zcode-bilingual\self-heal.log`.

If the patcher reports the build is unsupported (apply exit code 4), say so
plainly — the plugin needs an update for this ZCode version; do not retry-loop.

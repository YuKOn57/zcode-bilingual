---
description: Restore ZCode's original English-only UI / 还原为原始纯英文界面
---

The user wants to undo the `zcode-bilingual` UI patch.

1. Locate this plugin's `bin/zcode-zh.mjs`.
2. Fully quit ZCode first if it is running, then run
   `node <plugin-root>/bin/zcode-zh.mjs restore`.
3. Restart ZCode.

The restore copies `app.asar.zcode-zh.bak` back over `app.asar` byte-for-byte.

A restore is an explicit opt-out: the patcher clears any pending self-heal request
so the background worker cannot re-apply the patch right after the user removed it.
If a worker is still waiting, stop it explicitly with

    node <plugin-root>/scripts/self-heal.mjs cancel

If the file is in use, tell the user to close ZCode (including the tray icon) and
run `restore.cmd` from the plugin folder (it cancels self-heal first).

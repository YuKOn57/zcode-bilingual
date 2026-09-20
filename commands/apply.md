---
description: Enable hover-to-translate tooltips in ZCode / 启用界面悬停翻译（原文与排版不变）
---

The user wants to enable the `zcode-bilingual` hover-to-Chinese UI patch.

The patch rewrites ZCode's `app.asar`, which is locked while ZCode runs, so there
are two paths:

1. Try `node <plugin-root>/bin/zcode-zh.mjs apply`.
2. If it succeeds, tell the user to restart ZCode.
3. If it fails because `app.asar` is in use (exit code 6), do NOT stop at telling
   the user to do it by hand — arm self-heal instead:

       node <plugin-root>/scripts/self-heal.mjs schedule --reason manual

   Then explain: once ZCode is fully quit (including the tray icon), the patch is
   applied and ZCode is relaunched automatically. The manual fallback is the
   shipped `install.cmd` / `apply.cmd`.

The patcher makes a backup (`app.asar.zcode-zh.bak`) before writing and can be
undone with `restore`. Never delete the backup file.

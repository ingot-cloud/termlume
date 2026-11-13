# Termlume 品牌资源

2026-11-13：正式采用用户选定的 A2「光门」与 A「黑粉极简」主题。开放的圆角门框与浮起的光点表达连接和光；窗口入口、横版 Logo 与 App 图标共享同一轮廓。

- `mark.svg`：64×64 单色符号，透明背景，使用 `currentColor`。
- `logo.svg` / `logo.png`：浅色背景的横版 Logo，深色字标、玫瑰色光门。
- `logo-on-dark.svg` / `logo-on-dark.png`：深色背景的横版 Logo，浅色字标、冷粉色光门。
- `app-icon.svg`：1024×1024 App 图标矢量母版；近黑色圆角底、粉色光门、柔和高光和透明外围。
- `app-icon.png`：1024×1024 透明 PNG，可用于展示和分发。
- `preview.png`：深浅 Logo、App 图标和 16/32/64/128 px 标志的展示图。

横版字标已转为路径，无需安装字体；基于 Avenir Next Bold 做字距调整。标志四周至少保留 10/64 的符号宽度；横版 Logo 建议最小高度 24 px。窗口内使用 20 px 单色符号，跟随主题强调色，兼容深浅主题。

深色主题使用近黑 `#141217`、冷粉 `#F58CB8`、浅色文字 `#F8EDF4`；浅色主题使用玫瑰白底和深玫瑰强调色 `#AC356B`。成功保持绿色，警示保持琥珀色，错误保持红色。主按钮使用独立的文字色，悬浮与按下保持对比度。终端深浅选择仍独立于应用主题，并保留主机覆盖设置。

修改 `app-icon.svg` 后执行 `npm run brand:icons`，使用项目自带 Tauri CLI 生成并覆盖 `src-tauri/icons/icon.png`、`icon.icns`、`icon.ico`、1024 px PNG 及历史 pilot 图标。macOS 图标包含透明安全边距，16–1024 px 各尺寸由同一母版生成；不在图标上放置文字。

`mark.svg` 的门框路径和光点矩形也是 `src/ui/index.html` 中 `.brand-mark` 的轮廓。调整符号时同步横版 Logo、App 图标和窗口入口，保持比例与负空间一致。历史候选保留在 `concepts-20261113/`，正式构建只消费本目录的已选母版。

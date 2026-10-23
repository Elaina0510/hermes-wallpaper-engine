# webwallgl vendor 出处

- **上游**：DSH 插件 `dsh-plugin-wallpaper-engine` 内置的 WebWallGL 渲染器产物
  （`lib/webwallgl/`），由该插件自上游仓库同步（sync）而来。
- **版本 / commit**：webwallgl 2.0.2 / `cd56f80131cc40832c6f1084e62bf4a79d81bd45`
  （以 `.upstream.json` 原文为准；dirty=false）。
- **同步时间**：2026-09-30T18:32:39.826Z。
- **源宿主 base 前缀**：`/wallpaper-engine/scene-live`（源 `index.html` 的资源前缀；
  本插件中 media server 改以 `/gl/` 为根，故需 `host.html`）。

## 文件清单

| 文件 | 说明 |
|------|------|
| `index.html` | 源原样（参照物，勿改） |
| `host.html` | 派生版：资源引用 `/wallpaper-engine/scene-live/assets/...` → `/gl/assets/...`，供 media server 实际加载 |
| `web-shim.js` | web 壁纸兼容 shim（作者脚本前注入），契约见 CONTRACT.md §2.3 |
| `assets/renderer-DTLW1Gf0.js` | WebWallGL 渲染器 bundle（~1.0MB，**字节冻结，禁改**） |
| `assets/modulepreload-polyfill-B5Qt9EMX.js` | modulepreload polyfill |
| `.upstream.json` | 上游版本/commit/文件清单 |
| `CONTRACT.md` | 宿主契约唯一权威（20 个查询参数 + postMessage op + 13 个 `__we*`） |

## 约束

- `assets/` 与 `web-shim.js`、`.upstream.json` 与源逐字节一致（sha256 已验）；上游升级时整体替换并更新本文件与 CONTRACT.md。
- `renderer-DTLW1Gf0.js` 严禁手改；任何行为变更走上游升级。
- 契约问题以 CONTRACT.md 为准，源码行号仅作取证锚点（bundle 行号可能随上游版本漂移）。

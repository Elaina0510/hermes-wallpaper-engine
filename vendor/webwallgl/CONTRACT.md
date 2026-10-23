# WebWallGL 2.0.2 宿主契约（CONTRACT）

> 唯一权威。转录自 `vendor/webwallgl/` 源码（webwallgl 2.0.2 / commit
> `cd56f80131cc40832c6f1084e62bf4a79d81bd45`，见 `.upstream.json`），逐条 grep 取证。
> 行号为文件内物理行号（renderer 为 bundle，非逐行可读，行号仅作锚点）。
> 无法在 vendor 源码中定位的条目一律标 `UNVERIFIED`，不做猜测。
>
> 角色约定（web 壁纸链路）：
> - **渲染页**（renderer-DTLW1Gf0.js 所在文档）：由宿主 media server 以 URL 查询参数配置，
>   对 web 壁纸而言它是**父页**。
> - **网页壁纸 iframe**（作者 HTML + 被注入的 web-shim.js）：**子页**。
> - 「父→子 / 子→父」均指渲染页 ↔ 网页壁纸 iframe 这对关系。

---

## §1 查询参数表（20 个）

渲染页启动时读 `new URLSearchParams(location.search)`（renderer L3213，`Ht`），
构建 `Te.cfg = Dg`。默认值与解析式全部来自 L3213 原文；另有 4 个参数在别处独立解析。

| # | 参数 | 解析 / 默认值 | 语义 | 证据 |
|---|------|--------------|------|------|
| 1 | `type` | `(Ht.get("type") ?? "canvas").toLowerCase()` | 场景类型。**`Xa()` 分派表（renderer L3213）**：`video|gif|image` + src → `ES()`；**`scene`** + (source 或 src) → `v_()`（场景链）；`web` + src → `hP()`；**其余（含默认值 `canvas`）→ `onUnhandledType`**（DSH 回退页，见 §4）。⚠ 因此 scene 壁纸必须显式传 `type=scene`，传 `canvas` 不会进场景链 | renderer L3213（`Xa`）；L1（诊断文案「缺少 src」） |
| 2 | `src` | `Ht.get("src") ?? void 0` | **不是文件 URL，是 base**。场景链拼接待 `mountScene`：`const y = e.source ?? DS(`${e.mediaBase}/${e.src}`)`，随后 `DS.scenePkg()` 在候选名 `NS = ["scene.pkg","scenes/scene.pkg","gifscene.pkg"]` 中择一（renderer L1268、L992）。⚠ 所以 `src` 应传 `/s/<token>`（目录 token 根），**不是** `/s/<token>/scene.pkg`——那样会拼成 `…/scene.pkg/scene.pkg` 404。另：`src` 为绝对 URL 时 `mediaBase` 拼接会产出 `//host/…` 畸形路径，宿主须保证 rel 形态 | renderer L3213；L1268（`mountScene` 拼接）；L992（`NS`） |
| 3 | `fit` | `Ht.get("fit") ?? "cover"` | 画面适配。映射（`sr()`）：`fit`→`contain`、`fill`→`cover`、`contain`→`contain`、`stretch`→`stretch`、其余→`cover` | renderer L3213（cfg）；L1（`sr`） |
| 4 | `renderDpr` | `Number(Ht.get("renderDpr")) \|\| 0` | 渲染 DPR 覆盖；0/缺省=自动（`E1`/`ls` 回退 `window.devicePixelRatio`，受 `resources` 门控） | renderer L3213；L1（`E1`、`ls`） |
| 5 | `vidscale` | `Number(Ht.get("vidscale")) \|\| 0` → `videoTexScale` | 视频纹理缩放；0/缺省=自动 | renderer L3213 |
| 6 | `sceneFps` | `Number(Ht.get("sceneFps")) \|\| 60` | 场景帧率上限，默认 60（帧节流器 `new Qs(t.cfg.sceneFps \|\| 60)`） | renderer L3213；L992 |
| 7 | `muted` | `Ht.get("muted") !== "false"` | 静音，**默认 true**（只有显式 `muted=false` 才出声） | renderer L3213 |
| 8 | `loop` | `Ht.get("loop") !== "false"` | 循环播放，**默认 true**（只有显式 `loop=false` 才单次） | renderer L3213 |
| 9 | `filter` | `Ht.get("filter") ?? void 0` | CSS 滤镜预设，缺省按 `none`。预设表 `mP`：`invert`→`invert(1)`、`brighten`→`brightness(1.3)`、`darken`→`brightness(0.72)`、`contrast`→`contrast(1.35)`；应用于场景容器 `t.wrap.style.filter`（`cc()`） | renderer L3213（cfg + `cc`/`mP`） |
| 10 | `mediaBase` | `Ht.get("mediaBase") ?? void 0` | 媒体基址。用途：`src` 相对拼接（L1268）、诊断 origin 探测 `new URL(mediaBase, location.href).origin`（L1） | renderer L3213；L1；L1268 |
| 11 | `autoq` | `Ht.get("autoq") === "0" ? false : void 0` → `autoQuality` | 自动质量，**默认启用**；显式 `autoq=0` 关闭 | renderer L3213 |
| 12 | `bake` | `Ht.get("bake") === "0" ? false : void 0` | 图像预缩放（bake），**默认自动**（`HS()` 按尺寸/字节量决策）；显式 `bake=0` 关闭 | renderer L3213；L992（`HS`）；L1268 |
| 13 | `liveSystem` | `(Ht.get("liveSystem")==="1" \|\| Ht.get("liveSystem")==="true")` | 系统音频 artwork 实时层，默认 false | renderer L3213；消费 L1268（artwork 音轨） |
| 14 | `opaque` | `(Ht.get("opaque")==="1" \|\| Ht.get("opaque")==="true")` | 不透明底，默认 false。`$1()`：true→`background:#000`，false→`transparent` | renderer L3213；消费 L1（`$1`） |
| 15 | `webSandbox` | `Ht.get("webSandbox")==="strict" ? "strict" : void 0` | web 壁纸严格沙箱（`sandbox="allow-scripts"`，不透明源下的存储兜底由 shim 承担） | renderer L3213；消费 L3213（`strictSandbox`）；shim L42-60（兜底注释） |
| 16 | `clearColor` | `Ht.get("clearColor") ?? void 0` | 清屏色（空格分隔 RGB 字符串），有值时写 `general.clearcolor` 并置 `clearenabled=true` | renderer L3213；消费 L1268 |
| 17 | `resources` | 独立解析：`l0()`/`E1()`，`n==="native" \|\| n==="off" \|\| n==="0"` 时资源缩放关闭（返回真值门控） | 资源/纹理资源缩放总开关，默认启用 | renderer L1（`l0`、`E1`） |
| 18 | `texr8` | `new URLSearchParams(location.search).get("texr8")`；`"0"/"off"/"native"` → 关，**默认开** | R8 单通道纹理压缩路径 | renderer L1268 |
| 19 | `texcompress` | 同上解析式；`"0"/"off"/"native"` → 关，**默认开** | 纹理压缩总开关 | renderer L1268 |
| 20 | `localAssets` | `n_()`：`"0"/"off"/"false"`→`off`；`"all"`→`all`；`"1"/"on"/"true"`→`lazy`；**默认 `off`** | 本地素材库访问模式；`all`/`lazy` 经 `/api/local-assets` 端点（`Ac`） | renderer L992（`n_`、`Ac`） |

勘误说明：起始 prompt 写「19 个查询参数」为笔误，F14 逐一点数共 **20** 个，本表与之一致。

---

## §2 postMessage op 表（含方向）

### §2.1 父→子：渲染页 → 网页壁纸 iframe

统一信封：`iframe.contentWindow.postMessage({ __we:1, op, ...载荷 }, "*")`
（renderer L3212，`Ig()` 及行内转发器）。渲染页优先**同源直调**（`Eg()` 路径），
跨源/沙箱场景才落到 postMessage；两条路语义一致（shim 头部注释 L16-24 与 L1878-1879）。

| op | 载荷字段 | 落到子页的方法（签名） | 证据 |
|----|---------|----------------------|------|
| `setPaused` | `v: boolean` | `__weSetPaused(!!d.v)` | 转发 renderer L3212；shim 分发 L1886-1888 |
| `setVolume` | `v: number (0..1)` | `__weSetVolume(Number(d.v) \|\| 0)` | 同上 L1889-1891 |
| `setFps` | `n: number` | `__weSetFps(Number(d.n) \|\| 0)` | L1892-1894 |
| `applyProps` | `props: object` | `__weApplyProps(d.props)` | L1895-1897 |
| `pointer` | `x, y, b(buttons), m(mods): number` | `__wePushPointer(x, y, b, m)` | L1898-1902 |
| `pointerLeave` | 无 | `__wePointerLeave()` | L1903-1905 |
| `audio` | `a: number[]`（0-255 量化整数，~20fps 快照） | `__wePushAudio(arr/255)`（子页还原为 0..1 浮点）；父页侧 50ms 节流（`B_`） | L1906-1914；节流 renderer L3212 |
| `media` | `ev: {op, payload}` | `__wePushMedia(d.ev)` | L1915-1917；经 `Ig()` 发出 |
| `wheel` | `x, y, dx, dy, mode, mods: number` | `__wePushWheel(x, y, dx, dy, mode, mods)` | L1918-1929 |

**仅有直调、无 postMessage op 的 4 个方法**（shim L1885-1929 的 `switch` 中无对应 case，
只能经同源直调或宿主注入）：`__weSeedProps`、`__wePushDirectoryFiles`、
`__weRemoveDirectoryFiles`、`__weRewriteFileUrl`。

### §2.2 子→父：网页壁纸 iframe → 渲染页

| 消息 | 载荷 | 语义 | 证据 |
|------|------|------|------|
| `{ op: "we-frame", t: number }` | `t = performance.now()` | 帧心跳（每帧一次，含节流层路径）；父页消费：`o.source` 校验 → `frameClock.last`、FPS 计量（`si`/`cP`）、暂停态丢弃 | 发：**仅**嵌在 renderer 内的 web 壁纸 shim 模板（`N_=` 模板字符串，起点 renderer offset 904965 / L1273；两处 emit 在 L3073、L3118——**注意这两行在模板字符串内，属 shim 而非 render 页自身代码**）；shim 独立文件本身也含同两处 emit；收：renderer L3213（`addEventListener("message")`，条件是 `u.op!=="we-frame"` 才 continue） |
| `{ id, ... }` 请求响应 | — | **UNVERIFIED**：vendor 源码中未找到页面级 `{id,...}` 请求/响应协议。唯一带 `id` 的 postMessage 往返是 renderer **内部 Web Worker**（color/alpha 合并器）的 `postMessage({id, color, alpha})` / `{id, frame}` / `{id, error}`（renderer L235），属 worker↔渲染页，不是宿主契约。F14 所述 `{id,...}` 若存在，可能在上游未打包部分，待 T1 集成时按运行时观测补录 | renderer L235（worker，非宿主契约）；全文件 postMessage 枚举：仅 we-frame ×4（全在 shim 模板内）、`__we:1` 信封 ×2、worker ×4 |

> **⚠ scene 类型下没有心跳通道（T0.3 实测确认）**：`we-frame` 只由 web 壁纸 shim 发出。当 iframe 是
> `/gl/host.html?type=scene` 时，子帧是 render 页自身，**它不向父页发任何 postMessage**。因此
> T16 的「心跳 ≥3 次」判据在 scene 类型下不成立；宿主只能靠 ① 10s 超时回退 preview、② renderer 的
> `/diag` beacon（见 §4）获知失败。这是 T0.3 最重要的契约观测结果。

> **⚠ 错误通道不是 `{op:"error"}`**：全文件 `op:"error"` 命中数为 **0**。renderer 的实际上报通道是
> HTTP beacon：`GET ${origin(mediaBase)}/diag?msg=<scene …>&lvl=error|warn|info`（renderer L1，`e1()`）。
> 宿主侧 `/diag` 端点需自行实现才能收到；设计文档 §9「场景宿主 10s 无心跳 → 回退 preview」仍然有效，
> 但那是超时兜底，不是错误通知。


### §2.3 shim 控制面：13 个 `__we*` 方法（F15）

注入要求：shim 必须作为 `<head>` 首个 classic script，**先于作者脚本**执行（shim L2-10）。
幂等守卫 `w.__weShimInstalled`（L32-33）+ `data-we-shim` 属性，防双注（L28-31：实测双注帧率限两次 15→7.5fps）。
宿主可**先于 shim** 声明站点根 `window.__weSiteRoot`（可选，L12-14、L264）。

| # | 方法 | 签名（定义行） | postMessage 别名 | 语义 |
|---|------|---------------|-----------------|------|
| 1 | `__weSetPaused` | `(v)` L1089 | `setPaused` | 暂停/恢复 |
| 2 | `__weSetFps` | `(n)` L1107 | `setFps` | 帧率上限 |
| 3 | `__weSetVolume` | `(v)` L1114 | `setVolume` | 音量 0..1 |
| 4 | `__weApplyProps` | `(props)` L1121 | `applyProps` | 应用用户属性 |
| 5 | `__weSeedProps` | `(props)` L1143 | —（仅直调） | 种子属性（首帧前注入） |
| 6 | `__wePushAudio` | `(arr)` L1152 | `audio`（量化 0-255） | 音频快照喂给 `wallpaperPropertyListener("audio")` 类监听 |
| 7 | `__wePushMedia` | `(payload)` L1169 | `media` | `Media*Listener` 事件 `{op, payload}` |
| 8 | `__wePushDirectoryFiles` | `(propertyName, files)` L1191 | —（仅直调） | `userDirectoryFilesListener` 类：目录新增 |
| 9 | `__weRemoveDirectoryFiles` | `(propertyName, files)` L1213 | —（仅直调） | 目录移除 |
| 10 | `__weRewriteFileUrl` | `(s)` L428（`rewriteWeFileUrl`） | —（仅直调） | `file:///`→同源相对；相对 URL 逃出站点根时把 `..` 夹回根（官方语义，L20-22） |
| 11 | `__wePushPointer` | `(x, y, buttons, mods)` L1481 | `pointer` | 外部指针注入 |
| 12 | `__wePointerLeave` | `()` L1749 | `pointerLeave` | 指针离域 |
| 13 | `__wePushWheel` | `(x, y, dx, dy, mode, mods)` L1575 | `wheel` | 外部滚轮/触摸板捏合注入 |

子页 postMessage 控制分发器：`message` 监听 L1881，信封校验 `d.__we !== 1` 即忽略（L1883）。

---

## §3 派生文件与字节一致性

| 文件 | 与源关系 |
|------|---------|
| `index.html` | 原样复制（参照物）。script src = `/wallpaper-engine/scene-live/assets/renderer-DTLW1Gf0.js`（源宿主 base 前缀） |
| `host.html` | 由 index.html 派生：仅两行资源引用改为 `/gl/assets/...`（media server 以 `/gl/` 为根服务本目录），并加一行派生注释；其余字节逐行同 index.html |
| `web-shim.js`、`assets/*`、`.upstream.json` | 原样复制，sha256 与源一致（见验收记录） |

renderer 静态资源依赖（全文件 postMessage/import 枚举确认，无遗漏）：
- 唯一 ESM import：`import"./modulepreload-polyfill-B5Qt9EMX.js"`（文件首 0 偏移，相对 import，
  相对模块自身 URL `/gl/assets/` 解析 → `/gl/assets/modulepreload-polyfill-B5Qt9EMX.js`）✓ host.html 已覆盖
- 无其它 `fetch`/`<link>`/`<img>` 级静态资源引用（`assets/` 字面量余下 3 处全在注释块内）

---

## §4 宿主侧必修项（T0.3 spike 实测，2026-10-20）

### 4.1 `/diag` beacon 端点（必须实现）

renderer 的错误/警告上报通道是 HTTP GET（不是 postMessage）：

```js
// renderer L1，函数 e1()
`${origin(mediaBase)}/diag?msg=${encodeURIComponent(`scene ${id}: ${msg}`)}&lvl=${error|warn|info}`
```

- `origin(mediaBase)` = 从查询参数 `mediaBase` 解析出的 origin（renderer L1：`new URL(e.mediaBase, location.href).origin`）。
  宿主须显式传 `mediaBase`（或让 renderer 用 `location.origin`），否则 beacon 打到别的域上收不到。
- 该请求**不应影响壁纸渲染**（fire-and-forget）；宿主 `/diag` 需接住并记入诊断列表（§9「媒体请求路径逃逸 → 403 + 记录 diag」同源思路）。
- 未实现 `/diag` 的后果：renderer 的控制台外无任何错误可见，宿主只能靠 10s 超时兜底。

### 4.2 未识别 `type` 的回退页是 DSH 专属，本插件必然 404

`Xa()` 的 `onUnhandledType` 分支会插入一个 iframe，src 硬编码：

```js
// renderer L3213
e.src = "/wallpaper-engine/scene-live/default-wallpaper/index.html"
e.setAttribute("sandbox", "allow-scripts");
```

该路径在 DSH 宿主下存在，在本插件的 media server 下**不存在**（`/gl/` 与 `/s/` 是仅有的两条服务路由）→ 404。
因此：**宿主必须自己实现 preview 图回退**，不能依赖 renderer 的回退页。传错 `type`（如把 scene 壁纸传成
`canvas`）在本插件下的表现是「内层 404 iframe」，不是可用的占位画面。


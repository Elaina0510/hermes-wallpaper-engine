# 壁纸引擎 · Hermes 桌面端插件

把本机 Steam **Wallpaper Engine** 的壁纸放到 Hermes 桌面窗口背后实时播放，同时把界面换成**液态玻璃 + 独立卡片**：外壳、卡片、浮层三档浓度各自可调，卡片化可一键开关。

`插件 id` wallpaper-engine · `版本` 1.0.0 · `宿主` Hermes 桌面端（Electron） · `许可证` MIT

> [!NOTE]
> 本项目**不是原创**，是 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）的 Hermes 桌面端移植，scene / web 壁纸的渲染器来自 [oneincase/webwallgl](https://github.com/oneincase/webwallgl)（MIT）。改动清单见文末「致谢」。

## 简介

壁纸本来只在桌面上看得见。这个插件把它挪到 Hermes 窗口后面继续播放：你打字、翻会话、开面板，它都在那儿动，不挡操作。

界面顺手也改了。左侧栏和对话区变成半透明的玻璃，壁纸从底下透出来一点，浓度可以拖。对话、技能与工具、消息平台、设置和定时任务，各自收进一张圆角卡片；不想看就关掉卡片化，界面立刻回到原样。

它是插件，不是补丁：不改 Hermes 源码，不重打包 exe；也不给 agent 注册工具、不往对话里塞提示词，所以用起来不会额外花 token。

技术上分两半：后端一个 FastAPI router（挂在 `/api/plugins/wallpaper-engine/`）加一个只监听 `127.0.0.1` 的媒体服务；前端是 `desktop/src/` 下六个 js 片段拼成的单文件 `desktop/plugin.js`。

## 目录

- [能做什么](#能做什么) · [支持哪些壁纸类型](#支持哪些壁纸类型) · [安装与启用](#安装与启用) · [使用](#使用)
- [配置与数据](#配置与数据) · [兼容与限制](#兼容与限制) · [架构一览](#架构一览) · [验证清单](#验证清单)
- [排障表](#排障表) · [开发指南](#开发指南) · [致谢](#致谢)

## 能做什么

- **真壁纸，不是静态图**：视频、图片、Scene（WebGL 实时渲染）、Web（作者自己的网页）四类都能上屏。
- **液态玻璃**：外壳（左侧栏等外围）、卡片（对话区与页面）、浮层（设置/定时任务）三档浓度独立，壁纸始终透在下面。
- **界面卡片化**：对话区、技能与工具、消息平台、设置与定时任务统一成同一张圆角玻璃卡；一个开关全部收起。
- **壁纸库**：扫描本机 Steam 库，按类型/分级过滤、搜索、一键切换，支持手动追加库目录。
- **自动轮换**：按间隔换壁纸，可洗牌。
- **不占 token**：全部设置与壁纸状态都在宿主端，agent 看不到也不需要看。

## 支持哪些壁纸类型

| 类型 | 能不能上屏 | 怎么放 |
|------|-----------|--------|
| `video` | ✅ | 图层里直接放 `<video>`，循环播放 |
| `image` | ✅ | `<img>`，按「填充方式」铺满 |
| `scene` | ✅ | vendor WebWallGL：图层里挂 `/gl/host.html` iframe，由媒体服务注入场景目录 |
| `web` | ✅ | 作者自己的网页，媒体服务注入 shim，严格沙箱 |
| `application` | ❌ | 需要外部进程（.exe 类），本插件不执行 |

⚠ `scene` / `web` 是跨源 iframe 且**没有心跳通道**，所以「失焦暂停」对它们不生效——这是设计边界，不是 bug。

## 安装与启用

> 结论先说：**第 3 步（改 `config.yaml`）需要你本人确认后才能执行**。本 README 只写出那一步的确切写法与当前现状，不代替你改配置。

### 步骤 1 — 确认插件树在位

```bash
ls <HERMES_HOME>/plugins/wallpaper-engine/dashboard/manifest.json \
   <HERMES_HOME>/plugins/wallpaper-engine/dashboard/plugin_api.py \
   <HERMES_HOME>/plugins/wallpaper-engine/desktop/plugin.js
```

三个文件缺任一个都不是可用安装：

- `dashboard/manifest.json` 是后端被发现的前提（Hermes 扫 `<plugins root>/*/dashboard/manifest.json`）。
- `dashboard/plugin_api.py` 必须暴露模块级 `router`。
- `desktop/plugin.js` 是桌面端要加载的文件；源码改了没重建就会出现「面板是新的、行为是旧的」这种诡异现象（见 §7.3）。

### 步骤 2 — 构建前端产物

```bash
cd <HERMES_HOME>/plugins/wallpaper-engine
python desktop/build.py
```

- 期望输出：`built: ... from 6 file(s), 327011 bytes` + `sha256: a06d3bd7…`。
- 若你改过 `desktop/src/*.js`，这一步必跑；产物变了就说明源码真的生效了。
- `build.py` 只用标准库，任何 Python 3 都能跑（本机用 3.12.10 实测；更早版本未实测）。

### 步骤 3 — 把 `wallpaper-engine` 加进 `config.yaml` 的 `plugins.enabled` ⚠ 需你确认

**为什么非做不可**：用户插件的 Python **只有**出现在 `plugins.enabled` 白名单里才会被 import（宿主 `hermes_cli/web_server_dashboard.py:775` 的 `_plugin_api_mount_skip_reason()`，GHSA-mcfc-hp25-cjv7 的 opt-in 设计）。不在白名单里，`/api/plugins/wallpaper-engine/*` 全部 404，桌面端也拿不到后端。

**当前现状（已实地核对）**：`<HERMES_HOME>/config.yaml` 的 `plugins:` 段只有 `clone_timeout_seconds: 300`，**没有** `enabled` 键：

```bash
$ hermes config get plugins.enabled
Config key not set: plugins.enabled
```

**要执行的那一步（两种写法，选一种）**：

推荐 **A. 用 CLI**（`plugins.enabled` 是 schema 里的 list 容器，YAML 列表字面量会被解析成真 list）：

```bash
hermes config set plugins.enabled '["wallpaper-engine"]'
```

> 这条命令**没有执行**（执行就等于改了 `config.yaml`）。它的可行性是读宿主源码确认的：`hermes_cli/config.py` 里 `_KNOWN_CONTAINER_TYPES` 把 `plugins.enabled` 钉成 `list`，`_coerce_config_set_value()` 对以 `[` 开头的值走 `yaml.safe_load()` 得到真 list，`_refuse_container_type_mismatch()` 会拒绝非 list 形状——所以这里写错形状不会安静地存成字符串。

**B. 直接编辑 YAML**（等价，适合你已经有多条条目、想追加而不是重写）：

```yaml
plugins:
  clone_timeout_seconds: 300
  enabled:
    - wallpaper-engine
```

**取舍**：

- 选 A 的理由：一条命令、不用手改 YAML 缩进、Hermes 自己写 `config.yaml`（原子写）；`hermes config set` 对 list 槽有形状护栏，写错形状会被直接拒而不是安静存个字符串。
- A 的坑：`config set` 是**整键替换**。今天 `plugins.enabled` 不存在，所以没有丢东西的风险；**但**如果你以后还启用了别的插件，再跑一次 A 会把旧条目覆盖掉——那种情况下用 B 追加。
- 无论 A/B，都请先备份：`cp <HERMES_HOME>/config.yaml <HERMES_HOME>/config.yaml.bak-we`。

**这一步不许跳过确认**：配置变更会即刻影响整台机器上所有 Hermes 会话的插件加载，请在明确同意后再执行。

### 步骤 4 — 重启，让新白名单生效（并确认真的重启了）

```bash
hermes gateway restart
```

⚠ 关于「重启谁」的一个实测发现：插件后端是在 **web/serve 进程**里 import 的（`web_server_dashboard.py` 的 `_mount_plugin_api_routes()`，路由挂载点在同一文件 :878 的 `app.include_router(..., prefix="/api/plugins/<name>")`）。本机 desktop 的 serve 进程与 gateway 是两个不同 PID（`gateway.pid` 的 gateway ≠ `hermes dashboard --status` 列出的 serve）。所以：

- **命令行起的面板**：`hermes dashboard --stop` 之后再 `hermes dashboard`。
- **桌面应用**：退出 Hermes Desktop 再重开，serve 随之重建（这是按应用生命周期推断的行为，**未逐项验证**——请用 `hermes dashboard --status` 的 PID 变化确认）。
- gateway 侧的配置重读：`hermes gateway restart`。

**验证「真的重启了」**（本项目铁律：不认「我重启了」，只认日志里的新时间戳）：

```bash
grep -n 'Starting Hermes Gateway' <HERMES_HOME>/logs/gateway.log | tail -1
```

记录执行前的最后一行时间戳，重启后再跑一次，必须看到**更新的一行**（格式实测如 `2026-10-20 11:25:13,373 INFO gateway.run: Starting Hermes Gateway...`）。

serve 侧用 PID 判：

```bash
hermes dashboard --status      # 记住 PID
# 重启后再跑，PID 必须变
```

重启后后端是否真被挂载，也可从 web server 日志里找 `Mounted plugin API routes: /api/plugins/wallpaper-engine/`（该日志语句存在于宿主源码；**未验证**本机会话里它的具体落点文件，属待真机确认项）。

### 步骤 5 — 在 Capabilities ▸ Plugins 打开插件

打开 Hermes Desktop → Capabilities ▸ Plugins → 找到 **Wallpaper Engine** → 打开开关。

要点（设计 §7.6，两个开关是**独立**的）：

| 开关 | 位置 | 含义 |
|---|---|---|
| Plugins 页开关 | Capabilities ▸ Plugins | 模块是否**加载**。关 → `plugin.js` 不执行，面板入口、壁纸层、玻璃全部消失 |
| `settings.enabled` | 外观设置页的「启用壁纸」 | 功能是否**生效**。关 → 面板入口还在，壁纸层移除、玻璃 token 还原 |

插件清单里 `tab.hidden: true`：它**不会**在面板左侧出现独立页签。UI 是一个可停靠窗格（默认以边缘标签收起），外加设置页「外观」里的模态载体（空闲时不可见）。

桌面端如何拿到 `plugin.js`：Electron 解析插件根时执行 `reconcileUnifiedDesktopHalves`，把本目录的 `desktop/` 整树**增量幂等**复制到 `<HERMES_HOME>/desktop-plugins/wallpaper-engine/`（marker 存在且源 mtime 未变则跳过；无 marker 但字节相同则补 marker；无 marker 且内容不同视为用户手工安装、一律不动）。这一步发生在 renderer 每次扫描前，所以**改完 `src/` 重建后不需要你手工 copy**。⚠ 该行为是宿主实现（设计 §7.1），本仓库无法自证；`<HERMES_HOME>/desktop-plugins/` 当前是空目录，说明尚未有插件被复制过去——**未验证，待真机确认**。

---

## 使用

**两个入口**：左侧栏「壁纸引擎」一行（和「技能与工具」「消息平台」并列），或者工作区标签条里的「壁纸引擎」标签。侧栏那行点下去会把这个标签顶到前面，不会顶掉你正在看的对话。

面板共 20 行设置，每行后面都有括号说明它管什么：

| 分组 | 设置 |
|------|------|
| 开关 | 启用壁纸 · 界面卡片化 |
| 壁纸 | 当前壁纸 · 壁纸库（打开选择器） |
| 玻璃 | 外壳浓度 · 卡片玻璃 · 浮层透明度 |
| 画面 | 壁纸模糊 · 亮度 · 对比度 · 饱和度 · 壁纸不透明度 · 暗膜 |
| 播放 | 填充方式 · 转场 · 场景实时渲染（+帧率）· 后台暂停 |
| 其它 | 轮换（开关+间隔）· 壁纸库扫描 · 诊断信息 |

三档玻璃的分工：**外壳浓度**管左侧栏和外围，**卡片玻璃**管对话卡与页面卡，**浮层透明度**管设置 / 定时任务这类浮层——因为浮层要压住背后的页面，不能和卡片共用一个值。

滑块拖动时只改本地预览，松手（`pointerup`）才写一次后端，避免每帧一次 PUT。

## 配置与数据

配置只有一个文件：`data/config.json`（插件首次启动时自己 seed 默认值；删掉即恢复默认，不影响壁纸文件）。字段结构：

- `version`：文档版本，当前 **2**（v1 会自动升级，旧键名有别名映射）
- `currentId`：当前壁纸 id（路径哈希；无法映射的旧 id 会被清空并要求重新选择）
- `settings`：全部设置项，写入口是 `PUT /config` 的 JSON Merge Patch

几个容易踩的约定：

- **单位**：`scrim`（暗膜）在线上是 0.0–0.9 的小数、滑杆上显示 0–90 的整数，由面板做换算；其余百分比字段线上与显示一致。
- **夹紧**：越界值不报错，夹到边界并在响应里回一张 `clamped` 收据（例如 `cardBase: [-5, 0]`）。
- **布尔字段**（`enabled` / `uiCards` / `flip` / `videoMuted` / `pauseOnHidden` / `pauseOnBlur` / `sceneLive`）只接受真正的布尔值；传字符串会保留原值，不会把 `true` 当 1。
- **原子写 + 损坏备份**：写盘走临时文件替换；读到坏 JSON 会备份原文件再重建，不会静默丢掉用户数据。

默认值基线：暗膜 `0.25`、外壳浓度 `55`、卡片玻璃 `45`、浮层透明度 `55`、`uiCards` 开启。

## 兼容与限制

- **只在 Hermes 桌面端里工作**：壁纸渲染、卡片化、玻璃浓度都依赖 Electron 渲染层的 DOM 结构与 CSS 变量。
- **靠宿主 DOM 接缝**：卡片化是插件注入的 CSS，压在 `[data-chat-surface]`、`[data-zone-body] section`、`[data-glass-raised]` 这些宿主节点上；宿主改版就可能失效——那时改插件即可，不需要动宿主。
- **设置 / 定时任务是浮层，不是页面**：宿主把它们渲染成模态浮层（背后压暗、四周内缩 48px），插件只能改材质，改不了它们的打开方式。要变成主窗口页面属于宿主改动，本项目不做。
- **scene / web 无失焦暂停**，见上文「支持哪些壁纸类型」。
- **不执行 .exe 类壁纸**。

### 已知限制与未决项

如实列，不美化：

1. **`mediaOrigin` 只在 bootstrap 时读一次**。它来自 `GET /library` 的响应，而 `weBootstrap()` 只在 `register()` 时跑一次。serve 进程一旦重启（媒体服务换端口），renderer 手里的就是**旧端口**，所有 `<video src>` 指向死地址。目前唯一的恢复手段是重启桌面端。要做热恢复，得给 `/status` 加轮询或在图层加载失败时重取 origin。
2. **scene / web 没有心跳通道，暂停对它们不生效**。`WE_LAYER_RENDERED_KINDS = ['video','image','scene','web']`，四类都能上屏；但 scene/web 是跨源 iframe，`we-frame` 心跳只发到渲染页（CONTRACT §2.2），我们既读不到也控制不了 → `pauseOnHidden` / `pauseOnBlur` 只对 video 有效，iframe 会一直渲染（CPU/GPU 常驻）。要控就得上桥接控制面（`{__we:1, op:"setPaused"}` 只对 web 壁纸 iframe 有效，渲染页本身不收），目前未做。
3. **jsdom 不解码媒体**。`tests/frontend/10-layer.test.mjs` 里 `readyState >= 2` / `currentTime` 递增是 **HTMLMediaElement 桩**的证明：证明的是「模块与媒体元素的契约」（src 正确、监听挂上、`loaded` 后转 active 并 `play()`、释放时 `pause()` + `src=''` + `load()`），**不是真实解码**。T14 必须真机看画面。
4. **[PV-2] 聊天卡真实取色未决**。候选 token `--ui-chat-surface` 是猜的、代码里**故意 disabled**（只列报不写）；`--ui-chat-surface-background` 是否就是聊天卡实际背景，需要在活桌面 DevTools 里读 `[data-chat-surface]` 的 computed background 才能定。未改结构前不要当真。
5. **preview 走 `file:///`，未验证**。媒体服务没有 preview 路由，`WallpaperItem.preview` 是绝对路径，前端手工拼成 `file:///…`。真实 Electron renderer 里能否加载 file:// 图片**未验证**；最坏情况是彩色占位块（有 `img` error 降级），不是破图。后续可加 `/p/<token>` 预览路由。
6. **壁纸库模态曾是独立贡献，现在不是了**。它早期注册在 `appearance.extra`，2026-10-20 面板搬到 `panes` 后那个 seam 不再渲染，模态贡献停在未挂载状态——React 只给**已挂载**的组件订阅 store，所以点「打开壁纸库」只会把 `pickerOpen: true` 写进一个没人监听的 store，对话框永远不出现。现在的修法是让模态作为**面板 React 树的最后一个子节点**（视觉上仍是全屏 overlay，因为它是 `position: fixed; inset: 0`）。副作用：将来若要从**插件外**（壁纸层右键、托盘）打开壁纸库，不能靠新增贡献，得让那个入口也写 `store.pickerOpen`。
7. **`scrim` 单位不一致**。存储与 clamp 是 `0.0–0.9` 的分数，面板滑杆显示 `0–90`（有显式换算）。直接看 `data/config.json` 里的 `"scrim": 0.25` 不要以为是 25。
8. **§8.4 与 §8.1 的方向矛盾（文档待修，代码按公式）**。§8.4 写「外壳浓度 左=不透明，右=全透」，§8.1 的公式是 `alpha = panelBase/100`（100 = 不透明）。实现按**公式/数据**走（0=透，100=不透），只改滑杆标签方向解决不了，需要改设计文档。
9. **`/diag` beacon 已实现（2026-10-22）**。`GET /diag?msg=&lvl=` → 204 + 环形缓冲（50 条），`GET /diag/recent?limit=N` 读回。scene 是跨源 iframe 且**没有心跳通道**（CONTRACT §2.2），所以它是唯一能看到渲染器错误的地方；面板尚未消费这个接口（现在只能用 curl/浏览器看）。
10. **`defaultEnabled: true` 是否符合产品预期未定**（默认装好即加载，仍受 `plugins.enabled` 白名单约束）。
11. **面板滑块在 jsdom 下键盘释放路径只做了源码级断言**（jsdom 的 React range `keyup` 会抛异常），共享的 commit 路径已由 `pointerup` 覆盖。
12. **未做真机验收的部分**：视频壁纸真实播放（T14）、桌面端 reconcile 复制、Plugins 页开关与 `settings.enabled` 联动、玻璃在真实主题下的取值——全部待真机确认。scene 的画面 2026-10-22 已在真机渲染页验过（1262×568、非黑），web 也在渲染页验过（`iframeLoaded:true`、`webError:null`、shim 已注入）；**桌面端内嵌 iframe 的最终观感仍需用户确认**。

---

## 架构一览

### 目录树

```text
plugins/wallpaper-engine/
├── README.md                 ← 本文
├── dashboard/                ← 后端（Python，仅依赖 stdlib + 由 Hermes 提供的 fastapi）
│   ├── manifest.json         ← 插件清单：name/label/description/icon/version/tab/api
│   ├── __init__.py
│   ├── plugin_api.py         ← FastAPI router（/status /library GET|PUT /config）+ import 期启动媒体服务
│   ├── scan.py               ← Steam 库发现 + project.json 解析 + 类型分类（kind）
│   ├── media_server.py       ← 127.0.0.1 媒体服务（/m /s /gl /health），Range、路径围栏、HTML shim 注入
│   └── config.py             ← data/config.json 配置文档：默认值、clamp、Merge Patch、原子写、损坏备份
├── desktop/                  ← 桌面端（ESM，单文件产物）
│   ├── build.py              ← 构建脚本：src/*.js → plugin.js（确定性、规则校验）
│   ├── src/                  ← 构建输入（6 个片段，见 §1.3）
│   └── plugin.js             ← 构建产物（宿主加载的就是它；由 build.py 生成，勿手改）
├── vendor/webwallgl/         ← WebWallGL 渲染器原样搬运（场景壁纸用）
│   ├── host.html             ← 派生宿主页（资源前缀改为 /gl/）
│   ├── web-shim.js           ← 网页壁纸兼容 shim（后端注入到作者页 head）
│   ├── assets/               ← renderer bundle（字节冻结，禁改）
│   ├── index.html            ← 上游原样参照物
│   ├── CONTRACT.md           ← WebWallGL 契约权威（查询参数 / postMessage op / __we* 控制面）
│   └── .upstream.json        ← 上游版本与 commit
├── data/                     ← 运行时数据
│   └── config.json           ← 用户配置文档（唯一 settings 真源；version 2）
└── tests/                    ← 测试
    ├── test_*.py             ← pytest 后端套件（9 个文件，见 §7.1）
    ├── test_manifest.py      ← 清单契约
    ├── frontend/*.test.mjs   ← node 前端套件（6 个文件，见 §7.2）
    ├── fixtures/             ← 伪造 Steam 树 / 假库 / 媒体树等固定数据
    └── harness/              ← CDP 桥探针（bridge.js / cdp_driver.mjs / 假页面）
```

### 后端路由表

所有后端路由都在 `<dashboard base>/api/plugins/wallpaper-engine/` 下（前缀由 Hermes web server 补齐，`plugin_api.py` 里写的是不带前缀的相对路径）。

| 路由 | 返回 | 说明 |
|---|---|---|
| `GET /status` | **固定 7 键**，永远 200：`ok` `version` `engineFound` `installDir` `libraryDirs` `mediaOrigin` `mediaError` | 引擎探测 + 媒体服务健康。没有 "starting" 态：媒体服务在 import 期就启动好 |
| `GET /library` | **5 键**：`engineFound` `mediaOrigin` `scannedAt` `items` `errors` | `?refresh=1` 强制重扫（也接受 `true`/`yes`/`on`）；扫描失败/超时仍 200，错误进 `errors[]` |
| `GET /config` | **信封** `{"ok": true, "config": {version, currentId, settings}}` | ⚠ 不是裸 ConfigDoc（契约 **C1**）。前端必须读 `body.config` |
| `PUT /config` | `{"ok": true, "config": ..., "clamped": {...}}`；结构错误 → 400 `{"ok": false, "error": "INVALID_BODY", "detail": ...}` | JSON Merge Patch 语义；`clamped` 回报被夹紧的字段（如 `cardBase: [-5,0]`） |

媒体服务是**独立**的 `ThreadingHTTPServer`，监听 `127.0.0.1:0`（OS 分配随机端口），端口经 `/status` 的 `mediaOrigin` 暴露：

| 媒体路由 | 行为 |
|---|---|
| `GET /m/<token>` | 单文件字节；`Accept-Ranges: bytes`、`Range` → 206 + `Content-Range`、非法 Range → 416、`Cache-Control: no-store`、`Access-Control-Allow-Origin: *` |
| `GET /s/<token>/<rel>` | 目录围栏内取文件；`.html` 响应注入 `web-shim.js` + `__weSeedProps` seed 脚本（在作者脚本之前） |
| `GET /gl/<rel>` | `vendor/webwallgl/` 静态资源；**不**注入 shim（宿主页不是作者页） |
| `GET /health` | `{"ok": true}`，供 `/status` 探测 |

围栏与 token 语义见设计 §6.7 与契约 **C6**：`/s` 与 `/gl` 共用同一个 `safe_join(root, rel)`（`realpath` 前缀校验、拒 `..`/绝对路径/盘符/URL 编码绕过/symlink）；token 就是 `base64url(abs_path)`，不做大小写归一。

### 前端六个片段

`desktop/src/` 下 6 个文件按文件名排序拼接，各自职责：

| 文件 | 职责 | 对外关键符号 |
|---|---|---|
| `00-core.js` | 常量、类型镜像、store（8 字段）、`ctx.rest` 封装、信封解包、`ctx.storage` 缓存与 hydrate、toast | `weUseStore` `weSet` `weSubscribe` `weRestCall` `weConfigFromBody` `weSaveConfig` `weHydrateFromStorage` `weSelectWallpaper` `weIsPlayable` `weMediaOrigin` `weBootstrap` |
| `10-layer.js` | 壁纸层：**video / image / scene / web** 渲染（`WE_LAYER_RENDERED_KINDS`）、切换控制流（retire → build → load → destroy）、2s 内容就位闸门、cut/fade 分支、`data-wallpaper-layer` 节点；scene/web = `/gl/host.html` iframe（load 激活、error/timeout 回退 preview）；application 不建层只记 diag；另注入「对话区独立卡片」CSS（`[data-chat-surface]`，仅对话区、随图层进退） | `weLayerSync` `weLayerReload` `weLayerState` `weLayerSceneUrl` `weLayerWebUrl` |
| `30-glass.js` | 液态玻璃：基色探测、inline 快照/覆盖/还原、`MutationObserver` 200ms 节流重算；产出滤镜参数但不碰图层 DOM | `weGlassApply` `weGlassRefresh` `weGlassRestoreToken` `weGlassMeasureChatSurface` |
| `40-panel.js` | `appearance.extra` 外观面板（§8.4 全部控件；滑杆 `pointerup` 才 PUT）；面板本体是 inset 玻璃卡（composer 材质 55% + 16px 模糊 + 0.875rem 圆角，2026-10-22 与对话页统一） | `wePanelSliderDisplay` `wePanelSliderWire` |
| `50-picker.js` | 壁纸库模态：搜索/类型/评分过滤、骨架格、空态四分支、手动加库根、Esc 关闭 | `wePickerModal` `wePickerOpen` `wePickerClose` `wePickerSelect` `wePickerRoot` `wePickerRefresh` `wePickerAddRoot` |
| `99-register.js` | 唯一 `export default {id, name, description, defaultEnabled, register(ctx)}`；**三个贡献成对**：面板窗格（`area: 'panes'`，`dock:{pane:'workspace',pos:'center',enforce:true}` → 工作区标签条里的一个**标签**，可关可切）+ 侧栏入口（`area: 'sidebar.nav'`，与技能与工具/消息平台并列）+ 该入口指向的路由页（`area: 'routes'`，只做**转交**：navigate 回原处、200ms 后 `host.revealPane` 把面板标签顶到前面，不渲染面板本体）；另有 `onDispose` 统一清理。壁纸库模态**不是独立贡献**，它是面板 React 树的最后一个子节点 | `weRegReconcile` `weRegTeardown` `weRegHandoff` `WE_REG_PANE_ID` `WE_REG_PAGE_PATH` |

**store 是封闭的 8 字段**：`boot` `config` `library` `current` `layer` `panelOpen` `pickerOpen` `toast`（见 `desktop/src/00-core.js` 的 `weInitialState()`）。别往里加字段——面板的临时 UI 状态走 React `useState`。

React 的来源：只有 `00-core.js` 允许 `import`（`import { useSyncExternalStore } from 'react'`）；其余片段一律读宿主挂在全局的 `globalThis.__HERMES_REACT__`（宿主在插件求值前就装好了，且与 loader 的 `react` shim 是同一个对象，不会出现双 React）。

**面板挂在哪里（重要）**：外观面板注册在 `panes` 区域——一个可停靠、可关闭的窗格，标题「壁纸引擎」，默认以边缘标签形式收起（`defaultCollapsed`），宽 `22rem`。它**不**在 `appearance.extra`，因为宿主的外观设置页只在**顶层页**渲染该区域（`appearance-settings.tsx:1100` 的 `subpage === undefined`），而从侧栏点「外观」时宿主总是强制跳进第一个子页（`settings/index.tsx:134`），导致注册在那里的插件永远点不到。这条是 2026-10-20 在真机上定位并改掉的。

### 构建方式

```bash
# 默认即可：src/ → plugin.js
python desktop/build.py

# 显式写法（两个参数名就是 build.py argparse 的 --src / --out）
python desktop/build.py --src desktop/src --out desktop/plugin.js
```

`build.py` 自己声明的 rule1–rule6（它的 docstring 还有 rule7，只说明「`desktop/` 下除 `src/` 外的东西由 Electron 整树复制、不执行」，与构建行为无关；违规一律 exit 1 并打印 `文件:行号 (ruleN: 原因)`，绝不产出半成品）：

| 规则 | 内容 | 机器校验 |
|---|---|---|
| rule1 | 只有 `00-core.js` 可以 `import`；必须位于文件首部（前面只允许注释/空行）；specifier 只能是 4 个白名单键（`@hermes/plugin-sdk`、`react`、`react/jsx-runtime`、`react/jsx-dev-runtime`）；禁止动态 `import()` | ✅ |
| rule2 | 其余文件只允许顶层 `function` / `const`：不得 `import`、不得 `export` | ✅ |
| rule3 | `99-register.js` 必须排在最后，且持有唯一的 `export default` | ✅ |
| rule4 | 产物首行固定为 `// GENERATED by build.py — do not edit` | ✅ |
| rule5 | 片段之间只靠全局作用域协作，符号以 `we` 前缀命名 | ❌ 评审约定，不机器校验（正则判标识符会误伤局部变量/属性/JSX） |
| rule6 | 产物 UTF-8 + 纯 LF；最后一行打印 `sha256: <hex>`，两次构建可直接对比 | ✅ |

当前产物（本机实测）：

```text
built: <HERMES_HOME>/plugins/wallpaper-engine/desktop/plugin.js from 6 file(s), 327011 bytes
sha256: a06d3bd7ba62fdb5c1d62356ce4672ac88cbe0af3ce75a0e93a464ddd3ad845b
```

同一份源码连跑两次，sha256 完全一致（已实测 3 次：产物落盘 + 两次写 scratch）。树里的 `desktop/plugin.js` 与重新构建的字节完全相同，说明它是当前源码的产物，不是中间态残留。

---

## 验证清单

区分三种可验方式：**命令行**（本仓库测试/构建，不需要桌面实例）、**真机**（必须有跑起来的 Hermes Desktop）、**DevTools**（真机 + 打开 DevTools 控制台）。

| 锚点 | 怎么验 | 预期看到什么 | 可验方式 |
|---|---|---|---|
| 构建确定性（T10） | `python desktop/build.py` 连跑两次 | 两次 `sha256:` 相同；当前应为 `6a4711c8…` | 命令行 ✅ |
| 产物语法（T12） | `node --check desktop/plugin.js` | 无输出、exit 0 | 命令行 ✅ |
| `/status` 200 + 7 键 | `PYTHONDONTWRITEBYTECODE=1 <venv>/python -m pytest tests/test_plugin_api.py -p no:cacheprovider -k status` | 通过；键集恰为 `ok version engineFound installDir libraryDirs mediaOrigin mediaError` | 命令行 ✅（TestClient，不经真网关） |
| `/library` 返回条目 | `... -k library` | 通过；伪造 Steam 树下返回条目，`kind/path/preview` 正确 | 命令行 ✅（用 `tests/fixtures/fake-steam*`）；真实库需真机 |
| `GET /config` 是信封 | `... -k config` | 通过；断言 `body["config"]`（C1） | 命令行 ✅ |
| 图层出现（T11 冒烟） | `node --test tests/frontend/99-register.test.mjs` | 17/17 通过；启用后 `document.body` 有 `[data-wallpaper-layer]`，禁用后移除 | 命令行 ✅（jsdom，不是真窗口） |
| 面板窗格出现 | 真机：启用插件后看主界面边缘 | 出现「壁纸引擎」标签/窗格，点开可见全部控件 | 真机。jsdom 只能证明注册形态（`area: 'panes'` + PaneChrome 三字段）|
| 面板在 22rem 窗格内不留贴边 | 命令行：见 `cache/scratch/verify-padding.mjs` 的做法（jsdom 渲染 + `getComputedStyle`）| `padding` 四边均为 `0.875rem`、`borderTop` 为 `none`、grid 列为 `minmax(0, …)`；最坏行宽 234px < 内容宽 350px | 命令行可验样式值；**真实像素布局 jsdom 量不到，需真机目视** |
| 图层出现（T13 真机） | 真机：打开插件后在 DevTools 执行 `document.querySelector('[data-wallpaper-layer]')` | 返回一个 `div` 元素，不是 `null` | DevTools（真机） |
| 插件出现在 Plugins 页（T13） | 真机：Capabilities ▸ Plugins | 列表里有 "Wallpaper Engine"，开关可切换 | 真机 |
| 玻璃 token 变化（T15） | 真机 DevTools：`getComputedStyle(document.documentElement).getPropertyValue('--ui-bg-sidebar')` | 启用壁纸后从 `rgb(...)` 变为 `rgba(...)`；关闭后回到原值（可能是空串） | DevTools（真机）。命令行只能验逻辑：`node --test tests/frontend/30-glass.test.mjs`（33/33，jsdom 的 computed 自定义属性） |
| 聊天卡缝 | 真机 DevTools：同上读 `--ui-chat-surface-background` | 随 `cardBase` 变化 | **未验证**：该 token 名对真实主题是否成立仍未实测（[PV-2]，见 §5） |
| 视频壁纸真播放（T14） | 真机：选一张视频壁纸 | 画面动起来；DevTools 里 `<video>.readyState >= 2` 且 `currentTime` 递增 | 真机。**命令行不能验**：jsdom 不解码媒体，`readyState`/`currentTime` 的断言是 HTMLMediaElement 桩，只证明模块与媒体元素的契约 |
| cut 转场（T16d） | 命令行：`node --test tests/frontend/10-layer.test.mjs`；真机：把「转场」设为「直切」再选另一张 | 命令行 32/32 通过；真机上旧层在内容就位前即消失、无过渡动画 | 命令行为主 ✅；观感需真机 |
| fade 转场（T16e） | 同上，转场设为「淡入」 | 旧层保持不透明垫底直到新层就位（**不**淡出），新层淡入 | 命令行为主 ✅；观感需真机 |
| 场景壁纸出画面（T16/T16c） | 真机：选一张 scene 壁纸 | **现在还看不到画面**：预期行为是「不建图层 + 一条 info toast」 | **未实现**（P1/T3.1）。`desktop/src/` 里没有 `host.html`/`/gl/`/`we-frame`，别拿这条当回归测试 |
| 网页壁纸（T3.1） | 真机：选一张 web 壁纸 | **同上，还不出画面**：预期是「不建图层 + info toast」 | **未实现**（P1/T3.1） |

一条命令跑完「命令行可验」的全部后端项：

```bash
cd <HERMES_HOME>/plugins/wallpaper-engine
PYTHONDONTWRITEBYTECODE=1 \
  python -B \
  -m pytest tests -p no:cacheprovider -q
```

本机实测（2026-10-20）：`345 passed, 4 skipped`。其中 25 条是本文自检（`test_readme.py`），产品套件本体为 320（292 T1.4 基线 + 28 `test_manifest.py`）；4 条 skip 是既有的平台/环境相关用例。

> 想对**运行中**的实例用 curl 验后端？注意面板 API 有登录态保护：本机实测 `curl http://127.0.0.1:<serve 端口>/api/plugins/wallpaper-engine/status` 返回 **401 `{"detail":"Unauthorized"}`**（未带会话凭据，且认证中间件先于路由生效）。所以命令行 curl 不是可靠路径——请用已登录浏览器 DevTools 的 Network 面板看同一请求，或直接用上面的 pytest。

---

## 排障表

素材取自设计 §9，逐条补「怎么确认」。

| 现象 | 原因 | 处置 |
|---|---|---|
| 面板显示「未检测到 Wallpaper Engine」，壁纸库空 | Steam / WE 未安装，或安装目录没被探测到（判定依据是存在 `wallpaper32.exe`） | 确认 WE 在 Steam 里装过；`GET /status` 看 `engineFound`/`installDir`；`/library` 仍应 200 且 `items: []`。可用面板里「手动添加库根」写 `extraLibraryRoots` |
| 某个 Steam 库的壁纸全不见，其它库正常 | 该库路径不可读（权限/盘符已卸载） | 该库被跳过、原因记进 `/library` 的 `errors[]`。修权限或从库里移除该根；不会 500 |
| 某张壁纸一直不出现，其它正常 | 它的 `project.json` 损坏/字段缺失 | 跳过该项目并记 `errors[]`。手工打开该 `project.json` 看是否合法 JSON；`file` 字段缺失的条目会被直接丢弃（设计 §5.1） |
| 壁纸完全不显示，只剩玻璃效果 | 媒体服务端口被占：启动重试 3 次（`START_RETRIES = 3`）仍失败 → 降级为「仅玻璃」 | `/status` 看 `mediaOrigin` 是否为 `null`，`mediaError` 有原因字符串。释放端口冲突后需要重启 serve；降级状态不会自愈 |
| 选了场景壁纸，黑屏/不出画面 | 渲染器没起来：`scene.pkg` 缺失、包损坏、WebGL 不可用 | 先看 `GET <mediaOrigin>/diag/recent`（渲染器唯一的上报通道，`lvl=error` 那几条就是原因）；确认 `play.url` 是 `/s/<token>/scene.pkg` 且该 token 能 200。图层在 load 前有闸门（视频/图片 2s，场景/网页 15s），超时会回退 preview 图并自动重试两次 | 换一张场景，或看 `data/config.json` 的 `sceneLiveFps`（只接受 15/30/60）。**注意 scene 没有心跳通道**（CONTRACT §2.2），"在播"只由 iframe load + 闸门判定 |
| 选了网页壁纸，白屏/黑屏 | 作者页或 shim 没跑起来 | 看 `GET <mediaOrigin>/diag/recent`；确认 `play.url` 的 `/s/<token>/index.html` 能 200，且响应 HTML 里含 `__weShimInstalled`/`web-shim` 注入。图层闸门（网页/场景 15s）超时会回退 preview 并自动重试 | 换一张网页壁纸；`webSandbox` 不要设 `strict`（本插件不发该参数） |
| 重开桌面端后壁纸整个被放大/只剩上半身特写，重新选一次壁纸就正常 | 冷启动时场景图层没抢到渲染器，降级成了 **preview 图**；WE 的 preview 常见是 1:1（实测 1024×1024 对应 3840×2160 场景），按封面铺满会把方形图放大约 2.5 倍、上下各裁 22% | 2026-10-24 已修：场景/网页闸门放宽到 15s，降级后 5s 自动重试（最多 2 次），预览图改用 `contain` 不再裁切。若仍复现，看 `/diag/recent` 是否有该场景的记录——完全没有记录说明 iframe 根本没起来 | 升级插件后退出并重开桌面端 |
| 面板一打开就报配置错误，或设置改动不生效 | `data/config.json` 损坏/是未来版本 | 插件会把坏文件移成 `data/config.bad-<YYYYmmdd-HHMMSS>-<mmm>.json`（未来版本是 `config.future-…json`）并用默认值重建。恢复：从备份文件抄回你需要的字段，或直接让面板重新调 |
| 关掉插件后壁纸还在 / 玻璃没还原 | 「Plugins 页开关」与 `settings.enabled` 是两个独立开关（§7.6） | 先下面板里的「启用壁纸」开关（还原 token、移除图层），再去 Plugins 页关模块。卸载（删目录）等价于前者关闭 + 物化副本清理 |
| 媒体请求 403 | 路径逃逸被围栏拦下（`..`、绝对路径、盘符、URL 编码绕过、symlink） | 这是**正确**行为，不是 bug。检查壁纸目录里是否有指向库外的符号链接；`/m` 的失效 token 是 404 而不是 403 |
| 8K 级大壁纸掉帧 | 不缩放，直接依赖 GPU；`wallpaperBlur > 0` 时更吃 GPU | 把「壁纸模糊」归 0；场景壁纸降帧率到 15；仍不行就换小尺寸壁纸 |
| DevTools 里 `/api/plugins/wallpaper-engine/status` 是 404 | 后端没被 import：不在 `plugins.enabled` 白名单里（`_plugin_api_mount_skip_reason` 的 `not in plugins.enabled`） | 回到 §2 步骤 3/4：加白名单 + 重启 serve。用 `hermes config get plugins.enabled` 确认键真的存在且是 list |
| `plugin.js` 存在但界面没反应 | 桌面端副本没更新，或 `plugin.js` 是旧构建 | 重跑 `python desktop/build.py`，确认 sha 变了；重启桌面应用让 reconcile 重新复制到 `<HERMES_HOME>/desktop-plugins/` |
| 选中了壁纸，后端 `currentId` 已写入、媒体服务也活着，但屏幕上看不到 | ① 桌面端实例早于你的修改启动（renderer 里跑的是旧 `plugin.js`）；② `<html>` 被宿主 boot 脚本钉了**不透明**背景，`z-index:-1` 的图层被它完全盖住 | ① 退出并重开 Hermes Desktop；② 这条已在 T2 修复（图层挂载期把 `<html>` 背景置 transparent，teardown 逐字还原）——若仍复现，DevTools 里 `document.documentElement.style.background` 应读到 `transparent` |
| 画面出现一下就没了，DevTools 里 video `error` | `mediaOrigin` 是**上次 serve 启动时的端口**；serve 重启后媒体服务换了端口，`<video src>` 指向死端口 | 重启桌面端让它重新 bootstrap 取 `/library`（`mediaOrigin` 只在 bootstrap 时读一次，没有轮询刷新） |

---

### 跨模块契约（改动前必读）

完整版见项目根的 `CONTRACTS.md`（不随本仓库发布，只读）。以下是与本仓库代码直接相关、且**已经实现成这样**的 7 条：

| # | 契约 | 影响 |
|---|---|---|
| C1 | `GET /config` 返回 `{ok, config}` 信封（不是裸 ConfigDoc） | 前端只能读 `body.config`；`weConfigFromBody` 是唯一解包点 |
| C2 | `Scanner.scan()` 固定 5 键，`installDir`/`libraryDirs` **不在** payload 里 | 它们由 `Scanner.discovery()` 提供、`/status` 消费。别为了"完整"往 `scan()` 加键（会打破精确断言） |
| C3 | 场景壁纸必须显式 `type=scene` | `type=canvas` 会掉进宿主回退页 → 插件 404 |
| C4 | `type=scene` 时**没有** `we-frame` 心跳 | 不能用「收到 ≥3 次心跳」验收 scene |
| C5 | 场景 `src` 是目录 base `/s/<token>`，不是文件 URL | 写成 `/s/<token>/scene.pkg` 会拼成 `…/scene.pkg/scene.pkg` → 404 |
| C6 | 注册目录 token 时必须给 `entry`（scene 给 `scene.pkg`） | 空 `rel` 只回退 `index.html`，没有 `index.html` 就是 404，**不列目录** |
| C7 | 跑完测试/构建后树内不得有 `__pycache__` / `.pytest_cache` / `*.pyc` / `*.tmp` | 见 §7.1 的命令（`PYTHONDONTWRITEBYTECODE=1` + `-p no:cacheprovider`） |

---

## 开发指南

### 后端测试（pytest）

```bash
cd <HERMES_HOME>/plugins/wallpaper-engine

# 全量（含 test_readme.py 的自检）
PYTHONDONTWRITEBYTECODE=1 \
  python -B \
  -m pytest tests -p no:cacheprovider -q

# 单个文件 / 单个锚点
PYTHONDONTWRITEBYTECODE=1 \
  python -B \
  -m pytest tests/test_plugin_api.py -p no:cacheprovider -k status
```

- `PYTHONDONTWRITEBYTECODE=1`、`-p no:cacheprovider`、`-B` 与 `PYTHONPYCACHEPREFIX` **不是可选项**：否则会在插件树里留下 `__pycache__` / `.pytest_cache`，违反契约 C7。
- 为什么多此一举设 `PYTHONPYCACHEPREFIX`：实测（2026-10-20）只设 `PYTHONDONTWRITEBYTECODE=1` **没护住**——跑完树里出现了 4 个 `cpython-314.pyc`，说明有子进程没继承该变量（测试里有 `subprocess.run` 路径）。`PYTHONPYCACHEPREFIX` 是根治：即便有进程写 bytecode，也落到 scratch 而不是插件树。
- 上面那个解释器是**项目开发用的 venv**（Python 3.12.10 + pytest 9.1.1 + fastapi 0.136.3，fastapi/starlette/httpx 继承自宿主），属于 **dev-only**：运行时插件本身不需要 pytest，也不需要这个 venv。
- PowerShell 用户把环境变量换成 `$env:PYTHONDONTWRITEBYTECODE=1` 与 `$env:PYTHONPYCACHEPREFIX="$env:TEMP/we-pyc"`。
- 测试套件（9 个文件）：`test_config.py` `test_plugin_api.py` `test_scan.py` `test_media_server.py` `test_media_server_extra.py` `test_manifest.py` `test_build.py` `test_scene_bridge.py` `test_readme.py`。
- ⚠ `test_media_server.py` 与 `test_media_server_extra.py` 各有一条 **PowerShell junction 探针**（T6e symlink 围栏）。在没有管理员权限或 PowerShell 被策略拦下的机器上它会 `pytest.skip`——所以 `5 skipped` 里有几条来自这里，属环境限制而非产品缺陷。

### 前端测试（node --test）

```bash
cd <HERMES_HOME>/plugins/wallpaper-engine

node --test tests/frontend/00-core.test.mjs \
           tests/frontend/10-layer.test.mjs \
           tests/frontend/30-glass.test.mjs \
           tests/frontend/40-panel.test.mjs \
           tests/frontend/50-picker.test.mjs \
           tests/frontend/99-register.test.mjs
```

本机实测：`tests 209 / pass 209 / fail 0`（各套件 30 + 67 + 35 + 28 + 31 + 18）。`10-layer` 从 32 涨到 38：6 条钉住背景行为——**图层挂载期必须把四层都置 transparent，teardown 逐字还原**：`<html>`（宿主 boot 脚本钉实色）、`<body>`（`var(--ui-chat-surface-background)`）、`#root` 第一个子 div（`bg-background` + `h-screen`）、`[data-contrib-shell]` div（`bg-(--ui-bg-chrome)` + `h-screen w-screen`）。宿主自己的注释就写明后两者是 app shell 的两个 full-window opaque painters，它靠 `[data-hermes-glass]` 规则清掉，而我们的玻璃只写 token 值、不走那条路，所以两层都得自己清。任何一层漏掉，壁纸都被盖住而 video 自身完全正常（readyState 4、有尺寸、无 error）——2026-10-21 逐个排查出来的。2026-10-22 再涨到 44：6 条钉住**外观链**（filter/不透明度落在 media、scrim 膜层挂在 root 下且 z-index 1、滑杆拖动走 `weLayerSync` 热更新、CSS 兜底规则必须带 `:not([data-we-glass])`）；`30-glass` 从 33 涨到 35，2 条钉住 `<html>` 的 `data-we-glass` 归属标记（start 置位 / stop 清除 / 敌意文档不抛）。2026-10-24 涨到 56：4 条钉住**冷启动恢复**——场景/网页的 content gate 放宽到 15s（2s 会把还在 boot 的渲染页判死，降级后又是粘性的，观感就是「重开桌面端壁纸被放大」）、降级后 5s 自动重试且只重试两次、重试耗尽停在预览图、预览图改 `contain`（1:1 preview 按 cover 会被放大约 2.5 倍并裁掉上下 22%）。2026-10-26 涨到 59：3 条钉住**冷启动首帧**——(a) 快照里的 media origin 属于上一个后端进程（媒体服务每次启动都换随机端口），iframe 因此加载成 chrome-error 页，`load` 仍会触发，图层报 `active`、画面空白，而同 id 守卫不许重建（实测 frame 指 `:29203`、实际媒体服务 `:22884`）；现在 store 的 origin 一落到新值就重挂一次。(b) 场景渲染页只按启动那一刻的视口量一次 canvas，且没有 resize 通道，0×0 起跑就永久 1×1（实测 `fit cover: view 2160x2160 scene 3840x2160 canvas 1x1`）；现在等窗口真有视口才导航，content gate 从导航起算，万一还是 0×0 就等 `load` 后盒子出现再导航一次（只一次）。2026-10-27 涨到 61：2 条钉住**冷启动淡入**——开桌面端时屏幕本来是空的，1800ms 的切换淡入只是把「壁纸出现」又推后 1.8s（实测窗口约 4.4s 出现、实时层约 3s 后就绪）；现在「一个自己的层都没挂」时用 200ms 冷淡入，origin 变更重建前先把死端口节点直接销毁（chrome-error 页没有像素，留着当底图毫无意义），真正切壁纸仍是 1800ms。同一天再涨到 62：1 条钉住**宿主 CONNECTING 遮罩被 token 污染**——那层全屏遮罩就是用 `--ui-chat-surface-background` 铺的，玻璃引擎把这个 token 改写成 `rgba(chrome, cardBase%)`，于是插件一挂载遮罩就掉到 15%（实测 `rgba(24,26,30,0.15)`，而挂载前它是实色 `rgb(13,16,21)`），浅色主题下窗口底色透上来就是一片白；现在 `:root[data-we-glass] [data-glass-opaque]` 钉回实色 chrome，跟宿主自己玻璃模式的解法同一条规则。

同日再涨到 63：1 条钉住**遮罩退场后的白闪**——为了露出壁纸，插件把 `<html>/<body>` 和两个 shell painter 都清成透明，于是「遮罩已走、壁纸首帧还没到」的空窗期透出 Electron 窗口自己的白底（实测 t=6.9s 遮罩消失、t=7.5s 场景首帧，中间画面 `rgb(193,194,194)`）。现在壁纸下面垫一层 `z-index:-2` 的主题色地板（`--ui-bg-chrome`），空窗期显示主题底色而不是白屏，且永远盖不住 `-1` 的壁纸层。

同日再涨到 67：4 条钉住**上次壁纸的静态占位**——每张壁纸在屏幕上出现时把 preview 抓下来缩成 480px JPEG data URL（LRU 8 张，几万字节一张）存进插件 storage，下次启动在真层下面先铺这张静帧；占位放在真层**之上**（scene 的 iframe 从一开始就不透明，放下面等于没放），`activate` 后再停 450ms 才淡出——那正好是 `load` 到首帧的差（冷启动实测约 0.4s）；死链路（bootstrap 未落地时的假 active）不触发退休，否则会把占位秒删。占位只属于本会话选中的那张，换壁纸/降级预览/teardown 都会清掉。

- **必须逐个传 `.mjs` 文件，不能传目录**。`node --test tests/frontend` 会把这个目录当文件，实测直接失败：`test at tests\frontend:1:1 ✖ tests\frontend — 'test failed'`。
- dev-only 依赖：`react` / `react-dom` 19.2.7、`jsdom` 29.1.1，从 Hermes 桌面树（默认 `<HERMES_HOME>/hermes-agent`）解析；可用 `WE_NODE_MODULES=<dir>` 覆盖。插件运行时**不**依赖它们。
- 单跑一个套件：`node --test tests/frontend/30-glass.test.mjs`。

### 改前端的规矩

1. **改完 `desktop/src/*.js` 必须重跑 `python desktop/build.py`**。宿主加载的是 `plugin.js`，`src/` 在运行时不存在（它只被 Electron 当静态文件整树复制，不执行）。
2. **除 `00-core.js` 外不许有 `import`**（rule1）。需要 React 就读 `globalThis.__HERMES_REACT__`；需要别的模块符号就直接用（拼接后同一作用域）。
3. **只有 `99-register.js` 能有 `export default`**（rule3），且它必须排在最后（文件名排序决定拼接顺序）。
4. **符号用 `we` 前缀**（`weLayerSync`、`weGlassApply`、`wePickerModal`…）。这是评审约定（rule5），build.py 不机器校验——但它防的是拼接后的重名互踩。
5. **store 八字段封闭**：`boot config library current layer panelOpen pickerOpen toast`。UI 临时状态用 React `useState`，不要往 store 塞。
6. 新增设置项要三处一起改：`dashboard/config.py` 的 `SETTINGS_DEFAULTS` + `_NUMERIC_RANGES`（clamp 表），`desktop/src/00-core.js` 的类型镜像，`desktop/src/40-panel.js` 的控件。
7. 定时器一律 `ctx.setInterval` / `ctx.setTimeout`（`ctx.timer` **不存在**），disposer 挂 `ctx.onDispose`。

### 提交前自检

```bash
cd <HERMES_HOME>/plugins/wallpaper-engine
python desktop/build.py                     # 期望 sha256: 6a4711c8…（改过源码则会变）
node --check desktop/plugin.js               # 无输出
node --test tests/frontend/*.test.mjs        # 201/201（shell 展开成具体文件，仍不是目录）
find . -name '__pycache__' -o -name '.pytest_cache' -o -name '*.pyc' -o -name '*.tmp'   # 必须为空
```

---

## 致谢

这个插件不是我从零写出来的。骨架和大部分细节来自别人的开源项目，我把它们搬到 Hermes 上，又按自己的习惯改了改。该谢的人写在这儿。

**elysia395/dsh-wallpaper-engine**（MIT）

整个插件的底子是它的 DSH 版本。二十来项设置怎么分类、液态玻璃为什么做成外壳和卡片两道缝、壁纸库怎么找 Steam 目录、怎么读 `project.json`、怎么按类型和内容分级筛、轮换和转场怎么接，基本都是沿用它的判断。我做的事更接近翻译：把它的行为在 Hermes 的插件模型里重新落一遍。

**oneincase/webwallgl**（MIT）

scene 和 web 两类壁纸能显示，全靠这个跑在浏览器里的 WebGL 渲染器。`vendor/webwallgl/` 里放的是 v2.0.2（commit `cd56f801…`）的原样文件，一个字节没改。它要是出问题，我不在本地打补丁，等上游发版。没有它，这插件就只剩视频和图片。

**Hermes 桌面端**（Nous Research）

宿主留的口子挺好用：`panes`、`sidebar.nav`、`routes` 三个注册区，`--composer-fill` 这类 CSS 变量，还有 `revealPane` 这种小接口。这些代码不是我的，但少一个都做不出现在这个样子。

### 许可

两个上游都是 MIT，衍生部分也照 MIT 走。根目录 `LICENSE` 里列了三位作者的版权声明，`vendor/webwallgl/LICENSE` 是渲染器自己的原文。

觉得好用的话，先去给上面两个项目点个 star，功劳在那儿。要是哪位上游作者觉得我这个移植有问题，或者不希望被这样再分发，说一声，我按你的意思改，或者直接把仓库下架。

### 这个移植改了什么

方便你对着上游看：

- 加载方式从 DSH 的插件包换成 Hermes 的单文件 ESM，`desktop/src/*.js` 拼成 `desktop/plugin.js`
- 玻璃拆成三档：外壳、卡片、浮层各有一个浓度。浮层单独一档，是因为设置和定时任务要压住背后的页面，跟卡片共用一个值会看不清
- 卡片化是新加的：对话区、技能与工具、消息平台、设置和定时任务浮层，统一成同一张圆角玻璃卡，一个开关全关
- 入口有两个：工作区标签条，和左侧栏那一行。点侧栏只会把标签顶到前面，不会把你正在看的对话顶掉
- 二十行设置后面都补了括号说明，`overlayBase`（浮层透明度）是新加的
- 不碰 Hermes 核心源码，不重打包 exe；`config.yaml` 怎么改都由使用者本人确认

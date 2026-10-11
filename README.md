# mineradio-mods —— Mineradio 外挂包

给 [Mineradio](https://github.com/XxHuberrr/Mineradio)（Windows Electron 音乐播放器）加功能的**外挂包**：
一条命令装进别人电脑上那份**没改过的原版**，软件以后更新也不会把功能弄丢。

上游作者已于 2026-09-21 停止维护（GPL-3.0-only）。本包沿用同一许可证，改动以源码形式一并提供。

---

## 它是怎么"不被更新冲掉"的

两件事，缺一不可：

1. **只往上游文件里注入 8 个带标记的锚点**，不改上游任何一行原有代码。
   锚点是成对注释包起来的一行/一段，安装器认标记不认上下文：

   ```js
   // <<mineradio-mods:main-process v0.1.0>>
   try { require('./mods-host.js'); } catch (e) { ... }
   // >>mineradio-mods:main-process
   ```

   所以"加一个外挂"= 往 `files/` 里放文件 + 在 `mods.json` 登记，**不用再动上游文件**。
   上游那 8 个锚点分别是：

   | 锚点 | 落在哪个上游文件 | 干什么 |
   |---|---|---|
   | `renderer-modules` | `public/js/index-loader.js` | 1 行：在所有上游模块之后装载 `js/mods/loader.js` |
   | `main-process` | `desktop/main.js` | 1 行：`require('./mods-host.js')`，外挂窗口与 IPC 都在宿主里 |
   | `server-routes` | `server.js` | 1 行：后端路由链之前先让外挂接管 |
   | `server-audio-headers` | `server.js` | 1 行：音频代理的 Referer（B 站/咪咕直链必需） |
   | `server-audio-type` | `server.js` | 1 行：音频容器类型（DASH 的 mp4a） |
   | `playback-gapless-url` | `13-playback-start-audio.js` | 1 行：无缝专辑预取的取址也认外挂源 |
| `playback-url` | `13-playback-start-audio.js` | 1 行：主取址那串 if/else 之后，外挂源换掉直链 |
| `preload-main` | `desktop/preload.js` | 一段桥接（沙箱预加载读不了磁盘，只能内联） |

2. **开机自动重注入**。安装时加 `--autostart`，会在
   `%LOCALAPPDATA%\MineradioMods\` 放一份外挂本体 + 一个登录时跑一次的检查：
   发现上游文件被新版本整份换掉（锚点没了）就重新注入，并写 `reapply.log`。
   跑它用的是 **Mineradio.exe 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`），
   不需要你电脑上装 Node。

   > ⚠ 说清楚它会做什么：注册一个当前用户的开机自启项
   > `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MineradioMods`，
   > 每次登录检查一次你机器上的 Mineradio 安装目录，只在**被登记过的那个目录里**
   > 补回外挂自己的文件与那 6 个锚点，动上游文件前先备份到 `resources/app/mods-backup/`。
   > 不想开机检查：安装时不加 `--autostart`，或者手动删那个 Run 键。
   > 只想要"更新后手动跑一次"：`node install.mjs --go` 一条命令就够。

外挂本体放在 `%LOCALAPPDATA%` 而不是 `resources/app` 里，正是因为更新会把后者整个换掉。

## 安装 / 卸载

```bat
:: 1) 完全退出 Mineradio（托盘里也退掉）
:: 2) 在本目录下：
node install.mjs                 :: 干跑：只打印要动什么，一个字都不写
node install.mjs --go --autostart:: 真装 + 注册开机检查
node install.mjs --status        :: 装没装、上游文件有没有被换过
node install.mjs --verify        :: 逐条校验，退出码 0 = 全好
node install.mjs --uninstall     :: 撤锚点、删投放的文件（备份留着）
```

没装 Node 也没关系：`node` 换成 `"C:\路径\Mineradio.exe"` 并把
环境变量 `ELECTRON_RUN_AS_NODE=1` 设上，跑的是同一套脚本。

装完**要重启 Mineradio** 才生效（开着的那份不会自己换代码）。

自动找到安装目录的次序：正在运行的 `Mineradio.exe` → `%LOCALAPPDATA%\Programs\Mineradio`
→ `Program Files\Mineradio` → 各盘根目录的 `Mineradio`。找不到就用 `--path` 指给它
（安装根目录、`resources\app`、甚至 exe 文件本身都认）。

## 现在包里有什么

| 功能族 | 状态 | 说明 |
|---|---|---|
| `quick-search` | ✅ 已可用 | **Ctrl+Space 快速搜索浮窗**：不叫出主界面就能搜、能播；主窗口收在后台时照样能用。初屏 24 条，底部「查看更多」往前翻页（点它 / 按 `End` / 滚到底），上限 120。平台档：All / NE / QQ / KG / QS / BL / Podcast。 |
| `bili-source` | ✅ 已可用 | **B 站音源**：搜索、**合集分 P 当播放列表展开**、单独播其中一首、整包入队、非音乐内容过滤、音频代理的 Referer 与容器类型。播放接线走两个锚点（`playback-gapless-url` / `playback-url`），渲染层靠包装 `songProviderKey` / `normalizePlaybackProvider` / `lyricEndpointForSong` 让上游认识这个新源——上游那个 `songProviderKey` 对不认识的源一律回 `netease`，不补这一课浮窗连"这是合集"都标不出来。 |
| `no-update` | ✅ 已可用 | 接管 `/api/update/*`：一律回"没有更新"。作者已停更，而"升级到新版本"对外挂包来说就等于"外挂被冲掉"，所以宁可在后端答死，也不去改 `package.json`（那个文件一更新就回来了）。 |
| `extra-sources` | ⛔ 待搬 | 咪咕 / Internet Archive / Radio Paradise 三个免登录源，本体文件已在包里，缺后端路由与渲染层档位、换源接线。 |
| `bili-collection-ui` | 🟡 进行中 | 主界面搜索结果行里的分 P 面板（包装 `searchSongResultHtml` 注入）+ 让 All 档并进 B 站那一页。**浮窗那一侧已经全绿**；主界面这一侧 `live-check` 现在还是红的（搜不到 B 站行），没修完之前别当它可用。 |
| 其余（贴边组件、屏幕边缘进度轨、Ctrl+H 清空与存档、自动换源、登录入口） | ⛔ 待搬 | 每一族的落点、难度、要包装哪个函数都写在 [`docs/PORTING.md`](docs/PORTING.md)，是照着上游原版逐个核对过的。B 站非音乐过滤已随 `bili-source` 一起到位（在 `bilibili-api.js` 里，零锚点）。 |

## 真跑验证（不看你说的话，看它跑起来）

```bat
:: 造一份"别人的电脑"：上游原版 2.2.0 + 只装这个包
powershell -NoProfile -ExecutionPolicy Bypass -File tools/link-runtime.ps1
node install.mjs --path .live/Mineradio/resources/app --go
node tools/live-check.mjs            :: 真起一个实例，真开浮窗、真打字、真出声
```

它跑的是**没被我们改过的上游代码**（`.fixture/stock-app` 由 `git archive d43de56` 从上游基线取，
运行时文件用硬链接过来，不额外占磁盘）。断言包括：主窗口拿到 `desktopMods` 桥接与外挂模块、
外挂后端有响应、BL 档存在且切得过去、搜到的行源都是 bilibili 且**每条都带合集/分段徽章**、
时长按秒显示、`End` 能翻页、回车展开分 P、单独播某一段时队列只多那一条且带自己的 cid、
顶上那行是整包入队。最近一次：**14/14**。

## 已知限制

- **托盘菜单**里那几条备用入口（咪咕登录等）没做——Tray 实例与菜单模板都是上游模块私有的，没有钩子点。浮窗与热键不受影响。
- **"关主窗口=收进后台"** 的判定在上游 `main.js` 里，外挂窗口不在其中。现在的处理是：主窗口一关，浮窗先自己收起来，避免一个看不见的浮窗把进程留在后台退不掉。想要"浮窗开着也算收进后台"，就得加第 7 个锚点。
- 全局热键默认 `Ctrl+Space`，外挂自己占的，不在软件的按键设置里；改它用环境变量 `MINERADIO_MODS_HOTKEY`（设成 `off` 就是关掉，只用软件内的入口）。
- 只测过 Mineradio **2.2.0**。上游改了锚点附近的代码时安装器会明确报 `drift` 并拒绝瞎插，那时需要更新 `mods.json` 里的 `locator`。

## 开发

```
mods.json          清单：锚点定义 + 每个功能族要投放哪些文件
install.mjs        安装器（默认干跑）
lib/anchors.mjs    锚点协议：插入 / 校验 / 原地替换 / 撤销
lib/detect.mjs     找安装目录
lib/autostart.mjs  开机重注入的注册与撤销
files/             要投放的外挂本体（路径相对 resources/app）
blocks/            需要内联进上游文件的代码段（预加载桥接）
tests/             安装器自测：夹具是**上游原版 2.2.0**
docs/PORTING.md    还没搬的功能族各自落在哪、怎么搬
```

```bat
node --test tests/
```

测试全程在临时目录里跑，不碰你正在用的 Mineradio。夹具从旁边的开发仓库
（`E:\Projects\mineradio`，可用 `MINERADIO_DEV_REPO` 改）用 `git archive d43de56`
取上游原版；没有那个仓库就整组跳过并说明原因。它验的是：六个锚点在**原版文件**里
都找得到位置、注入后四个上游文件仍是合法 JS、重复注入结果一致（幂等）、卸载后与原版
**逐字节相同**、模拟"软件更新把上游文件换掉"之后重跑能全部恢复、以及定位不到时报
`drift` 而不是乱插。

加一个新外挂：把文件放进 `files/`，在 `mods.json` 的 `mods[]` 里登记一条
（要哪些锚点、投放哪些文件），如果是渲染层行为就在 `files/public/js/mods/` 里加一个模块
并在 `loader.js` 的清单里加一行。跑 `node install.mjs` 看计划，`--go` 落地。

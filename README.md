# mineradio-mods —— Mineradio 外挂包

给 [Mineradio](https://github.com/XxHuberrr/Mineradio)（Windows Electron 音乐播放器）加功能的**外挂包**：
一条命令装进别人电脑上那份**没改过的原版**，软件以后更新也不会把功能弄丢。

上游作者已于 2026-09-21 停止维护（GPL-3.0-only）。本包沿用同一许可证，改动以源码形式一并提供。

仓库：<https://github.com/tele-switc/mineradio-mods>（公开）。Clone 下来直接跑就行，
**不需要装 Node** —— `node` 换成你自己那份 `Mineradio.exe` 并设上 `ELECTRON_RUN_AS_NODE=1` 即可（见下）。

---

## 它是怎么"不被更新冲掉"的

两件事，缺一不可：

1. **只往上游文件里注入 8 个带标记的锚点**，不改上游任何一行原有代码。
   锚点是成对注释包起来的一行/一段，安装器认标记不认上下文：

   ```js
   // <<mineradio-mods:main-process v0.2.0>>
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
   | `server-audio-headers` | `server.js` | 1 行：音频代理的 Referer（B 站直链必需；IA/RP 顺带把 Range 一起保住） |
   | `server-audio-type` | `server.js` | 1 行：音频容器类型（DASH 的 mp4a、IA 的 opus、RP 无扩展名的 AAC） |
   | `playback-gapless-url` | `13-playback-start-audio.js` | 1 行：无缝专辑预取的取址也认外挂源 |
| `playback-url` | `13-playback-start-audio.js` | 1 行：主取址那串 if/else 之后，外挂源换掉直链 |
| `preload-main` | `desktop/preload.js` | 一段桥接（沙箱预加载读不了磁盘，`contextBridge` 暴露出去的对象又冻结了，只能内联）。现在带 16 个方法：浮窗 5 + 存档 4 + 贴边组件 7 |

2. **开机自动重注入**。安装时加 `--autostart`，会在
   `%LOCALAPPDATA%\MineradioMods\` 放一份外挂本体 + 一个登录时跑一次的检查：
   发现上游文件被新版本整份换掉（锚点没了）就重新注入，并写 `reapply.log`。
   跑它用的是 **Mineradio.exe 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`），
   不需要你电脑上装 Node。

   > ⚠ 说清楚它会做什么：注册一个当前用户的开机自启项
   > `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MineradioMods`，
   > 每次登录检查一次你机器上的 Mineradio 安装目录，只在**被登记过的那个目录里**
   > 补回外挂自己的文件与那 8 个锚点，动上游文件前先备份到 `resources/app/mods-backup/`。
   > 不想开机检查：安装时不加 `--autostart`，或者手动删那个 Run 键。
   > 机器上装着两份 Mineradio 时，`--uninstall` 只把**自己那条**从台账里划掉：
   > 还剩别的目录在管，Run 键就留着（改的是 `exe.txt` 指向哪份）；最后一份也撤了才删键。
   > 卸载只删**这个包自己写进去的那条** `Run` 值，同键里别人的自启项一律不动。
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
node install.mjs --uninstall --mod quick-search  :: 只撤这一族，别的族照旧能用
```

没装 Node 也没关系：`node` 换成 `"C:\路径\Mineradio.exe"` 并把
环境变量 `ELECTRON_RUN_AS_NODE=1` 设上，跑的是同一套脚本。

装完**要重启 Mineradio** 才生效（开着的那份不会自己换代码）。

自动找到安装目录的次序：正在运行的 `Mineradio.exe` → `%LOCALAPPDATA%\Programs\Mineradio`
→ `Program Files\Mineradio` → 各盘根目录的 `Mineradio`。找不到就用 `--path` 指给它
（安装根目录、`resources\app`、甚至 exe 文件本身都认）。

> 给了 `--path` 就只认它：那个目录里认不出原版布局时安装器会**报错停下**（退出码 2），
> 不会偷偷退回自动探测去动另一份安装——那通常是您正在用的那一份。
> 想让它自己找就别写 `--path`。

> 投放文件时如果那个位置上**已经有同名文件**（上游自带的、或您自己放的），
> 安装器先把它备份进 `resources\app\mods-backup\` 再覆盖，卸载时**还原原件**而不是删掉。

## 现在包里有什么

| 功能族 | 状态 | 说明 |
|---|---|---|
| `quick-search` | ✅ 已可用 | **Ctrl+Space 快速搜索浮窗**：不叫出主界面就能搜、能播；主窗口收在后台时照样能用。初屏 24 条，底部「查看更多」往前翻页（点它 / 按 `End` / 滚到底），上限 120。平台档：All / NE / QQ / KG / QS / BL / RP / IA / Podcast。 |
| `bili-source` | ✅ 已可用 | **B 站音源**：搜索、**合集分 P 当播放列表展开**、单独播其中一首、整包入队、非音乐内容过滤、音频代理的 Referer 与容器类型。播放接线走两个锚点（`playback-gapless-url` / `playback-url`），渲染层靠包装 `songProviderKey` / `normalizePlaybackProvider` / `lyricEndpointForSong` 让上游认识这个新源——上游那个 `songProviderKey` 对不认识的源一律回 `netease`，不补这一课浮窗连"这是合集"都标不出来。还补了队列身份键：上游那个 `queueItemKey` 没有 B 站那一路，同一份分 P 合集的十几段会全折叠成同一条（点第二首其实还在播第一 P），外挂给它加了 `bilibili:<bvid>:<cid>`。 |
| `no-update` | ✅ 已可用 | 接管 `/api/update/*`：一律回"没有更新"。作者已停更，而"升级到新版本"对外挂包来说就等于"外挂被冲掉"，所以宁可在后端答死，也不去改 `package.json`（那个文件一更新就回来了）。 |
| `free-sources` | ✅ 已可用 | **两个免登录源：Internet Archive + Radio Paradise**（都不要账号、不要 API key、本机不落任何会话）。后端路由 `/api/internetarchive/{search,song/url,lyric}`、`/api/radioparadise/{channels,search,song/url,now-playing,lyric}`；渲染层 `05-sources.js` 的源表加两项，浮窗多出 IA / RP 两档。**IA 一行 = archive.org 的一个条目**（常见为一整张专辑或一场演出），实际播哪个文件由后端按音质档过一遍 Chromium 可播性白名单再挑，行上老实标着「条目」；**RP 是 320k AAC 连续直播**，没有单曲、拖不了进度、没有同步歌词，标着「直播」，也只在自己的档位出现（All 档里掺六条电台会把音乐结果挤下去）。 |
| `danger-archive` | ✅ 已可用 | **Ctrl+H 一键清空与存档**：按 `Ctrl+H` 出密码门（密码 `mineradio`，防误触不是防外人），解锁后顶部一颗「一键清空搜索记录、播放列表与聆听统计」，点它之前**必须先存档成功**才允许清；下面每一条是清空前的存档，点一条整个回到那一刻（搜索记录、队列、当前曲目、进度）。存档落在 `%APPDATA%\Mineradio\mineradio-danger-archive.json`，**不在 localStorage**（它备份的正是 localStorage 那三条）、也不在安装目录（更新会没）。模态框与样式都是运行时注入的，上游 `index.html` / `index.css` 一个字不动。 |
| `edge-widgets` | ✅ 已可用 | **贴边播放小组件 + 屏幕边缘进度轨**：那排桌面按钮里多一颗「贴边」（运行时插入），点开是一个透明无边框的小控制台（封面/歌名/进度/上一首下一首/音量），可以拖到屏幕右、下、左边吸附；闲置或收到屏边时它让位给**整条屏幕边变成进度条**，指针回到那条边就自己展开，在进度条上点一下就跳到那一处。右键那颗按钮是换吸附边。两个窗口都是外挂自建的（浮窗是先例），所以不需要新锚点。 |
| `auto-source-fallback` | ✅ 已可用 | **自动换源**：当前源取不到地址时，自己去其它源找同一首歌，找到就播并写明"已从 网易云 切到 B 站（音频流 · 码率）· 按标题与时长匹配的版本"。免登录那条链是 网易云 → B 站；B 站的采纳判据（翻唱/器乐改编/伴奏/变速/铃声都收并标注，教学/测评/反应视频拒）与音质档位共用同一份，从开发仓库一起搬来。**IA 与 RP 明确不参与自动换源**：这两个没有"同名同歌手同一录音"的可靠判据，自动接管会播错内容，比不播更糟。 |
| `migu-source` | 🚫 决定不做 | 咪咕要会话（官方登录窗 + cookie 交给后端）。本体文件 `migu-api.js` 留在包里但不投放，`mods.json` 的 `migu-source` 保持 `enabled:false`。连带自动换源的免登录池子只有 `netease + bilibili`。 |
| `bili-collection-ui` | ✅ 已可用 | 主界面搜索结果行里的**分 P 面板**：包装上游 `searchSongResultHtml` 往行尾追加面板（样式抽成独立 `mods-bili-collection.css` 注入，不碰上游 CSS），展开 184 段那种合集、点某一段单独播、整包入队。并让上游 All 档的合并结果里并进 B 站那一页（用软件自己的 `scoreSongSearchResult` 重排，否则拼在末尾永远落在可见窗口之外）。 |
| 其余（登录入口与音质档位 UI、托盘备用入口） | ⛔ 待搬 / 已放弃 | 每一族的落点、难度、要包装哪个函数都写在 [`docs/PORTING.md`](docs/PORTING.md)，是照着上游原版逐个核对过的。B 站非音乐过滤已随 `bili-source` 一起到位（在 `bilibili-api.js` 里，零锚点）。 |

## 真跑验证（不看你说的话，看它跑起来）

```bat
:: 造一份"别人的电脑"：上游原版 2.2.0 + 只装这个包
powershell -NoProfile -ExecutionPolicy Bypass -File tools/link-runtime.ps1
node install.mjs --path .live/Mineradio/resources/app --go
node tools/live-check.mjs            :: 真起一个实例，真开浮窗、真打字、真出声
```

它跑的是**没被我们改过的上游代码**（`.fixture/stock-app` 由 `git archive d43de56` 从上游基线取，
运行时文件用硬链接过来，不额外占磁盘；`resources\app` 是**真复制**的一份，
因为安装器要改写它——硬链接过去的话改的就是您正在用的那一份）。
两条源路径都可以用环境变量改：`MINERADIO_RUNTIME_SRC`（装好的 Mineradio 根目录，取 exe/dll/pak）、
`MINERADIO_DEV_REPO`（上游源码仓库，取夹具）；产物固定落在本仓库的 `.live\Mineradio`。

断言包括：主窗口拿到 `desktopMods` 桥接与外挂模块、
外挂后端有响应、BL 档存在且切得过去、搜到的行源都是 bilibili 且**每条都带合集/分段徽章**、
时长按秒显示、`End` 能翻页、回车展开分 P、单独播某一段时队列只多那一条且带自己的 cid、
顶上那行是整包入队；IA / RP 两族另加：源表注册、`songProviderKey` 认得 `archiveId` 与
`rpChan=0`（Main Mix 的 chan 就是 0，真值判断会漏）、歌词走自己的端点、频道表与取址、
**从浮窗按回车真的起播出声**（IA 走 `/api/audio` 代理、RP 那条无扩展名的 AAC 报对容器类型）、
行上的「条目 / 直播」徽章、主界面 All 档滚到 IA 那一行时源标签写的是 `IA` 而不是被兜成 `NE`；
贴边组件那族是**真开第二个窗口**：按钮插进上游那排、组件窗口出现、显示的是正在播的那首连总长都对、
那颗播放键真的在遥控主窗口（按下去换个状态再按回来）、收到屏边时进度轨窗口出现且画的是这一帧真实进度、
在轨上点一下主窗口真的跳转、指针回到那条边组件重新展开、再点一次两个窗口都收掉；
Ctrl+H 那族是**真抹真恢复**：密码门（错的会被数出来）、一键清空后 localStorage 三条都空、队列空、
`audio.paused` 为真，而存档确实写在 userData 而不是 `resources/app` 下面，点那条存档又整个回到清空前；
自动换源那族是**真的换**：塞一条网易云取不到地址的歌起播，等它自己找到 B 站那一版并播响，
提示卡上写着"已从 网易云 切到 B 站（音频流 · 码率）· 按标题与时长匹配的版本"。
最近一次：**62/62**。

## 已知限制

- **托盘菜单**里那几条备用入口（咪咕登录等）没做——Tray 实例与菜单模板都是上游模块私有的，没有钩子点。浮窗与热键不受影响。
- **"关主窗口=收进后台"** 的判定在上游 `main.js` 里，外挂窗口不在其中。现在的处理是：主窗口一关，浮窗、贴边组件与进度轨都先自己收起来，退出前再统一 `destroy()`，避免一个看不见的窗口把进程留在后台退不掉（这个坑踩过）。想要"外挂窗口开着也算收进后台"，就得加第 9 个锚点。
- 全局热键默认 `Ctrl+Space`，外挂自己占的，不在软件的按键设置里；改它用环境变量 `MINERADIO_MODS_HOTKEY`（设成 `off` 就是关掉，只用软件内的入口）。`Ctrl+H` 是**页面内**的按键监听（不是全局热键），软件窗口聚焦时才生效。
- 只测过 Mineradio **2.2.0**。上游改了锚点附近的代码时安装器会明确报 `drift` 并拒绝瞎插，那时需要更新 `mods.json` 里的 `locator`。
- **`auto-source-fallback` 是整模块接管**：它用同名全局函数重新声明上游 `11-provider-fallback.js` 的那一套（不整份替换上游文件，否则卸载回不到逐字节原版）。代价是上游哪天改了这条链，`--verify` 看不出冲突——我们这份会安静地赢。唯一兜得住的是每次改完真跑一遍 `tools/live-check.mjs`（最后那三条换源断言就是干这个的）。
- **IA 的一行不是一个单曲**，是一个 archive.org 条目；条目里挑哪个文件由后端按音质档决定（只挑浏览器能解码的），所以列表上没有时长——真实时长在取址那一步才回来。要精确到某一轨得等"条目下钻"（还没做）。
- **RP 是直播**：没有单曲搜索（关键词只用来把命中的频道排前面）、拖不了进度、没有同步歌词，也不进 All 档。
- **IA / RP 不参与自动换源**（与开发版同一口径）：它们没有"同名同歌手同一录音"的可靠判据，自动接管会播错内容，比不播更糟；只保留手动搜索与浮窗档位。

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
tools/live-check.mjs                 端到端真跑（真开窗口、真打字、真出声）
tools/check-page-expressions.mjs     改完 live-check 先跑它：把 88 条页面表达式单独解析一遍
docs/PORTING.md    还没搬的功能族各自落在哪、怎么搬
```

```bat
node --test tests/
node tools/check-page-expressions.mjs
```

测试全程在临时目录里跑，不碰你正在用的 Mineradio。夹具从旁边的开发仓库
（`E:\Projects\mineradio`，可用 `MINERADIO_DEV_REPO` 改）用 `git archive d43de56`
取上游原版；拿不到那个仓库就**整组跳过并说明原因**（不崩）。21 项里前 6 项验锚点本身：
八个锚点在**原版文件**里都找得到位置、注入后四个上游文件仍是合法 JS、重复注入结果一致（幂等）、
卸载后与原版**逐字节相同**、模拟"软件更新把上游文件换掉"之后重跑能全部恢复、以及定位不到时报
`drift` 而不是乱插。
另有 6 项是**起真安装器子进程**跑的（出事的多半是外面那一层：路径怎么定的、覆盖前备不备份、
卸载撤得干不干净）：`--path` 打错时不许退回自动探测去写另一份安装、目标位置上已有同名文件时
先备份原件且卸载时还原、卸载后不留任何原版没有的文件、`--uninstall --mod` 只撤那一族而
共用的锚点与别人在用的文件一个字不动、app 目录里那份 `mods/reapply.mjs` 没有状态目录也跑得起来、
没注册过开机检查时卸载不碰注册表也不凭空建状态目录。
剩下 9 项：开机检查的台账决策 4 项（两份并存时卸一份不能把另一份的开机检查弄没）、
各盘根目录的探测 2 项、夹具这一层 3 项（解不出来要给原因、clone 在 `%TEMP%` 那种带盘符的
路径里也解得开）。开机检查那几条只测台账，不碰注册表：测试一律带 `MINERADIO_MODS_STATE`
指到临时目录，而安装器只删**自己写进去的那条** `Run` 值。

加一个新外挂：把文件放进 `files/`，在 `mods.json` 的 `mods[]` 里登记一条
（要哪些锚点、投放哪些文件），如果是渲染层行为就在 `files/public/js/mods/` 里加一个模块
并在 `loader.js` 的清单里加一行。跑 `node install.mjs` 看计划，`--go` 落地。

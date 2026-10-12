# 还没搬的功能族：落点与做法

对照的是**上游原版 2.2.0**（基线提交 `d43de56`）与开发仓库 `E:\Projects\mineradio` 的差异。
下面每一行都是逐个 hunk 核过的，不是猜的。

判断口径三档：
- **包装**：渲染层外挂模块在 `loader.js` 之后加载，直接 `var 原=window.f; window.f=function(){...}` 就能生效
  （上游模块拼成一个 classic `<script>`，顶层函数本来就是 window 属性，内联 `onclick` 也走全局查找）。
- **锚点**：必须在上游文件里加一行，已有 6 个（见 README 的表）。
- **改文件**：外置不了，只能整份替换上游文件 —— 软件一更新就没了，**要尽量避免**。

| 功能族 | 上游落点 | 做法 | 依赖的本体文件 | 风险 / 备注 |
|---|---|---|---|---|
| B 站音源·后端 | `server.js` 路由链 | 锚点 `server-routes`（已有） | `bilibili-api.js`、`mods/server-api.js` | 已搬完；`server-api.js` 现在一共接管 15 条路由（B 站 7 + IA 3 + RP 5 + 更新检查 3 类） |
| B 站音源·播放 | ✅ 已搬完：锚点 `playback-gapless-url`（`resolveAlbumGaplessPlaybackData` 里 `var qualityParam = ...` 之后一行）+ `playback-url`（主取址那串 if/else 之后、`if (data) {` 之前一行），两边都调 `window.__mrModsSongUrl` | 渲染层还要**包装三个上游函数**：`songProviderKey`（上游对不认识的源一律回 `netease`，不补这课 B 站行连徽章都出不来）、`normalizePlaybackProvider`、`lyricEndpointForSong`（B 站没官方歌词，别拿歌名去网易云捞一份错歌词） | `bilibili-api.js`、`mods/server-api.js`、`05-sources.js` | 已在 `.live` 干净实例上真跑过（live-check 14/14） |
| B 站合集分 P（主界面） | `07-search.js`：`biliPartsCache`、`toggleBiliParts`、`playBiliPart`、`queueBiliCollection`、`searchSongResultHtml`、`biliCollectionPanelHtml` | 全部是**新增顶层函数** → 直接放进外挂模块即可；要改的只有"结果行点击走展开而不是播放"这一处 → **包装 `searchSongResultHtml`** | 无（逻辑自包含） | 浮窗那侧的分 P 已随 `quick-search` 一起搬（宿主自带兜底实现，不依赖主界面那套） |
| B 站非音乐过滤 | `bilibili-api.js` 的 `classifyBiliSearchResult` | 本体文件里，**零锚点** | `bilibili-api.js` | 已搬完 |
| IA / RadioParadise | ✅ 已搬完（`free-sources`）：`mods/server-api.js` 里 8 条路由 + `05-sources.js` 源表两项 + 浮窗 IA / RP 两档 | 渲染层没有新锚点，全靠已有的 6 个；顺带**包装了 `songSourceTagHtml`**（上游那条只认 NE/QQ/KG/QS/SP 的三元链会把新源那行标成"NE"，class 对了文字还是错的） | `internetarchive-api.js`、`radioparadise-api.js`、`mods/server-api.js`、`05-sources.js` | 已在 `.live` 干净实例真跑到 39/39：含从浮窗起播 IA 条目与 RP 直播、`rpChan=0` 那个真值判断坑、All 档滚到 IA 行的标签文字 |
| 咪咕后端 | `server.js` 链 | 锚点 `server-routes`（已有），照上面 IA/RP 那行的形状加 `handleMiguRoute` | `migu-api.js`（已在包里） | 比 IA/RP 多一件事：会话 |
| 咪咕会话 | `server.js` 的 cookie 存取（`configuredCookieStores` 一带） | 外挂自己存 `~/.mineradio/migu-cookie`，**不动上游**（B 站那套 `readCookie`/`writeCookie` 直接照抄） | `migu-api.js` | 放家目录而不是安装目录，更新不丢 |
| 自动换源（免登录源参与接力） | ✅ 已搬完（`auto-source-fallback`）：`files/public/js/mods/50-provider-fallback.js` | **整模块接管**：以外挂模块的形式重新声明上游 `11-provider-fallback.js` 的同名全局函数。**不要**改成"把文件投放到上游路径"——安装器对上游路径只会删文件、不会还原，卸载就回不到逐字节原版 | `50-provider-fallback.js` | 代价：上游改了这条链时 `--verify` 看不出来（锚点与投放文件都"对"），只有真跑能发现。咪咕不在包里 ⇒ 免登录池子只有 `netease + bilibili`，"有咪咕会话就提到链首"那两段留在开发版没接；IA/RP 明确排除在自动换源外 |
| 贴边播放小组件 | ✅ 已搬完（`edge-widgets`）：`desktop/mods-widget-host.js` 自建窗口 + `public/mini-player.html` + `desktop/mods-mini-player-runtime.js`（纯几何）+ `desktop/mods-widget-preload.js` | 零新锚点（浮窗已是先例）；入口那颗「贴边」由 `40-widgets.js` 运行时插进上游那排 `.desktop-mode-btn` | `mini-player.html`、`mods-mini-player-runtime.js` | 两个窗口都是 `hide` 型的，退出前必须在 `before-quit` 里 `destroy()`，否则进程留在后台退不掉（踩过） |
| 屏幕边缘进度轨 | ✅ 已搬完（与贴边同一族）：`public/edge-rail.html` + 同一个 `mods-widget-host.js` | 不是第二个开关：它就是组件收到屏边的那个形态，两个窗口的显示都由 `miniPlayerState.collapsed` 派生 | `edge-rail.html` | `getDisplayArea()` 是上游私有的 → 自己实现一份（就两行）。窗口横截面被 Windows 夹到 ~36px，必须**两遍定位** + 页面侧 `--bleed` 内缩，否则条子会被切掉一半 |
| Ctrl+H 历史记录与存档 | ✅ 已搬完（`danger-archive`）：`desktop/mods-danger-archive-store.js` 在宿主里建实例并注册 5 个 ipcMain 通道（read/append/remove/**set-label**/clear，只认主窗口）；`public/js/mods/30-danger-archive.js` 当外挂模块装载 | 模态框与那一段 CSS 全部**运行时注入**（上游 `index.html` 里没有它们），入口那颗「历史」按钮同法插进上游那排 `.desktop-mode-btn`（照「贴边」那颗的写法）；桥接走外挂自己的 `desktopMods`——上游 `desktopWindow` 是冻结的，事后补不进方法 | `mods-danger-archive-store.js`、`30-danger-archive.js`、`mods-danger-archive.css` | 存档写在 `userData`（不是 localStorage、也不是安装目录）：它备份的正是 localStorage 那三条。上游的"清空"是把键写成**空列表**而不是删键，所以自检要数"还剩几条"，不能量字节。改名不许用 remove+append 顶替（会把条目挤到列表前面、时间线乱），所以有第 5 个通道 |
| 音质档位 / 登录入口 | `00-api-quality-output.js`、`01-login-modal-utils.js` 的 `platformStatus`、`04-user-modal-logout.js` 的 `openProviderLogin`、`03-login-modal-flows.js` | **包装**（都是顶层函数）；UI 行用运行时 DOM 注入 | — | 上游有个"登录彩蛋门"，别硬拆 |
| 关掉自动更新 | ✅ 已搬完：`mods/server-api.js` 里接管 `/api/update/latest` 与 `/api/update/(download|patch)*` | 锚点 `server-routes`（已有），**不改 `package.json`** | — | 上游的更新检查走它自己的后端，答"没有更新"比改配置抗更新 |
| 托盘备用入口 | `main.js` 的 `createOrUpdateTray` | **改文件**（Tray 实例与菜单模板都是模块私有） | — | 决定放弃：软件内入口与热键都够 |
| "关主窗口=收进后台"含浮窗 | `main.js` 的 `createWindowOnce` close 判定 | 需要第 9 个锚点；现在的替代是宿主在主窗口关闭时把**浮窗、贴边组件、进度轨**都收起来，退出前统一 `destroy()` | — | 已知限制，写在 README |
| UI 文案 / CSS | `index.html`（+41/−0，全是独立新增节点）、`index.css`（+434/−0，全是新选择器） | DOM 注入 + 外挂 `<style>` 由 `loader.js` 插入 | — | 核过：没有任何一处"必须改 HTML/CSS 文件" |

## 搬下一个之前先做的事

1. 在 `mods.json` 里把该族的 `enabled` 打开、`files` 补全 —— `tests/installer.test.mjs` 的第一条
   用例就是"清单自洽"，文件没在包里会直接红。
2. 需要新锚点时，先在**上游原版夹具**上确认 `locator` 命中（跑 `--verify`），
   再把锚点定义写进 `mods.json`；不要为了省事去整份替换上游文件。
3. 渲染层包装一律写成"原函数不存在就跳过"的形状：
   `var 原 = window.f; if (typeof 原 !== 'function') return; window.f = function(){...}`。
   上游哪天改名，外挂应当安静地不生效，而不是把播放器弄白屏。
4. 每搬完一族，在干净夹具上跑一遍 `install --go` + `node --check` 四个上游文件，
   再复制一份运行时（exe + dll + `resources/app`）真起一次实例验功能。
5. 改了 `tools/live-check.mjs` 就先跑 `node tools/check-page-expressions.mjs`：它把每条
   送给页面的表达式单独解析一遍。端到端一趟八到十分钟，模板字符串里少一个右括号
   这种事不该用一次端到端去换（真发生过三次）。

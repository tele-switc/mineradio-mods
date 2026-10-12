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
| 自动换源（免登录源参与接力） | `11-provider-fallback.js`（开发版 +225 行） | **包装** `sourceFallback*` 那一组顶层函数；候选池要加新源 | 各 `*-api.js` | 这族最费时间，且和音质档位耦合 |
| 音质档位 / 登录入口 | `00-api-quality-output.js`、`01-login-modal-utils.js` 的 `platformStatus`、`04-user-modal-logout.js` 的 `openProviderLogin`、`03-login-modal-flows.js` | **包装**（都是顶层函数）；UI 行用运行时 DOM 注入 | — | 上游有个"登录彩蛋门"，别硬拆 |
| 贴边播放小组件 | `main.js` 的 mini 窗口 + `mini-player.html` + `desktop/mini-player-runtime.js` | 窗口在 `mods-host.js` 里自建（已有先例：浮窗就是这么做的）；入口按钮 DOM 注入 | `mini-player.html`、`mini-player-runtime.js` | 与桌面嵌入模式的兼容要单独验 |
| 屏幕边缘进度轨 | `main.js` 的 edgeRail 窗口 | 同上，宿主自建窗口 | `public/edge-rail.html` | 需要 `getDisplayArea` 之类的私有工具 → 自己实现一份 |
| Ctrl+H 清空与存档 | `main.js` 的 `dangerArchiveStore` + 两个 ipcMain 通道；`20-danger-archive.js`；`index.html` 的 modal 节点 | 主进程侧 `require('.../desktop/danger-archive-store.js')` 在宿主里建实例；modal 用 DOM 注入；模块直接放 `files/public/js/modules/05-playback/20-danger-archive.js` 由 `loader.js` 装载 | `danger-archive-store.js`、`20-danger-archive.js` | 清空口径（回到从来没听过歌）依赖上游的存档函数，都要在包装里调 |
| 关掉自动更新 | ✅ 已搬完：`mods/server-api.js` 里接管 `/api/update/latest` 与 `/api/update/(download|patch)*` | 锚点 `server-routes`（已有），**不改 `package.json`** | — | 上游的更新检查走它自己的后端，答"没有更新"比改配置抗更新 |
| 托盘备用入口 | `main.js` 的 `createOrUpdateTray` | **改文件**（Tray 实例与菜单模板都是模块私有） | — | 决定放弃：软件内入口与热键都够 |
| "关主窗口=收进后台"含浮窗 | `main.js` 的 `createWindowOnce` close 判定 | 需要第 9 个锚点；现在的替代是宿主在主窗口关闭时收起浮窗 | — | 已知限制，写在 README |
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

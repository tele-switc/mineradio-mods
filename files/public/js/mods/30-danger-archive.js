// ============================================================
//  Ctrl+H · 历史记录与状态存档（2026-10-09 加 · 2026-10-12 按用户要求改版）
//
//  这一版改掉三件事（用户 2026-10-12 原话："不要有密码框和一键清空，改成 ctrl+h 可以打开
//  历史记录，也有专门的按键可以打开，然后可以编辑历史记录"）：
//   1. 密码门整段删掉：Ctrl+H 直接把面板打开。原先那句"密码防的是误触不是外人"也不再需要
//      —— 面板里已经没有一把抹光的按钮，误触最多打开一个一眼看得穿的列表，点错也只错一条。
//   2. 「一键清空」那颗按钮和 runDangerArchiveClearAll 一起删掉，界面上再也没有
//      "一次点掉搜索记录 + 播放列表 + 聆听统计"的入口。停播与清场那几个内部函数留着：
//      **恢复一份存档**本身就是"先把现场清掉、再把那一刻的原始字符串写回去"，
//      少了这一步恢复就成了往旧列表上叠新列表。
//   3. 面板改成两个页签，两条页都能逐条改名、逐条删除：
//      「历史」= 软件里真实有内容的那两份 —— 搜索记录（上游 ≤10 条词）、
//                聆听记录（上游 history 数组 ≤180 条）；
//      「存档」= 状态快照列表，点一条整个回到那一刻（搜索记录、队列、当前曲目、进度）。
//
//  「存一份当前状态」是这版新加的，不是一时兴起：一键清空原先是**唯一**产生存档的触发点，
//  实测 %APPDATA%\Mineradio\mineradio-danger-archive.json 现在 archives:0。把那颗按钮删掉
//  又不补一个触发点，「存档」页签就永远空的。这颗新按钮只 capture + append，不清任何东西，
//  kind 记成 manual。
//
//  三条会咬人的细节（没变）：
//   1. 存档必须先写成功才算数。append 回非 ok 就不动数据，也不假装存好了。
//   2. 存档落在 userData 的 JSON 文件里，不在 localStorage（落盘见
//      desktop/mods-danger-archive-store.js）。它备份的正是 localStorage 那三条，
//      存在同一个地方等于把钥匙和锁放同一个抽屉。
//   3. 捕获的是原始字符串，恢复时原样写回，不经过"解析—改字段—再序列化"。
//      播放存档里 provider/mid/hash/localKey 那一堆字段，任何一个在我们的往返里被
//      "顺手规范化"，恢复出来的列表就可能点不响。
//
//  「历史」页那两条记录不能只改 localStorage：
//   上游的 listenStatsState 与搜索历史都有一份常驻内存的副本，进度 tick / 听完一首
//   会拿内存版把键写回来。所以改名与删除都是**先改内存对象、再调上游的 save**
//   （writeSearchHistory / saveListenStatsState），上游函数不在（浏览器里直接开前端）
//   才退到直接写 localStorage。
//   删除聆听记录只删 history 里那一行，累计统计（songs/artists 的次数与时长、首页
//   "最常听"那张卡）不动 —— 那是统计不是历史；要连统计一起抹以前归一键清空管，
//   现在没那个入口了，界面上也老实写着这件事。
//
//  改名输入框的 value 不走 escHtml：上游那个 escHtml 是 textContent → innerHTML，
//  只转义 & < >，**不转义引号**（public/js/modules/05-playback/00-api-quality-output.js:20），
//  歌名里有 " 就会把属性拼断。所以输入框先渲染成空 value，innerHTML 落好之后
//  再用 DOM 属性 input.value = 原值 赋进去。
//
//  清空为什么还走 app 自己的两个函数而不是自己删 localStorage：
//   clearSearchHistory() 和 clearQueue() 是用户平时点「清空」走的路径，它们除了删数据
//   还要重绘画廊架、队列面板、空主页。自己删键会得到"数据没了但界面还挂着 23 首"。
//   恢复方向同理，优先复用 restoreLastPlaybackSnapshot()（启动时恢复播放走的就是它），
//   它返回 false（存档里没有 current）时才走本模块的手动重建。
//
//  恢复时不会自动放声：跟软件启动时恢复上次播放的口径一致 —— 列表、当前曲目、进度都摆好，
//   等用户自己按播放。要不要自动播由「启动自动播放」那个开关决定，本模块不替用户改它。
//
//  ------------------------------------------------------------
//  mineradio-mods 外挂版与开发版的四处差别（逻辑一个字没改，只是换了挂载点）：
//   1. 开发版的模态框写在 index.html 里、样式写在 index.css 里 —— 那两个文件上游更新时
//      会被整份换掉，所以这里**运行时注入**：DOM 由本模块拼（dangerArchiveInjectModal），
//      样式由 css/mods-danger-archive.css 挂一个 <link>。
//   2. 存档那几个 IPC 方法在开发版挂在 desktopWindow 上；装在**原版**上时上游那个
//      contextBridge 对象里根本没有它们，而且暴露出去的对象是冻结的、事后补不进去
//      → 外挂那一份在自己的 desktopMods 上（见 blocks/preload-main.js），下面 bridge() 两个都认。
//   3. 落盘的是主进程 desktop/mods-danger-archive-store.js 注册的通道，写在 userData 目录
//      （不是安装目录），软件更新动不到它。
//   4. 入口那颗「历史」按钮同样是运行时注入：插进 .desktop-mode-btn 那一排，写法照
//      40-widgets.js 的「贴边」那颗（首选 DIY 那颗之前 → 任意一颗前面 → #bottom-bar 末尾）。
// ============================================================

var DANGER_ARCHIVE_HOTKEY = 'Ctrl+KeyH';
var DANGER_ARCHIVE_MODAL_ID = 'danger-archive-modal';
var DANGER_ARCHIVE_BUTTON_ID = 'danger-archive-history-btn';
// 存档"改名"落在这条记录新加的 label 字段上（store 里白名单放行，最长 60 字）。
var DANGER_ARCHIVE_LABEL_MAX = 60;
// 没有桌面端 IPC 时（直接在浏览器里跑前端）退到 localStorage，功能可测可看，
// 但要提示用户这份备份会跟着缓存一起没
var DANGER_ARCHIVE_BROWSER_STORE_KEY = 'mineradio-danger-archive-browser-fallback-v1';
var DANGER_ARCHIVE_TIMEZONE = 'Asia/Shanghai';
// 上游那三个键名（00-core-stores.js / 07-search.js 里的常量）。这里是渲染层，
// 正常路径直接读那几个全局变量；写在浏览器里预览时它们不存在，才用这份字面量兜底。
var DANGER_ARCHIVE_KEY_LITERALS = {
  search: 'mineradio-search-history',
  playback: 'mineradio-last-playback-v1',
  stats: 'mineradio-listen-stats-v1',
};
var dangerArchiveBusy = false;
var dangerArchiveLastList = [];
// 正在等"确认删除"的那条存档 id（同一时刻只允许一条处于待确认状态）
var dangerArchivePendingDeleteId = '';
// 正在改名的那一行：{ kind: 'search'|'listen'|'archive', token: 下标或存档 id, value: 初值 }
var dangerArchiveEditing = null;
// 当前页签：'history'（默认，Ctrl+H 就是为它来的）或 'archive'
var dangerArchiveTab = 'history';

// ---------- 模态框与样式：运行时注入（上游 index.html / index.css 里没有这两处） ----------

var DANGER_ARCHIVE_MODAL_HTML = ''
  + '<div id="danger-archive-modal" class="modal-mask" role="dialog" aria-modal="true" aria-hidden="true">'
  + '  <div class="modal danger-archive-modal">'
  + '    <div class="login-panel-head">'
  + '      <button class="login-panel-close" type="button" onclick="closeDangerArchiveModal()">×</button>'
  + '    </div>'
  + '    <div class="danger-archive-title"><b>历史记录</b><small>History &amp; Snapshots · Ctrl+H</small></div>'
  + '    <div class="danger-archive-tabs" role="tablist">'
  + '      <button class="danger-archive-tab" type="button" role="tab" data-danger-archive-tab="history">历史</button>'
  + '      <button class="danger-archive-tab" type="button" role="tab" data-danger-archive-tab="archive">存档</button>'
  + '    </div>'
  + '    <div id="danger-archive-status" class="danger-archive-status"></div>'
  + '    <div class="danger-archive-page danger-archive-page-history" data-danger-archive-page="history">'
  + '      <div class="desc">这里是你听过的痕迹：搜索记录与聆听记录。点一行就是改名字（回车保存、Esc 取消），行尾那颗是删掉这一条。删除只去掉这一条本身，配置（音质、特效、封面歌词、快捷键、登录、本地曲库）和累计统计都不动。</div>'
  + '      <div class="danger-archive-list-head">'
  + '        <span>搜索记录</span><small id="danger-archive-search-count"></small>'
  + '      </div>'
  + '      <div id="danger-archive-search-list" class="danger-archive-list is-short"></div>'
  + '      <div class="danger-archive-list-head">'
  + '        <span>聆听记录</span><small id="danger-archive-listen-count"></small>'
  + '      </div>'
  + '      <div id="danger-archive-listen-list" class="danger-archive-list"></div>'
  + '      <div id="danger-archive-note-history" class="danger-archive-note"></div>'
  + '    </div>'
  + '    <div class="danger-archive-page danger-archive-page-archive" data-danger-archive-page="archive">'
  + '      <button class="danger-archive-snapshot" type="button" onclick="runDangerArchiveSnapshot()">'
  + '        存一份当前状态</button>'
  + '      <div class="desc">「存一份当前状态」把此刻的搜索记录、播放队列与聆听统计原样存下来（什么都不清）。点下面任意一条存档，整个软件回到那一刻；行尾可以给它改个名字或删掉这一份。恢复之前会先自动存一份"恢复前"，点错了能退回来。</div>'
  + '      <div class="danger-archive-list-head">'
  + '        <span>状态存档</span><small id="danger-archive-count"></small>'
  + '      </div>'
  + '      <div id="danger-archive-list" class="danger-archive-list"></div>'
  + '      <div id="danger-archive-note-archive" class="danger-archive-note"></div>'
  + '    </div>'
  + '  </div>'
  + '</div>';

// 入口按钮：上游那排 .desktop-mode-btn 里没有这颗，运行时插进去。
var DANGER_ARCHIVE_BUTTON_HTML = ''
  + '<button id="danger-archive-history-btn" class="desktop-mode-btn" type="button"'
  + ' onclick="toggleDangerArchivePanel()" title="历史记录（搜索记录与聆听记录，可改名可逐条删除；也含状态存档）· Ctrl+H"'
  + ' aria-label="历史记录" aria-haspopup="dialog" aria-expanded="false">历史</button>';

function dangerArchiveInjectModal() {
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById(DANGER_ARCHIVE_MODAL_ID)) return true;
    var holder = document.createElement('div');
    holder.innerHTML = DANGER_ARCHIVE_MODAL_HTML;
    var node = holder.firstElementChild;
    if (!node) return false;
    document.body.appendChild(node);
    return true;
  } catch (e) {
    console.warn('[mods] 历史记录面板的模态框注入失败：' + ((e && e.message) || e));
    return false;
  }
}

function dangerArchiveInjectStyle() {
  try {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector('link[data-mineradio-mods="danger-archive"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-mineradio-mods', 'danger-archive');
    link.href = 'css/mods-danger-archive.css?v=' + Date.now();
    document.head.appendChild(link);
  } catch (e) { }
}

// 首选 DIY 那颗之前（与开发版里它的位置一致）；上游哪天改了这排按钮就退到任意一颗
// .desktop-mode-btn 前面，再退到控制条末尾 —— 总得有个能点的地方。
function dangerArchiveInjectEntryButton() {
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById(DANGER_ARCHIVE_BUTTON_ID)) return true;
    var holder = document.createElement('div');
    holder.innerHTML = DANGER_ARCHIVE_BUTTON_HTML;
    var btn = holder.firstElementChild;
    if (!btn) return false;
    var anchor = document.getElementById('diy-mode-btn') || document.querySelector('.desktop-mode-btn');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('beforebegin', btn);
    else if (document.getElementById('bottom-bar')) document.getElementById('bottom-bar').appendChild(btn);
    else return false;
    return true;
  } catch (e) {
    console.warn('[mods] 历史记录的入口按钮没插上：' + ((e && e.message) || e));
    return false;
  }
}

// 上游的模块是拼成一串 <script> 在装载期就执行的：那时 <body> 可能还没解析完，
// 所以两处都要有 —— DOMContentLoaded 挂一次，真正要用的时候再补一次。
function dangerArchiveEnsureMounted() {
  dangerArchiveInjectStyle();
  var modal = dangerArchiveInjectModal();
  dangerArchiveInjectEntryButton();
  return modal;
}
try {
  if (typeof document !== 'undefined') {
    if (document.body) dangerArchiveEnsureMounted();
    else document.addEventListener('DOMContentLoaded', dangerArchiveEnsureMounted);
  }
} catch (e) { }

function dangerArchiveModal() {
  return document.getElementById(DANGER_ARCHIVE_MODAL_ID);
}

function dangerArchiveBridge() {
  // desktopMods = 外挂自己那段桥接（装在原版上时只有它有这几个方法）；
  // desktopWindow = 开发仓库那份（上游 bridge 里本来就有），认它是为了这个模块
  // 在开发场上也能直接跑，不用两边各存一份实现。
  var candidates = [window.desktopMods, window.desktopWindow];
  for (var i = 0; i < candidates.length; i++) {
    var api = candidates[i];
    if (api && typeof api.readDangerArchives === 'function') return api;
  }
  return null;
}

function dangerArchiveIsDesktopBridge() {
  return !!dangerArchiveBridge();
}

// ---------- 上游键名与状态读写 ----------

function dangerArchiveKey(which) {
  var literal = DANGER_ARCHIVE_KEY_LITERALS[which] || '';
  var globalName = which === 'search' ? 'SEARCH_HISTORY_STORE_KEY'
    : which === 'playback' ? 'LAST_PLAYBACK_STORE_KEY' : 'HOME_LISTEN_STATS_KEY';
  try {
    var value = window[globalName];
    if (typeof value === 'string' && value) return value;
  } catch (e) { }
  return literal;
}

function dangerArchiveParseRaw(raw) {
  try {
    var parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

// 搜索记录：走上游的 readSearchHistory（它负责把 v1 那种按模式分的旧结构迁平成
// 一个字符串数组），上游函数不在才自己解析。
function dangerArchiveReadSearchItems() {
  if (typeof readSearchHistory === 'function') {
    try {
      var upstream = readSearchHistory();
      if (Array.isArray(upstream)) return upstream.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
    } catch (e) { }
  }
  var data = dangerArchiveParseRaw(localStorage.getItem(dangerArchiveKey('search')));
  var raw = [];
  if (Array.isArray(data)) raw = data;
  else if (data && Array.isArray(data.items)) raw = data.items;
  return raw.map(function (item) { return String(item || '').trim(); }).filter(Boolean).slice(0, 10);
}

// 写入必须走上游的 writeSearchHistory：它会 normalizeSearchHistoryItems
// （大小写不敏感去重 + 限 10 条 + 补 version 字段）。自己 JSON.stringify 会绕开这套，
// 下次上游读到时行为就不一样了。
function dangerArchiveWriteSearchItems(items) {
  if (typeof writeSearchHistory === 'function') {
    try { writeSearchHistory(items); return true; } catch (e) { }
  }
  try {
    localStorage.setItem(dangerArchiveKey('search'), JSON.stringify({ version: 3, items: items }));
    return true;
  } catch (e) { }
  return false;
}

// 搜索面板正显示"搜索历史"那一屏时，改完要立刻重画，否则芯片上还挂着旧词。
function dangerArchiveAfterSearchChange() {
  try { if (typeof renderSearchHistory === 'function') renderSearchHistory(); } catch (e) { }
}

function dangerArchiveListenDoc() {
  try {
    if (typeof listenStatsState === 'object' && listenStatsState && Array.isArray(listenStatsState.history)) {
      return listenStatsState;
    }
  } catch (e) { }
  var data = dangerArchiveParseRaw(localStorage.getItem(dangerArchiveKey('stats')));
  if (data && Array.isArray(data.history)) {
    return {
      history: data.history,
      songs: data.songs && typeof data.songs === 'object' ? data.songs : {},
      artists: data.artists && typeof data.artists === 'object' ? data.artists : {},
      updatedAt: Number(data.updatedAt) || 0,
    };
  }
  return { history: [], songs: {}, artists: {}, updatedAt: 0 };
}

function dangerArchiveReadListenRows() {
  var rows = dangerArchiveListenDoc().history;
  return Array.isArray(rows) ? rows.slice() : [];
}

// 与 dangerArchiveWipeListenStats 同一个道理：listenStatsState 是常驻内存的，
// 只写 localStorage 的话下一次进度 tick 或下一首听完就把旧内容覆盖回来了。
// 所以先改内存那份，再调上游的 saveListenStatsState（它自己会 updatedAt + 落盘）。
function dangerArchiveWriteListenHistory(rows) {
  var list = Array.isArray(rows) ? rows : [];
  try {
    if (typeof listenStatsState === 'object' && listenStatsState && Array.isArray(listenStatsState.history)) {
      listenStatsState.history = list;
    }
  } catch (e) { }
  try {
    if (typeof saveListenStatsState === 'function') { saveListenStatsState(); return true; }
  } catch (e) { }
  try {
    var doc = dangerArchiveListenDoc();
    doc.history = list;
    doc.updatedAt = Date.now();
    localStorage.setItem(dangerArchiveKey('stats'), JSON.stringify(doc));
    return true;
  } catch (e) { }
  return false;
}

// 首页 CONTINUE / RECENT 两张卡读的就是这份 history，改完立刻重画，
// 否则卡片上还挂着刚删掉那条，看起来就是"没删成"。
function dangerArchiveAfterListenChange() {
  try { if (typeof renderHomeDashboardQuickCards === 'function') renderHomeDashboardQuickCards(); } catch (e) { }
  try { if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false }); } catch (e) { }
}

// ---------- 存档读写（桌面端走主进程，浏览器端退 localStorage） ----------

function dangerArchiveReadBrowserDoc() {
  try {
    var parsed = JSON.parse(localStorage.getItem(DANGER_ARCHIVE_BROWSER_STORE_KEY) || 'null');
    if (parsed && Array.isArray(parsed.archives)) return parsed;
  } catch (e) { }
  return { version: 1, archives: [] };
}

function dangerArchiveWriteBrowserDoc(doc) {
  var archives = Array.isArray(doc && doc.archives) ? doc.archives.slice(0, 20) : [];
  try {
    localStorage.setItem(DANGER_ARCHIVE_BROWSER_STORE_KEY, JSON.stringify({ version: 1, updatedAt: Date.now(), archives: archives }));
  } catch (e) { }
  return { ok: true, archives: archives };
}

function dangerArchiveReadList() {
  var bridge = dangerArchiveBridge();
  if (!bridge) return Promise.resolve(dangerArchiveReadBrowserDoc());
  return Promise.resolve(bridge.readDangerArchives()).then(function (res) {
    if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'READ_FAILED', detail: res && res.detail };
    return { ok: true, archives: res.archives || [] };
  }).catch(function (e) {
    return { ok: false, error: 'READ_THROW', detail: String((e && e.message) || e) };
  });
}

function dangerArchiveAppendRecord(record) {
  var bridge = dangerArchiveBridge();
  if (!bridge) {
    var doc = dangerArchiveReadBrowserDoc();
    return Promise.resolve(dangerArchiveWriteBrowserDoc({ archives: [record].concat(doc.archives || []) }));
  }
  return Promise.resolve(bridge.appendDangerArchive(record)).then(function (res) {
    if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'APPEND_FAILED', detail: res && res.detail };
    return { ok: true, archives: res.archives || [], dropped: res.dropped || [] };
  }).catch(function (e) {
    return { ok: false, error: 'APPEND_THROW', detail: String((e && e.message) || e) };
  });
}

function dangerArchiveRemoveRecord(id) {
  var bridge = dangerArchiveBridge();
  if (!bridge) {
    var doc = dangerArchiveReadBrowserDoc();
    return Promise.resolve(dangerArchiveWriteBrowserDoc({
      archives: (doc.archives || []).filter(function (item) { return String(item && item.id) !== String(id); }),
    }));
  }
  return Promise.resolve(bridge.removeDangerArchive(id)).then(function (res) {
    if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'REMOVE_FAILED' };
    return { ok: true, archives: res.archives || [] };
  }).catch(function (e) {
    return { ok: false, error: 'REMOVE_THROW', detail: String((e && e.message) || e) };
  });
}

// 改名走主进程的 set-label 通道：只动 label 这一个字段，id/createdAt/state 原样留着，
// 顺序也不变。用 remove + append 代替会把这条挤到列表最前面，时间线就乱了。
// 老版主进程没有这个通道时明确报 NO_CHANNEL，不在内存里假装修好了。
function dangerArchiveSetLabel(id, label) {
  var clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  var text = String(label == null ? '' : label).trim().slice(0, DANGER_ARCHIVE_LABEL_MAX);
  if (!clean) return Promise.resolve({ ok: false, error: 'BAD_ID' });
  var bridge = dangerArchiveBridge();
  if (!bridge) {
    var doc = dangerArchiveReadBrowserDoc();
    var archives = (doc.archives || []).map(function (item) {
      if (String(item && item.id) !== clean) return item;
      var next = Object.assign({}, item, { label: text });
      if (!text) delete next.label;
      return next;
    });
    return Promise.resolve(dangerArchiveWriteBrowserDoc({ archives: archives }));
  }
  if (typeof bridge.updateDangerArchiveLabel !== 'function') {
    return Promise.resolve({ ok: false, error: 'NO_CHANNEL', detail: '主进程没有改名通道，重跑一次 install.mjs 就有' });
  }
  return Promise.resolve(bridge.updateDangerArchiveLabel(clean, text)).then(function (res) {
    if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'SET_LABEL_FAILED', detail: res && res.detail };
    return { ok: true, archives: res.archives || [] };
  }).catch(function (e) {
    return { ok: false, error: 'SET_LABEL_THROW', detail: String((e && e.message) || e) };
  });
}

// ---------- 状态捕获 ----------

// 队列还挂在界面上、但播放存档还没来得及写（saveLastPlaybackSnapshot 有 2.5 秒节流，
// 且没有当前曲目时直接 return）的情况下，用内存里的真实列表补一份出来，
// 否则"存一份当前状态"会存成一份空的，等于白存。
function dangerArchiveLiveSnapshotPayload() {
  var queue = Array.isArray(playQueue) ? playQueue.slice(0, 120) : [];
  if (!queue.length) return null;
  var idx = currentIdx >= 0 && currentIdx < queue.length ? currentIdx : 0;
  var items = queue.map(function (song) { return playbackRestoreSongSnapshot(song); })
    .filter(function (item) { return item && (item.id || item.mid || item.localKey || item.name); });
  if (!items.length) return null;
  var current = items[Math.min(idx, items.length - 1)];
  return {
    version: 1,
    savedAt: Date.now(),
    queueChangedAt: Number(typeof lastQueueChangedAtMs !== 'undefined' ? lastQueueChangedAtMs : 0) || Date.now(),
    reason: 'danger-archive-capture',
    currentIdx: Math.min(idx, items.length - 1),
    currentTime: Math.max(0, Number(getPlaybackCurrentSeconds && getPlaybackCurrentSeconds()) || 0),
    duration: Math.max(0, Number(getPlaybackDurationSeconds && getPlaybackDurationSeconds()) || 0),
    playing: !!(typeof audio !== 'undefined' && audio && audio.src && !audio.paused && !audio.ended),
    current: current,
    queue: items,
  };
}

// 抓现场。先强制刷一次播放存档，让存档反映的是"此刻的列表"而不是"2.5 秒前那次
// autosave 的列表"。
function dangerArchiveCaptureState() {
  var state = {};
  try {
    if (typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, 'danger-archive');
  } catch (e) { }
  var searchRaw = null;
  var playbackRaw = null;
  try { searchRaw = localStorage.getItem(dangerArchiveKey('search')); } catch (e) { }
  try { playbackRaw = localStorage.getItem(dangerArchiveKey('playback')); } catch (e) { }
  // 屏幕上挂着列表时，以内存里那份为准：autosave 有 2.5 秒节流，刚加进去的那几首
  // 可能还没落盘，照存档存就会少几首。屏幕空着时才用存档（那正是下次启动会恢复回来的东西）。
  var live = dangerArchiveLiveSnapshotPayload();
  if (live) playbackRaw = JSON.stringify(live);
  var listenRaw = null;
  try { listenRaw = localStorage.getItem(dangerArchiveKey('stats')); } catch (e) { }
  if (searchRaw && dangerArchiveSearchCount(searchRaw) > 0) state[dangerArchiveKey('search')] = searchRaw;
  if (playbackRaw && dangerArchiveQueueLengthOf(playbackRaw) > 0) state[dangerArchiveKey('playback')] = playbackRaw;
  if (listenRaw && dangerArchiveListenCount(listenRaw) > 0) state[dangerArchiveKey('stats')] = listenRaw;
  return state;
}

// 聆听统计里"听过"的证据有三处：history（首页两张卡的来源）、songs / artists（按歌按歌手的
// 累计次数与时长）。只要任一非空就算有内容 —— 光看 history 会漏掉"只累计没进历史"的情况。
function dangerArchiveListenCount(raw) {
  var data = dangerArchiveParseRaw(raw);
  if (!data) return 0;
  var history = Array.isArray(data.history) ? data.history.length : 0;
  var songs = data.songs && typeof data.songs === 'object' ? Object.keys(data.songs).length : 0;
  var artists = data.artists && typeof data.artists === 'object' ? Object.keys(data.artists).length : 0;
  return history + songs + artists;
}

function dangerArchiveListenMinutes(raw) {
  var data = dangerArchiveParseRaw(raw);
  if (!data || !Array.isArray(data.history)) return 0;
  var ms = data.history.reduce(function (sum, item) {
    return sum + (Number(item && (item.listenMs || item.durationMs)) || 0);
  }, 0);
  return Math.round(ms / 60000);
}

function dangerArchiveSearchCount(raw) {
  var data = dangerArchiveParseRaw(raw);
  if (!data) return 0;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data)) return data.length;
  return 0;
}

function dangerArchiveQueueLengthOf(raw) {
  var data = dangerArchiveParseRaw(raw);
  if (!data) return 0;
  var queue = Array.isArray(data.queue) ? data.queue : [];
  return queue.length || (data.current ? 1 : 0);
}

function dangerArchiveSummarize(state) {
  var playback = dangerArchiveParseRaw(state && state[dangerArchiveKey('playback')]);
  var current = (playback && playback.current) || {};
  var listenRaw = state && state[dangerArchiveKey('stats')];
  var listen = dangerArchiveParseRaw(listenRaw);
  return {
    searchItems: dangerArchiveSearchCount(state && state[dangerArchiveKey('search')]),
    queueLength: dangerArchiveQueueLengthOf(state && state[dangerArchiveKey('playback')]),
    listenRecords: Array.isArray(listen && listen.history) ? listen.history.length : 0,
    listenMinutes: dangerArchiveListenMinutes(listenRaw),
    currentName: String(current.name || current.title || '').slice(0, 80),
    currentArtist: String(current.artist || '').slice(0, 80),
    queueChangedAt: Number(playback && playback.queueChangedAt) || 0,
    snapshotSavedAt: Number(playback && playback.savedAt) || 0,
  };
}

function dangerArchiveStateHasContent(state) {
  var s = dangerArchiveSummarize(state);
  return s.searchItems > 0 || s.queueLength > 0 || s.listenRecords > 0;
}

function dangerArchiveBuildRecord(kind, state) {
  var createdAt = Date.now();
  var normalized = kind === 'pre-restore' || kind === 'manual' ? kind : 'clear';
  return {
    id: 'archive-' + createdAt + '-' + Math.floor(Math.random() * 46656).toString(36),
    createdAt: createdAt,
    kind: normalized,
    reason: normalized === 'pre-restore' ? 'restore-undo-point' : normalized === 'manual' ? 'manual-snapshot' : 'manual-clear',
    summary: dangerArchiveSummarize(state),
    state: state,
  };
}

// ---------- 时间显示（这台机器系统时区是太平洋，用户要的是中国墙钟，跟当初 22:30 一个口径） ----------

function dangerArchiveFormatClock(ms) {
  var stamp = Number(ms) || 0;
  if (!stamp) return '时间未知';
  var date = new Date(stamp);
  var parts = null;
  try {
    parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: DANGER_ARCHIVE_TIMEZONE, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date);
  } catch (e) { parts = null; }
  var map = {};
  if (parts) parts.forEach(function (p) { map[p.type] = p.value; });
  if (!map.year) return date.toLocaleString();
  var hour = map.hour === '24' ? '00' : map.hour;
  return map.year + '-' + map.month + '-' + map.day + ' ' + hour + ':' + map.minute;
}

// ---------- 通用的小工具：状态行、待办提示 ----------

function dangerArchiveSetStatus(message, tone) {
  var status = document.getElementById('danger-archive-status');
  if (!status) return;
  status.textContent = String(message || '');
  status.classList.toggle('is-error', tone === 'error');
  status.classList.toggle('is-ok', tone === 'ok');
}

function dangerArchiveToast(message) {
  try { if (typeof showToast === 'function') showToast(String(message || '')); } catch (e) { }
}

// ---------- 改名：一行只有一个编辑框，回车保存 / Esc 取消 ----------

function dangerArchiveToken(kind, token) {
  return String(kind) + ':' + String(token);
}

function dangerArchiveIsEditing(kind, token) {
  return !!(dangerArchiveEditing && dangerArchiveEditing.kind === String(kind)
    && String(dangerArchiveEditing.token) === String(token));
}

// 三行提示各说各的：搜索词改名会走去重与 10 条上限，聆听记录只改这一行显示的名字
// （累计统计不动），存档的 label 更不碰恢复内容。写一句通用的会把后两件事说错。
var DANGER_ARCHIVE_EDIT_HINTS = {
  search: '改名字：回车保存，Esc 取消。（搜索记录重名会合并，上限 10 条）',
  listen: '改名字：回车保存，Esc 取消。（只改这条历史行显示的名字，累计统计不动）',
  archive: '给这条存档起个名字：回车保存，Esc 取消。（只改标注，恢复的内容一个字都不动）',
};

// 输入框的 value 不能拼进 HTML（escHtml 不转义引号），所以这里给一个空 value，
// 渲染完再用 focusDangerArchiveRenameInput 把原值用 DOM 属性塞进去。
function dangerArchiveEditRowMarkup(kind, token) {
  return '<div class="danger-archive-item-wrap is-editing">'
    + '<input class="danger-archive-input danger-archive-rename-input" type="text" autocomplete="off" spellcheck="false"'
    + ' data-danger-archive-rename-input="1" value="" placeholder="新名字">'
    + '<button class="danger-archive-save" type="button" data-danger-archive-save="'
    + escHtml(dangerArchiveToken(kind, token)) + '">保存</button>'
    + '<button class="danger-archive-del-cancel" type="button" data-danger-archive-cancel-edit="1">取消</button>'
    + '</div>';
}

function dangerArchiveStartEdit(kind, token, value) {
  dangerArchiveEditing = { kind: String(kind), token: String(token), value: String(value == null ? '' : value) };
  dangerArchiveRenderCurrentPage();
  dangerArchiveFocusRenameInput();
  dangerArchiveSetStatus(DANGER_ARCHIVE_EDIT_HINTS[String(kind)] || DANGER_ARCHIVE_EDIT_HINTS.archive, '');
}

function dangerArchiveCancelEdit() {
  if (!dangerArchiveEditing) return false;
  dangerArchiveEditing = null;
  dangerArchiveRenderCurrentPage();
  dangerArchiveSetStatus('', '');
  return true;
}

function dangerArchiveFocusRenameInput() {
  try {
    var input = document.querySelector('#' + DANGER_ARCHIVE_MODAL_ID + ' [data-danger-archive-rename-input]');
    if (!input) return false;
    input.value = dangerArchiveEditing && dangerArchiveEditing.value != null ? dangerArchiveEditing.value : '';
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { } }, 30);
    return true;
  } catch (e) { return false; }
}

function dangerArchiveRenameToken(tokenText) {
  var raw = String(tokenText || '');
  var split = raw.indexOf(':');
  if (split < 0) return { kind: '', token: '' };
  return { kind: raw.slice(0, split), token: raw.slice(split + 1) };
}

// 保存分三条路：搜索词改字符串本身；聆听记录只改这一行的 name（歌手、时长、来源不动，
// 累计统计也不动）；存档改的是这条快照的 label。
function dangerArchiveSaveEdit() {
  if (!dangerArchiveEditing) return { ok: false, error: 'NOT_EDITING' };
  var input = document.querySelector('#' + DANGER_ARCHIVE_MODAL_ID + ' [data-danger-archive-rename-input]');
  var text = String(input && input.value != null ? input.value : '').trim();
  var kind = dangerArchiveEditing.kind;
  var token = dangerArchiveEditing.token;
  if (!text) {
    dangerArchiveSetStatus('名字不能为空 —— 想删掉这一条就走行尾的「删除」。', 'error');
    dangerArchiveFocusRenameInput();
    return { ok: false, error: 'EMPTY' };
  }
  if (kind === 'search') return dangerArchiveCommitSearchRename(Number(token), text);
  if (kind === 'listen') return dangerArchiveCommitListenRename(Number(token), text);
  if (kind === 'archive') {
    dangerArchiveSetLabel(token, text).then(function (res) {
      if (!res || res.ok !== true) {
        dangerArchiveSetStatus('存档改名失败：' + ((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误'), 'error');
        return;
      }
      dangerArchiveEditing = null;
      dangerArchiveRenderList(res);
      dangerArchiveSetStatus('这条存档有了名字：「' + text + '」', 'ok');
    });
    return { ok: true, pending: true };
  }
  return { ok: false, error: 'UNKNOWN_KIND' };
}

function dangerArchiveCommitSearchRename(index, text) {
  var items = dangerArchiveReadSearchItems();
  if (!(index >= 0 && index < items.length)) {
    dangerArchiveSetStatus('这条搜索记录已经不在了（列表变过），重新打开面板看一眼。', 'error');
    dangerArchiveEditing = null;
    dangerArchiveRenderCurrentPage();
    return { ok: false, error: 'NOT_FOUND' };
  }
  items[index] = text;
  if (!dangerArchiveWriteSearchItems(items)) {
    dangerArchiveSetStatus('搜索记录改不了：localStorage 写失败（浏览器可能禁了存储）。', 'error');
    return { ok: false, error: 'WRITE_FAILED' };
  }
  dangerArchiveEditing = null;
  dangerArchiveAfterSearchChange();
  dangerArchiveRenderCurrentPage();
  dangerArchiveSetStatus('搜索记录改名：「' + items[index] + '」', 'ok');
  return { ok: true, kind: 'search', value: text };
}

function dangerArchiveCommitListenRename(index, text) {
  var rows = dangerArchiveReadListenRows();
  if (!(index >= 0 && index < rows.length)) {
    dangerArchiveSetStatus('这条聆听记录已经不在了（刚又播了新的歌，列表重排了）。', 'error');
    dangerArchiveEditing = null;
    dangerArchiveRenderCurrentPage();
    return { ok: false, error: 'NOT_FOUND' };
  }
  rows[index] = Object.assign({}, rows[index], { name: text });
  if (!dangerArchiveWriteListenHistory(rows)) {
    dangerArchiveSetStatus('聆听记录改不了：写回失败。', 'error');
    return { ok: false, error: 'WRITE_FAILED' };
  }
  dangerArchiveEditing = null;
  dangerArchiveAfterListenChange();
  dangerArchiveRenderCurrentPage();
  dangerArchiveSetStatus('聆听记录改名（只显示的名字，累计统计不动）：「' + text + '」', 'ok');
  return { ok: true, kind: 'listen', value: text };
}

// ---------- 逐条删除（存档仍要两步确认：一份存档就是整份备份） ----------

function dangerArchiveDeleteHistoryItem(kind, token) {
  var index = Number(token);
  if (kind === 'search') {
    var items = dangerArchiveReadSearchItems();
    if (!(index >= 0 && index < items.length)) return { ok: false, error: 'NOT_FOUND' };
    var removedQuery = items[index];
    items.splice(index, 1);
    if (!dangerArchiveWriteSearchItems(items)) return { ok: false, error: 'WRITE_FAILED' };
    if (dangerArchiveIsEditing('search', token)) dangerArchiveEditing = null;
    dangerArchiveAfterSearchChange();
    dangerArchiveRenderCurrentPage();
    dangerArchiveSetStatus('删掉了一条搜索记录：「' + removedQuery + '」', 'ok');
    return { ok: true, kind: 'search', remaining: items.length };
  }
  if (kind === 'listen') {
    var rows = dangerArchiveReadListenRows();
    if (!(index >= 0 && index < rows.length)) return { ok: false, error: 'NOT_FOUND' };
    var row = rows[index] || {};
    var removedName = String(row.name || '未知歌曲');
    rows.splice(index, 1);
    if (!dangerArchiveWriteListenHistory(rows)) return { ok: false, error: 'WRITE_FAILED' };
    if (dangerArchiveIsEditing('listen', token)) dangerArchiveEditing = null;
    dangerArchiveAfterListenChange();
    dangerArchiveRenderCurrentPage();
    dangerArchiveSetStatus('删掉了一条聆听记录：「' + removedName + '」（累计统计没动）', 'ok');
    return { ok: true, kind: 'listen', remaining: rows.length };
  }
  return { ok: false, error: 'UNKNOWN_KIND' };
}

// ---------- 存档页：列表渲染 ----------

var DANGER_ARCHIVE_KIND_LABELS = { manual: '手动', 'pre-restore': '恢复前', clear: '清空前' };

function dangerArchiveKindLabel(kind) {
  return DANGER_ARCHIVE_KIND_LABELS[kind === 'pre-restore' || kind === 'manual' ? kind : 'clear'] || '清空前';
}

function dangerArchiveItemMarkup(record, index) {
  var summary = (record && record.summary) || {};
  var kindLabel = dangerArchiveKindLabel(record && record.kind);
  var listLabel = Number(summary.queueLength) > 0
    ? ('队列 ' + summary.queueLength + ' 首')
    : '队列空';
  var historyLabel = Number(summary.searchItems) > 0
    ? ('搜索 ' + summary.searchItems + ' 条')
    : '无搜索';
  var listenLabel = Number(summary.listenRecords) > 0
    ? ('聆听 ' + summary.listenRecords + ' 条' + (summary.listenMinutes ? '·' + summary.listenMinutes + ' 分' : ''))
    : '无聆听';
  var nowLabel = Number(summary.queueChangedAt) || Number(summary.snapshotSavedAt) || Number(record && record.createdAt) || 0;
  var id = String((record && record.id) || ('archive-' + index)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  var kind = record && (record.kind === 'pre-restore' || record.kind === 'manual') ? record.kind : 'clear';
  var label = String((record && record.label) || '').trim();
  var songLabel = summary.currentName
    ? ('正在播：' + summary.currentName + (summary.currentArtist ? ' — ' + summary.currentArtist : ''))
    : '没有正在播的曲目';
  // 正在改这一条的名字时，整行换成一个输入框。
  if (dangerArchiveIsEditing('archive', id)) return dangerArchiveEditRowMarkup('archive', id);
  // kind 同时进 data 属性（样式按它分色）和文本（读屏能念出来）。
  // 「改名」「删除」做成行的兄弟节点而不是行内子节点：整行本身是个 <button>，
  // 按钮里再套按钮是非法 HTML，而且点删除会被行的委托当成"恢复"。
  var del = dangerArchiveDeleteMarkup(id);
  return '<div class="danger-archive-item-wrap">'
    + '<button class="danger-archive-item" type="button" data-danger-archive-id="' + escHtml(id)
    + '" data-danger-archive-kind="' + escHtml(kind) + '">'
    + '<span class="danger-archive-item-kind">' + escHtml(kindLabel) + '</span>'
    + '<span class="danger-archive-item-time">' + escHtml(dangerArchiveFormatClock(nowLabel)) + '</span>'
    + '<span class="danger-archive-item-main">' + escHtml(listLabel + ' · ' + historyLabel + ' · ' + listenLabel) + '</span>'
    + '<span class="danger-archive-item-song">' + escHtml((label ? '「' + label + '」 ' : '') + songLabel) + '</span>'
    + '</button>'
    + '<button class="danger-archive-rename" type="button" data-danger-archive-rename="' + escHtml(dangerArchiveToken('archive', id))
    + '" title="给这条存档起个名字">改名</button>' + del + '</div>';
}

// 删除要两步：先点「删除」，这一条变成「确认删除 / 取消」，再点确认才真删。
// 存档是唯一一份备份，一抖手就没了，所以不给"一次点击即删除"的入口。
function dangerArchiveDeleteMarkup(id) {
  if (dangerArchivePendingDeleteId && dangerArchivePendingDeleteId === id) {
    return '<button class="danger-archive-del is-confirm" type="button" data-danger-archive-del-confirm="'
      + escHtml(id) + '" title="真的删掉这份存档，不可恢复">确认删除</button>'
      + '<button class="danger-archive-del-cancel" type="button" data-danger-archive-del-cancel="'
      + escHtml(id) + '" title="不删了">取消</button>';
  }
  return '<button class="danger-archive-del" type="button" data-danger-archive-del="' + escHtml(id)
    + '" title="删掉这份存档（下一步要点确认）">删除</button>';
}

function dangerArchiveRenderList(res) {
  var list = document.getElementById('danger-archive-list');
  var count = document.getElementById('danger-archive-count');
  var note = document.getElementById('danger-archive-note-archive');
  if (!list) return;
  if (!res || res.ok !== true) {
    dangerArchiveLastList = [];
    list.innerHTML = '<div class="danger-archive-empty">存档读不出来：'
      + escHtml((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误')
      + '。</div>';
    if (count) count.textContent = '';
    var broken = document.querySelector('#danger-archive-modal .danger-archive-snapshot');
    if (broken) broken.setAttribute('disabled', 'disabled');
    return;
  }
  var archives = Array.isArray(res.archives) ? res.archives : [];
  dangerArchiveLastList = archives;
  // 待确认的那条已经不在列表里了（被删了/文件被外部改过），别把确认态留在界面上
  if (dangerArchivePendingDeleteId && !archives.some(function (item) {
    return String(item && item.id) === dangerArchivePendingDeleteId;
  })) dangerArchivePendingDeleteId = '';
  if (dangerArchiveEditing && dangerArchiveEditing.kind === 'archive' && !archives.some(function (item) {
    return String(item && item.id) === dangerArchiveEditing.token;
  })) dangerArchiveEditing = null;
  var snapshotBtn = document.querySelector('#danger-archive-modal .danger-archive-snapshot');
  if (snapshotBtn) snapshotBtn.removeAttribute('disabled');
  if (count) count.textContent = archives.length ? ('共 ' + archives.length + ' 份 · 最多留 20 份') : '';
  list.innerHTML = archives.length
    ? archives.map(dangerArchiveItemMarkup).join('')
    : '<div class="danger-archive-empty">还没有存档。按上面的「存一份当前状态」存一次，此刻的搜索记录、播放队列与聆听统计就会存进这里。</div>';
  if (note) {
    note.textContent = dangerArchiveIsDesktopBridge()
      ? '存档保存在 Mineradio 的用户数据目录（mineradio-danger-archive.json），清缓存和换缓存目录都不会带走它。'
      : '当前是浏览器预览，存档只能落在 localStorage，清缓存会一起没。';
  }
}

function dangerArchiveRefreshList() {
  return dangerArchiveReadList().then(dangerArchiveRenderList);
}

// 第一步：只把这条标成"待确认"，不碰数据。
function requestDangerArchiveDelete(id) {
  var clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!clean) return false;
  dangerArchivePendingDeleteId = dangerArchivePendingDeleteId === clean ? '' : clean;
  dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
  return true;
}

// 第二步：真删。删完重新拉一次列表（主进程是唯一真相，不在本地猜剩余条目）。
function confirmDangerArchiveDelete(id) {
  var clean = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!clean || dangerArchiveBusy) return Promise.resolve({ ok: false, error: 'BUSY' });
  var target = (dangerArchiveLastList || []).filter(function (item) {
    return String(item && item.id) === clean;
  })[0];
  dangerArchivePendingDeleteId = '';
  dangerArchiveBusy = true;
  return dangerArchiveRemoveRecord(clean).then(function (res) {
    if (!res || res.ok !== true) {
      dangerArchiveSetStatus('存档删除失败：' + ((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误'), 'error');
      dangerArchiveToast('存档删除失败：' + ((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误'));
      return dangerArchiveRefreshList().then(function () {
        return { ok: false, error: (res && res.error) || 'REMOVE_FAILED' };
      });
    }
    dangerArchiveRenderList(res);
    var s = (target && target.summary) || {};
    var message = '已删除这份存档（' + (s.queueLength || 0) + ' 首 · ' + (s.searchItems || 0) + ' 条搜索记录 · '
      + (s.listenRecords || 0) + ' 条聆听记录），剩下 ' + (res.archives || []).length + ' 份';
    dangerArchiveSetStatus(message, 'ok');
    dangerArchiveToast(message);
    return { ok: true, id: clean, remaining: (res.archives || []).length };
  }).catch(function (e) {
    dangerArchiveSetStatus('存档删除失败：' + String((e && e.message) || e), 'error');
    dangerArchiveToast('存档删除失败：' + String((e && e.message) || e));
    return { ok: false, error: 'THROW', detail: String((e && e.message) || e) };
  }).then(function (out) {
    dangerArchiveBusy = false;
    return out;
  });
}

// ---------- 历史页：搜索记录 + 聆听记录 ----------

function dangerArchiveSearchRowMarkup(item, index) {
  var value = String(item == null ? '' : item);
  if (dangerArchiveIsEditing('search', index)) return dangerArchiveEditRowMarkup('search', index);
  return '<div class="danger-archive-item-wrap">'
    + '<button class="danger-archive-item is-text" type="button" title="点一下改名字"'
    + ' data-danger-archive-rename="' + escHtml(dangerArchiveToken('search', index)) + '">'
    + '<span class="danger-archive-item-text">' + escHtml(value) + '</span>'
    + '</button>'
    + '<button class="danger-archive-del" type="button" data-danger-archive-history-del="'
    + escHtml(dangerArchiveToken('search', index)) + '" title="删掉这条搜索记录">删除</button>'
    + '</div>';
}

function dangerArchiveListenRowMarkup(record, index) {
  var rec = record || {};
  var name = String(rec.name || '未知歌曲');
  if (dangerArchiveIsEditing('listen', index)) return dangerArchiveEditRowMarkup('listen', index);
  var bits = [];
  if (rec.artist) bits.push(String(rec.artist));
  var minutes = Math.round((Number(rec.listenMs) || 0) / 60000);
  bits.push(minutes > 0 ? (minutes + ' 分钟') : '不足 1 分钟');
  var source = String(rec.source || rec.provider || '');
  if (source) bits.push(source);
  return '<div class="danger-archive-item-wrap">'
    + '<button class="danger-archive-item is-text" type="button" title="点一下改名字"'
    + ' data-danger-archive-rename="' + escHtml(dangerArchiveToken('listen', index)) + '">'
    + '<span class="danger-archive-item-time">' + escHtml(dangerArchiveFormatClock(rec.playedAt)) + '</span>'
    + '<span class="danger-archive-item-text">' + escHtml(name) + '</span>'
    + '<span class="danger-archive-item-main">' + escHtml(bits.join(' · ')) + '</span>'
    + '</button>'
    + '<button class="danger-archive-del" type="button" data-danger-archive-history-del="'
    + escHtml(dangerArchiveToken('listen', index)) + '" title="删掉这条聆听记录（累计统计不动）">删除</button>'
    + '</div>';
}

function dangerArchiveRenderHistoryPage() {
  var searchList = document.getElementById('danger-archive-search-list');
  var listenList = document.getElementById('danger-archive-listen-list');
  var searchCount = document.getElementById('danger-archive-search-count');
  var listenCount = document.getElementById('danger-archive-listen-count');
  var note = document.getElementById('danger-archive-note-history');
  var searches = dangerArchiveReadSearchItems();
  var listens = dangerArchiveReadListenRows();
  if (searchList) {
    searchList.innerHTML = searches.length
      ? searches.map(dangerArchiveSearchRowMarkup).join('')
      : '<div class="danger-archive-empty">搜索记录是空的（搜一次歌就有了）。</div>';
  }
  if (searchCount) searchCount.textContent = searches.length ? ('共 ' + searches.length + ' 条 · 最多留 10 条') : '';
  if (listenList) {
    listenList.innerHTML = listens.length
      ? listens.map(dangerArchiveListenRowMarkup).join('')
      : '<div class="danger-archive-empty">还没有聆听记录。</div>';
  }
  if (listenCount) listenCount.textContent = listens.length ? ('共 ' + listens.length + ' 条 · 最多留 180 条') : '';
  if (note) {
    note.textContent = '删除只影响你点的那一条：搜索记录删了就没了，聆听记录删掉的是历史那一行，'
      + '按歌手的累计次数与时长（首页"最常听"那些卡）不动。这里没有"一把清空"。';
  }
}

function dangerArchiveRenderCurrentPage() {
  if (dangerArchiveTab === 'archive') dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
  else dangerArchiveRenderHistoryPage();
}

// ---------- 页签 ----------

function dangerArchiveSetTab(tab) {
  var next = tab === 'archive' ? 'archive' : 'history';
  var modal = dangerArchiveModal();
  dangerArchiveTab = next;
  // 换页签就把改名框收掉：改名那一行属于上一页，留着它下一次保存会写错地方
  dangerArchiveEditing = null;
  if (modal) {
    modal.classList.toggle('page-archive', next === 'archive');
    modal.classList.toggle('page-history', next !== 'archive');
    var tabs = modal.querySelectorAll('.danger-archive-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-danger-archive-tab') === next;
      tabs[i].classList.toggle('is-active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  if (next === 'archive') dangerArchiveRefreshList();
  else { dangerArchiveEditing = null; dangerArchiveRenderHistoryPage(); }
  return next;
}

// ---------- 开关门（现在没有门了，开的就是面板） ----------

function openDangerArchivePanel() {
  // 装载期那次注入可能赶在 body 与那排按钮解析完之前（模块是同步拼进一个 script 的），这里补一次
  dangerArchiveEnsureMounted();
  var modal = dangerArchiveModal();
  if (!modal) return;
  // 沉浸模式会把所有 .modal-mask 直接 display:none（index.css 里那条规则），
  // 那时按 Ctrl+H 会"什么也没发生"，所以先把沉浸关掉
  if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') {
    setImmersiveMode(false);
  }
  dangerArchivePendingDeleteId = '';
  dangerArchiveEditing = null;
  dangerArchiveSetStatus('', '');
  modal.classList.add('show');
  modal.classList.toggle('page-archive', dangerArchiveTab === 'archive');
  modal.classList.toggle('page-history', dangerArchiveTab !== 'archive');
  modal.setAttribute('aria-hidden', 'false');
  var entryBtn = document.getElementById(DANGER_ARCHIVE_BUTTON_ID);
  if (entryBtn) entryBtn.setAttribute('aria-expanded', 'true');
  var tabs = modal.querySelectorAll('.danger-archive-tab');
  for (var i = 0; i < tabs.length; i++) {
    var on = tabs[i].getAttribute('data-danger-archive-tab') === dangerArchiveTab;
    tabs[i].classList.toggle('is-active', on);
    tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (dangerArchiveTab === 'archive') dangerArchiveRefreshList();
  else dangerArchiveRenderHistoryPage();
}

function closeDangerArchiveModal() {
  var modal = dangerArchiveModal();
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  dangerArchivePendingDeleteId = '';
  dangerArchiveEditing = null;
  dangerArchiveSetStatus('', '');
  var entryBtn = document.getElementById(DANGER_ARCHIVE_BUTTON_ID);
  if (entryBtn) entryBtn.setAttribute('aria-expanded', 'false');
}

function toggleDangerArchivePanel() {
  if (dangerArchiveModalOpen()) closeDangerArchiveModal();
  else openDangerArchivePanel();
  return dangerArchiveModalOpen();
}

function dangerArchiveModalOpen() {
  var modal = dangerArchiveModal();
  return !!(modal && modal.classList.contains('show'));
}

// ---------- 存一份当前状态 ----------

// 这版唯一产生存档的入口（原先挂在「一键清空」那一步之前）。只 capture + append，
// 什么都不清，所以不需要"先存成功才允许清"那道保险。
function runDangerArchiveSnapshot() {
  if (dangerArchiveBusy) return Promise.resolve({ ok: false, error: 'BUSY' });
  var state = dangerArchiveCaptureState();
  if (!dangerArchiveStateHasContent(state)) {
    dangerArchiveSetStatus('现在没东西可存：搜索记录、播放列表、聆听统计都是空的。', 'error');
    dangerArchiveToast('现在没东西可存（搜索记录、播放列表与聆听统计都是空的）');
    return Promise.resolve({ ok: false, error: 'NOTHING_TO_STORE' });
  }
  dangerArchiveBusy = true;
  var record = dangerArchiveBuildRecord('manual', state);
  return dangerArchiveAppendRecord(record).then(function (res) {
    if (!res || res.ok !== true) {
      var reason = (res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误';
      dangerArchiveSetStatus('没存下来：' + reason, 'error');
      dangerArchiveToast('存档失败：' + reason);
      return { ok: false, error: (res && res.error) || 'ARCHIVE_FAILED', archived: false };
    }
    dangerArchiveRenderList(res);
    var message = '存好了：' + record.summary.queueLength + ' 首 · ' + record.summary.searchItems
      + ' 条搜索记录 · ' + record.summary.listenRecords + ' 条聆听记录（什么都没清）';
    dangerArchiveSetStatus(message, 'ok');
    dangerArchiveToast(message);
    if (res.dropped && res.dropped.length) {
      dangerArchiveToast('超过 20 份，最旧的 ' + res.dropped.length + ' 份被挤掉了');
    }
    return { ok: true, archived: true, id: record.id };
  }).catch(function (e) {
    dangerArchiveSetStatus('存档失败：' + String((e && e.message) || e), 'error');
    return { ok: false, error: 'THROW', detail: String((e && e.message) || e) };
  }).then(function (out) {
    dangerArchiveBusy = false;
    return out;
  });
}

// ---------- 恢复 ----------

// 搜索记录：原样写回（没有就把键删掉，回到"从没搜过"的样子）
function dangerArchiveApplySearchHistory(raw) {
  try {
    if (raw) localStorage.setItem(dangerArchiveKey('search'), raw);
    else localStorage.removeItem(dangerArchiveKey('search'));
  } catch (e) { }
  var surface = typeof $results !== 'undefined' && $results && $results.classList
    && $results.classList.contains('search-history-surface');
  if (surface && typeof renderSearchHistory === 'function') renderSearchHistory();
}

// 队列没有存档可用时（存档里没 current，restoreLastPlaybackSnapshot 会拒绝）的手动重建
function dangerArchiveApplyPlaybackManually(raw) {
  var data = dangerArchiveParseRaw(raw);
  if (!data) return false;
  var queue = Array.isArray(data.queue)
    ? data.queue.map(function (song) { return hydrateCustomCover(Object.assign({}, song)); })
      .filter(function (song) { return song && (song.id || song.mid || song.localKey || song.name); })
    : [];
  if (!queue.length) return false;
  playQueue = queue;
  currentIdx = Math.max(0, Math.min(queue.length - 1, Number(data.currentIdx) || 0));
  currentLocalSong = null;
  if (typeof pendingPlaybackResumeAt !== 'undefined') {
    pendingPlaybackResumeAt = Math.max(0, Number(data.currentTime) || 0);
  }
  var shown = typeof currentCoverSong === 'function' ? currentCoverSong() : queue[currentIdx];
  if (shown && typeof updateControlTrackInfo === 'function') updateControlTrackInfo(shown);
  if (typeof showRestoredPlaybackControls === 'function') showRestoredPlaybackControls('restore');
  return true;
}

function dangerArchiveApplyPlayback(raw) {
  try {
    if (raw) localStorage.setItem(dangerArchiveKey('playback'), raw);
    else localStorage.removeItem(dangerArchiveKey('playback'));
  } catch (e) { }
  if (!raw) return false;
  // 让启动恢复那条路重新可用：它自己有个"只恢复一次"的闩
  try { restoredLastPlaybackSnapshot = null; } catch (e) { }
  if (typeof restoreLastPlaybackSnapshot === 'function' && restoreLastPlaybackSnapshot()) return true;
  return dangerArchiveApplyPlaybackManually(raw);
}

// 聆听统计要连内存一起回滚：只写 localStorage 的话，常驻的 listenStatsState 还是空的，
// 下一次 tick 就把刚恢复回来的记录又覆盖掉。
function dangerArchiveApplyListenStats(raw) {
  try {
    if (raw) localStorage.setItem(dangerArchiveKey('stats'), raw);
    else localStorage.removeItem(dangerArchiveKey('stats'));
  } catch (e) { }
  try {
    listenStatsState = typeof loadListenStatsState === 'function'
      ? loadListenStatsState()
      : { history: [], songs: {}, artists: {}, updatedAt: 0 };
  } catch (e) { }
}

function dangerArchiveApplyState(state) {
  var snapshot = state || {};
  // 正在出声的那首要先停下：不然列表换成存档那份、耳朵里还是刚才那首
  try {
    if (typeof audio !== 'undefined' && audio && !audio.paused) audio.pause();
  } catch (e) { }
  dangerArchiveClearEverything();
  dangerArchiveApplySearchHistory(snapshot[dangerArchiveKey('search')] || '');
  dangerArchiveApplyListenStats(snapshot[dangerArchiveKey('stats')] || '');
  var playbackApplied = dangerArchiveApplyPlayback(snapshot[dangerArchiveKey('playback')] || '');
  if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('danger-archive-restore', { scrollCurrent: true });
  if (typeof safeShelfRebuild === 'function') safeShelfRebuild('danger-archive-restore', true);
  // 首页两张卡要按恢复回来的聆听统计重画，否则卡片还停在"清空后"的样子
  try { if (typeof renderHomeDashboardQuickCards === 'function') renderHomeDashboardQuickCards(); } catch (e) { }
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
  return { playbackApplied: playbackApplied };
}

function restoreDangerArchive(id) {
  if (dangerArchiveBusy) return Promise.resolve({ ok: false, error: 'BUSY' });
  var target = (dangerArchiveLastList || []).filter(function (item) {
    return String(item && item.id) === String(id);
  })[0];
  if (!target || !target.state) return Promise.resolve({ ok: false, error: 'NOT_FOUND' });
  var before = dangerArchiveCaptureState();
  dangerArchiveBusy = true;
  // 恢复本身也是一次覆盖现场，所以先存一份"恢复前"，点错了能退回来
  var step = dangerArchiveStateHasContent(before)
    ? dangerArchiveAppendRecord(dangerArchiveBuildRecord('pre-restore', before))
    : Promise.resolve({ ok: true, skipUndoPoint: true });
  return step.then(function (res) {
    if (!res || res.ok !== true) {
      dangerArchiveSetStatus('存档失败，已取消恢复：' + ((res && res.error) || '未知错误'), 'error');
      dangerArchiveToast('存档失败，已取消恢复：' + ((res && res.error) || '未知错误'));
      return { ok: false, error: (res && res.error) || 'ARCHIVE_FAILED' };
    }
    var applied = dangerArchiveApplyState(target.state);
    var s = target.summary || {};
    dangerArchiveToast('已恢复到 ' + dangerArchiveFormatClock(s.queueChangedAt || s.snapshotSavedAt || target.createdAt)
      + ' 的状态（' + (s.queueLength || 0) + ' 首 · ' + (s.searchItems || 0) + ' 条搜索记录 · '
      + (s.listenRecords || 0) + ' 条聆听记录）'
      + (applied.playbackApplied ? '' : ' · 队列已恢复，等下次播放数据能取到'));
    closeDangerArchiveModal();
    return dangerArchiveRefreshList().then(function () {
      return { ok: true, id: target.id, playbackApplied: applied.playbackApplied };
    });
  }).catch(function (e) {
    dangerArchiveSetStatus('恢复失败：' + String((e && e.message) || e), 'error');
    dangerArchiveToast('恢复失败：' + String((e && e.message) || e));
    return { ok: false, error: 'THROW', detail: String((e && e.message) || e) };
  }).then(function (out) {
    dangerArchiveBusy = false;
    return out;
  });
}

// ---------- 停播与清场（现在只服务于"恢复一份存档"这一步） ----------

// 停播。顺序很讲究，两步都不能换：
//  1. 先把 listenSession 摘掉。停播会走音频事件链，里面的 finalizeListenSession 会把
//     "刚听完的这一段"写回聆听统计（他刚听了 6 分半，这一下就会又冒出一条最近播放），
//     等于前脚清后脚补。摘掉之后 finalize 第一句 !listenSession 直接 return。
//  2. 再 pause + 清 src + load。这是本仓库换源时已经在用的清场写法。
// 之后 currentCoverSong() 为空，进度 tick 与音频事件那两处 saveLastPlaybackSnapshot
// 都会早退，不会把刚写回的播放存档又盖掉。
function dangerArchiveStopPlayback() {
  try { listenSession = null; } catch (e) { }
  try {
    if (typeof audio !== 'undefined' && audio) {
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) { }
      // load() 之后 Chromium 会把 paused 复位成 false（实测：清完 audio.paused
      // 仍是 false），所以这里必须再 pause 一次，否则"停了没停"这件事没法用 paused 判。
      try { audio.pause(); } catch (e) { }
    }
  } catch (e) { }
  try { playing = false; } catch (e) { }
  try { if (typeof setPlayIcon === 'function') setPlayIcon(false); } catch (e) { }
  try { if (typeof hideLoading === 'function') hideLoading(); } catch (e) { }
  // 播放条与封面缩略图也要归零，否则"还挂着刚才那首"，看着就是没换干净
  dangerArchiveResetControlBar();
  try {
    var thumbWrap = document.getElementById('thumb-wrap');
    if (thumbWrap) thumbWrap.classList.remove('visible');
    var titleEl = document.getElementById('thumb-title');
    var artistEl = document.getElementById('thumb-artist');
    if (titleEl) titleEl.textContent = '';
    if (artistEl) artistEl.textContent = '';
  } catch (e) { }
  try {
    var timeDisplay = document.getElementById('time-display');
    if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    if (typeof setProgressVisual === 'function') setProgressVisual(0);
  } catch (e) { }
}

// 播放条归零。不能只交给 updateControlTrackInfo(null)：它对平台标签的写法是
// "song.name 为空才清空 innerHTML"，而封面 #control-cover 的 backgroundImage 它根本不管
// （那是 setControlCoverSrc 那条路）。所以这里既调 app 自己的函数，也直接写 DOM 兜底。
function dangerArchiveResetControlBar() {
  try { if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(null); } catch (e) { }
  try {
    var cover = document.getElementById('control-cover');
    if (cover) {
      if (typeof setControlCoverSrc === 'function') setControlCoverSrc('');
      else {
        if (cover.style) cover.style.backgroundImage = '';
        cover.classList.add('cover-empty');
      }
    }
  } catch (e) { }
  try {
    var badges = document.getElementById('control-title-badges');
    if (badges) badges.innerHTML = '';
    var titleText = document.getElementById('control-title-text');
    if (titleText) titleText.textContent = '';
    var controlArtist = document.getElementById('control-artist');
    if (controlArtist) controlArtist.textContent = '';
  } catch (e) { }
  // 歌词浮层那张缩略图（#thumb-cover）也一起摘掉，不然下次显示浮层会闪出刚才那首的封面
  try {
    var thumbCover = document.getElementById('thumb-cover');
    if (thumbCover) {
      if (typeof thumbCover.removeAttribute === 'function') thumbCover.removeAttribute('src');
      thumbCover.src = '';
    }
  } catch (e) { }
}

// 异步收尾（音质探测、歌词、换源、首页推荐）会在换完之后再回来写一次播放条，
// 所以补两次归零。判据卡死在"队列确实还是空的、也没有声音"上，
// 不会踩到用户恢复完立刻自己点歌起播的情况。
function dangerArchiveReassertEmptyControlBar(reason) {
  try {
    if (typeof playQueue !== 'undefined' && Array.isArray(playQueue) && playQueue.length) return false;
    if (typeof currentIdx !== 'undefined' && Number(currentIdx) >= 0) return false;
    if (typeof audio !== 'undefined' && audio && audio.src && !audio.paused) return false;
    dangerArchiveResetControlBar();
    return true;
  } catch (e) { return false; }
}

// 聆听统计：光删 localStorage 不够，listenStatsState 是常驻内存的模块变量，
// 下一次 tick / 收尾都会拿它把键写回来。内存与磁盘必须一起归零。
function dangerArchiveWipeListenStats() {
  try {
    listenStatsState = { history: [], songs: {}, artists: {}, updatedAt: Date.now() };
  } catch (e) { }
  try { listenSession = null; } catch (e) { }
  try { localStorage.removeItem(dangerArchiveKey('stats')); } catch (e) { }
}

// 这一步只在"恢复一份存档"前面跑：要把现场换成那一刻，得先把它清干净。
// 界面上没有对应按钮 —— 用户 2026-10-12 明确不要"一键清空"那颗。
function dangerArchiveClearEverything() {
  // 先停播再清：反过来会被 pause 事件链把当前曲目写回存档
  dangerArchiveStopPlayback();
  // 走 app 自己的两个清空函数：它们除了删数据还要重绘队列面板、歌单架和空主页
  if (typeof clearSearchHistory === 'function') clearSearchHistory();
  else {
    try { localStorage.removeItem(dangerArchiveKey('search')); } catch (e) { }
  }
  if (typeof clearQueue === 'function') clearQueue();
  else {
    try { localStorage.removeItem(dangerArchiveKey('playback')); } catch (e) { }
  }
  dangerArchiveWipeListenStats();
  // 首页那两张卡（CONTINUE / RECENT）读的是聆听统计，清完要立刻重画，
  // 否则卡片上还挂着刚才那首，看起来就是没换干净
  try { if (typeof renderHomeDashboardQuickCards === 'function') renderHomeDashboardQuickCards(); } catch (e) { }
  try { if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: true }); } catch (e) { }
  // 清完之后还有异步收尾会回来写播放条（音质探测、歌词、首页推荐、换源），
  // 所以再补两次归零。判据是"队列仍然是空的且没声音"，恢复存档时不会被误踩。
  try {
    if (typeof setTimeout === 'function') {
      setTimeout(function () { dangerArchiveReassertEmptyControlBar('after-restore-380'); }, 380);
      setTimeout(function () { dangerArchiveReassertEmptyControlBar('after-restore-1400'); }, 1400);
    }
  } catch (e) { }
}

// ---------- 入口绑定 ----------

function dangerArchiveHandleHotkey(e) {
  var combo = typeof normalizeHotkeyEvent === 'function' ? normalizeHotkeyEvent(e) : '';
  if (combo !== DANGER_ARCHIVE_HOTKEY) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;
  toggleDangerArchivePanel();
  return true;
}

function dangerArchiveHandleModalKeys(e) {
  if (!dangerArchiveModalOpen()) return false;
  // 有一行正在改名：回车=保存，Esc=只取消这次改名，不要把整个面板关掉
  if (dangerArchiveEditing) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      dangerArchiveSaveEdit();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dangerArchiveCancelEdit();
      return true;
    }
    return false;
  }
  // 没有改名框时回车什么都不做：列表里一行是可点的，手一抖就改了一条或恢复了一份存档
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    // 有待确认的删除时，Esc 先当"取消"：这时关窗会让用户以为"按 Esc 就删了"或"没删成"
    if (dangerArchivePendingDeleteId) {
      dangerArchivePendingDeleteId = '';
      dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
      return true;
    }
    closeDangerArchiveModal();
    return true;
  }
  return false;
}

// 所有行内按钮都走委托：id 与名字来自动画文件和用户输入，拼进 inline onclick 会把
// 它们当成代码执行；这里只认 data-danger-archive-* 这些属性，值本身不参与代码。
// 顺序：改名两步（取消 / 保存）先判，再判页签与"点一行=改名"，最后才轮到存档那三条。
function dangerArchiveHandleClick(event) {
  if (!dangerArchiveModalOpen()) return false;
  var target = event && event.target;
  if (!target || typeof target.closest !== 'function') return false;
  // 两页都留在 DOM 里（靠 display 切显隐），上一页的行其实还在，只是看不见。
  // 这里挡掉不属于当前页签的点击：否则一次 querySelector、一次键盘焦点就能改到用户
  // 根本没看到的那一页 —— 实测自动化脚本点 .danger-archive-item-wrap [data-danger-archive-rename]
  // 会命中隐藏的历史页那三行，把搜索记录改了名，界面却毫无反应（看着像"改名坏了"）。
  var page = target.closest('[data-danger-archive-page]');
  if (page && page.getAttribute('data-danger-archive-page') !== dangerArchiveTab) return false;
  var cancelEdit = target.closest('[data-danger-archive-cancel-edit]');
  if (cancelEdit) {
    event.preventDefault();
    event.stopPropagation();
    dangerArchiveCancelEdit();
    return true;
  }
  var save = target.closest('[data-danger-archive-save]');
  if (save) {
    event.preventDefault();
    event.stopPropagation();
    dangerArchiveSaveEdit();
    return true;
  }
  var tab = target.closest('[data-danger-archive-tab]');
  if (tab) {
    event.preventDefault();
    event.stopPropagation();
    dangerArchiveSetTab(tab.getAttribute('data-danger-archive-tab'));
    return true;
  }
  var historyDel = target.closest('[data-danger-archive-history-del]');
  if (historyDel) {
    event.preventDefault();
    event.stopPropagation();
    var hd = dangerArchiveRenameToken(historyDel.getAttribute('data-danger-archive-history-del'));
    var hdOut = dangerArchiveDeleteHistoryItem(hd.kind, hd.token);
    if (!hdOut || hdOut.ok !== true) {
      dangerArchiveSetStatus('这条删不掉了：' + ((hdOut && hdOut.error) || '未知错误') + '（列表可能刚变过，重新打开面板看一眼）', 'error');
      dangerArchiveRenderCurrentPage();
    }
    return true;
  }
  var rename = target.closest('[data-danger-archive-rename]');
  if (rename) {
    event.preventDefault();
    event.stopPropagation();
    var token = dangerArchiveRenameToken(rename.getAttribute('data-danger-archive-rename'));
    dangerArchiveStartEdit(token.kind, token.token, dangerArchiveEditValueFor(token.kind, token.token));
    return true;
  }
  var delCancel = target.closest('[data-danger-archive-del-cancel]');
  if (delCancel) {
    event.preventDefault();
    event.stopPropagation();
    dangerArchivePendingDeleteId = '';
    dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
    return true;
  }
  var delConfirm = target.closest('[data-danger-archive-del-confirm]');
  if (delConfirm) {
    event.preventDefault();
    event.stopPropagation();
    confirmDangerArchiveDelete(delConfirm.getAttribute('data-danger-archive-del-confirm'));
    return true;
  }
  var del = target.closest('[data-danger-archive-del]');
  if (del) {
    event.preventDefault();
    event.stopPropagation();
    requestDangerArchiveDelete(del.getAttribute('data-danger-archive-del'));
    return true;
  }
  var item = target.closest('[data-danger-archive-id]');
  if (!item) return false;
  event.preventDefault();
  event.stopPropagation();
  restoreDangerArchive(item.getAttribute('data-danger-archive-id'));
  return true;
}

// 改名框的初值：搜索词本身 / 聆听记录的名字 / 存档的 label。
function dangerArchiveEditValueFor(kind, token) {
  if (kind === 'search') {
    var items = dangerArchiveReadSearchItems();
    return String(items[Number(token)] || '');
  }
  if (kind === 'listen') {
    var rows = dangerArchiveReadListenRows();
    var row = rows[Number(token)] || {};
    return String(row.name || '');
  }
  if (kind === 'archive') {
    var found = (dangerArchiveLastList || []).filter(function (item) {
      return String(item && item.id) === String(token);
    })[0];
    return String((found && found.label) || '');
  }
  return '';
}

// 全局快捷键那条链（10-shell/01）第一句就是 `if (isTypingTarget(e.target)) return;`
// —— 走那条路会导致"光标在搜索框或改名输入框里时 Ctrl+H 失灵"。
// 所以这里单独挂一个捕获阶段监听，抢在它前面。
document.addEventListener('keydown', function (e) {
  if (dangerArchiveHandleHotkey(e)) return;
  dangerArchiveHandleModalKeys(e);
}, true);
document.addEventListener('click', function (e) {
  dangerArchiveHandleClick(e);
}, true);

window.toggleDangerArchivePanel = toggleDangerArchivePanel;
window.openDangerArchivePanel = openDangerArchivePanel;
window.closeDangerArchiveModal = closeDangerArchiveModal;
window.runDangerArchiveSnapshot = runDangerArchiveSnapshot;
window.restoreDangerArchive = restoreDangerArchive;
window.requestDangerArchiveDelete = requestDangerArchiveDelete;
window.confirmDangerArchiveDelete = confirmDangerArchiveDelete;
window.dangerArchiveSetLabel = dangerArchiveSetLabel;
window.dangerArchiveSaveEdit = dangerArchiveSaveEdit;
window.dangerArchiveDeleteHistoryItem = dangerArchiveDeleteHistoryItem;
window.dangerArchiveReadSearchItems = dangerArchiveReadSearchItems;
window.dangerArchiveReadListenRows = dangerArchiveReadListenRows;
window.dangerArchiveCaptureState = dangerArchiveCaptureState;
window.dangerArchiveApplyState = dangerArchiveApplyState;

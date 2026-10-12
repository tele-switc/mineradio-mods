// ============================================================
//  Ctrl+H · 一键清空搜索记录与播放列表 + 每次清空前的存档（2026-10-09 加）
//
//  流程（就按用户说的那三步）：
//   1. 按 Ctrl+H → 弹密码框；
//   2. 密码对（默认 mineradio）→ 面板切成「每次清空前的存档」列表，顶部一个一键清空按钮；
//   3. 点任意一条存档 → 整个软件回到那一刻：搜索记录、播放列表、当前曲目、播放位置都换回去。
//
//  三条会咬人的细节：
//   1. **存档必须先写成功才允许清空**。清空是不可逆的，如果落盘失败还是照清，
//      用户就得到一个"以为有备份"的空备份。所以 append 返回非 ok 时直接取消清空并说明原因。
//   2. **存档落在 userData 的 JSON 文件里，不在 localStorage**（落盘逻辑见
//      desktop/danger-archive-store.js）。它备份的正是 localStorage 那两条记录，
//      存在同一个地方等于把钥匙和锁放同一个抽屉；而且清缓存、换缓存目录也会一起带走。
//   3. **捕获的是原始字符串**，恢复时原样写回，不经过"解析—改字段—再序列化"。
//      播放存档里 provider/mid/hash/localKey 那一堆字段，任何一个在我们的往返里被
//      "顺手规范化"，恢复出来的列表就可能点不响。
//
//  清空为什么走 app 自己的两个函数而不是自己删 localStorage：
//   clearSearchHistory() 和 clearQueue() 是用户平时点「清空」走的路径，它们除了删数据
//   还要重绘画廊架、队列面板、空主页。自己删键会得到"数据没了但界面还挂着 23 首"。
//   恢复方向同理，优先复用 restoreLastPlaybackSnapshot()（启动时恢复播放走的就是它），
//   它返回 false（存档里没有 current）时才走本模块的手动重建。
//
//  恢复时不会自动放声：跟软件启动时恢复上次播放的口径一致 —— 列表、当前曲目、进度都摆好，
//   等用户自己按播放。要不要自动播由「启动自动播放」那个开关决定，本模块不替用户改它。
//
//  关于"密码"：这道门防的是误触和旁人随手点，不是安全边界 —— 密码就写在源码里，
//   localStorage 本来也没加密。真要保密得靠系统账户。
//
//  ------------------------------------------------------------
//  mineradio-mods 外挂版与开发版的三处差别（逻辑一个字没改，只是换了挂载点）：
//   1. 开发版的模态框写在 `index.html` 里、样式写在 `index.css` 里 —— 那两个文件上游
//      更新时会被整份换掉，所以这里**运行时注入**：DOM 由本模块拼（dangerArchiveInjectModal），
//      样式由 `css/mods-danger-archive.css` 挂一个 <link>。核过：那 41 行全是独立新增节点，
//      注入与写死在 HTML 里完全等效。
//   2. 那四个存档 IPC 方法在开发版挂在 `desktopWindow` 上；装在**原版**上时上游那个
//      contextBridge 对象里根本没有它们，而且 contextBridge 暴露的对象是冻结的、事后补不进去
//      → 外挂那一份在自己的 `desktopMods` 上（见 blocks/preload-main.js），下面 bridge() 两个都认。
//   3. 落盘的是主进程 `desktop/mods-danger-archive-store.js` 注册的四个通道，
//      写在 userData 目录（不是安装目录），软件更新动不到它。
// ============================================================

// 改密码就改这一行（比较时忽略首尾空格与大小写）
var DANGER_ARCHIVE_PASSWORD = 'mineradio';
var DANGER_ARCHIVE_HOTKEY = 'Ctrl+KeyH';
var DANGER_ARCHIVE_MODAL_ID = 'danger-archive-modal';
// 清空口径（用户 2026-10-10 定）："直接回到从来没听过歌的状态，只不过配置不变"。
// 所以清的是"听过的痕迹"这三样，一个都不少：
//   1. mineradio-search-history   搜索记录
//   2. mineradio-last-playback-v1 播放队列 + 当前曲目 + 进度（下次启动会恢复的就是它）
//   3. mineradio-listen-stats-v1  聆听统计（今日时长/首数、连续天数、首页
//      CONTINUE 与 RECENT 两张卡的来源）
// 自定义封面/歌词/歌词排版、视觉特效存档、音质与输出设备、热键设置、启动偏好、
// 本地曲库与导入的歌、平台登录态 —— 这些是"配置"和他的内容，一律不动。
// 收藏/喜欢也不动：那是平台账号侧的数据，删它等于替他操作账号。
var DANGER_ARCHIVE_CLEARED_KEYS = ['mineradio-search-history', 'mineradio-last-playback-v1', 'mineradio-listen-stats-v1'];
// 没有桌面端 IPC 时（直接在浏览器里跑前端）退到 localStorage，功能可测可看，
// 但要提示用户这份备份会跟着缓存一起没
var DANGER_ARCHIVE_BROWSER_STORE_KEY = 'mineradio-danger-archive-browser-fallback-v1';
var DANGER_ARCHIVE_TIMEZONE = 'Asia/Shanghai';
var dangerArchiveBusy = false;
var dangerArchiveAttempts = 0;
var dangerArchiveLastList = [];
// 正在等"确认删除"的那条存档 id（同一时刻只允许一条处于待确认状态）
var dangerArchivePendingDeleteId = '';

// ---------- 模态框与样式：运行时注入（上游 index.html / index.css 里没有这两处） ----------

// 这一段照开发仓库 index.html 里的那 41 行搬，一个类名一个 id 都没改，
// 所以上面那套 CSS 与内联 onclick 都直接对得上。
var DANGER_ARCHIVE_MODAL_HTML = ''
  + '<div id="danger-archive-modal" class="modal-mask" role="dialog" aria-modal="true" aria-hidden="true">'
  + '  <div class="modal danger-archive-modal">'
  + '    <div class="login-panel-head">'
  + '      <button class="login-panel-close" type="button" onclick="closeDangerArchiveModal()">×</button>'
  + '    </div>'
  + '    <div class="danger-archive-title"><b>清空与存档</b><small>Danger Archive · Ctrl+H</small></div>'
  + '    <div id="danger-archive-gate" class="danger-archive-gate">'
  + '      <input id="danger-archive-password" class="danger-archive-input" type="password" autocomplete="off"'
  + '        spellcheck="false" placeholder="密码">'
  + '      <div id="danger-archive-status" class="danger-archive-status"></div>'
  + '      <div class="btn-row">'
  + '        <button class="modal-btn" type="button" onclick="closeDangerArchiveModal()">取消</button>'
  + '        <button class="modal-btn primary" type="button" onclick="submitDangerArchiveGate()">确认</button>'
  + '      </div>'
  + '    </div>'
  + '    <div id="danger-archive-panel" class="danger-archive-panel">'
  + '      <button class="danger-archive-clear-all" type="button" onclick="runDangerArchiveClearAll()">'
  + '        一键清空搜索记录、播放列表与聆听统计</button>'
  + '      <div class="desc">一键清空会回到"从来没听过歌"的状态：搜索记录、播放列表、聆听统计全部清掉，正在播的歌也会停下。配置（音质、特效、封面歌词、快捷键、登录、本地曲库）不动。下面每一条是清空前的存档，点它可以整个回到那一刻。</div>'
  + '      <div class="danger-archive-list-head">'
  + '        <span>每次清空前的存档</span><small id="danger-archive-count"></small>'
  + '      </div>'
  + '      <div id="danger-archive-list" class="danger-archive-list"></div>'
  + '      <div id="danger-archive-note" class="danger-archive-note"></div>'
  + '    </div>'
  + '  </div>'
  + '</div>';

// 上游的模态框都直接放在 body 下（#user-modal 那一批就是），所以这里也放 body 末尾，
// .modal-mask 的定位与 z-index 都跟着那条既有规则走，不另立一层。
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
    console.warn('[mods] 清空与存档的模态框注入失败：' + ((e && e.message) || e));
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

// 外挂模块是拼成一个 <script> 在装载期就执行的：那时 <body> 可能还没解析完，
// 所以两处都要有 —— DOMContentLoaded 挂一次，真正要用的时候再补一次。
function dangerArchiveEnsureMounted() {
  dangerArchiveInjectStyle();
  return dangerArchiveInjectModal();
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
  // desktopMods = 外挂自己那段桥接（装在原版上时只有它有这四个方法）；
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

// ---------- 状态捕获 ----------

function dangerArchiveParseRaw(raw) {
  try {
    var parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

// 队列还挂在界面上、但播放存档还没来得及写（saveLastPlaybackSnapshot 有 2.5 秒节流，
// 且没有当前曲目时直接 return）的情况下，用内存里的真实列表补一份出来，
// 否则"清空前存档"会存成一份空的，等于白存。
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

// 清空之前把现场抓成一份原始字符串字典。先强制刷一次播放存档，让存档反映的是
// "此刻的列表"而不是"2.5 秒前那次 autosave 的列表"。
function dangerArchiveCaptureState() {
  var state = {};
  try {
    if (typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, 'danger-archive');
  } catch (e) { }
  var searchRaw = null;
  var playbackRaw = null;
  try { searchRaw = localStorage.getItem(SEARCH_HISTORY_STORE_KEY); } catch (e) { }
  try { playbackRaw = localStorage.getItem(LAST_PLAYBACK_STORE_KEY); } catch (e) { }
  // 屏幕上挂着列表时，以内存里那份为准：autosave 有 2.5 秒节流，刚加进去的那几首
  // 可能还没落盘，照存档存就会少几首。屏幕空着时才用存档（那正是下次启动会恢复回来的东西）。
  var live = dangerArchiveLiveSnapshotPayload();
  if (live) playbackRaw = JSON.stringify(live);
  var listenRaw = null;
  try { listenRaw = localStorage.getItem(HOME_LISTEN_STATS_KEY); } catch (e) { }
  if (searchRaw && dangerArchiveSearchCount(searchRaw) > 0) state[SEARCH_HISTORY_STORE_KEY] = searchRaw;
  if (playbackRaw && dangerArchiveQueueLengthOf(playbackRaw) > 0) state[LAST_PLAYBACK_STORE_KEY] = playbackRaw;
  if (listenRaw && dangerArchiveListenCount(listenRaw) > 0) state[HOME_LISTEN_STATS_KEY] = listenRaw;
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
  var playback = dangerArchiveParseRaw(state && state[LAST_PLAYBACK_STORE_KEY]);
  var current = (playback && playback.current) || {};
  var listenRaw = state && state[HOME_LISTEN_STATS_KEY];
  var listen = dangerArchiveParseRaw(listenRaw);
  return {
    searchItems: dangerArchiveSearchCount(state && state[SEARCH_HISTORY_STORE_KEY]),
    queueLength: dangerArchiveQueueLengthOf(state && state[LAST_PLAYBACK_STORE_KEY]),
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
  return {
    id: 'archive-' + createdAt + '-' + Math.floor(Math.random() * 46656).toString(36),
    createdAt: createdAt,
    kind: kind === 'pre-restore' ? 'pre-restore' : 'clear',
    reason: kind === 'pre-restore' ? 'restore-undo-point' : 'manual-clear',
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

// ---------- 面板渲染 ----------

function dangerArchiveItemMarkup(record, index) {
  var summary = (record && record.summary) || {};
  var kindLabel = record && record.kind === 'pre-restore' ? '恢复前' : '清空前';
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
  var kind = record && record.kind === 'pre-restore' ? 'pre-restore' : 'clear';
  var songLabel = summary.currentName
    ? ('正在播：' + summary.currentName + (summary.currentArtist ? ' — ' + summary.currentArtist : ''))
    : '没有正在播的曲目';
  // kind 同时进 data 属性（样式按它分色）和文本（读屏能念出来）。
  // 删除按钮做成行的兄弟节点而不是行内子节点：整行本身是个 <button>，
  // 按钮里再套按钮是非法 HTML，而且点删除会被行的委托当成"恢复"。
  var del = dangerArchiveDeleteMarkup(id);
  return '<div class="danger-archive-item-wrap">'
    + '<button class="danger-archive-item" type="button" data-danger-archive-id="' + escHtml(id)
    + '" data-danger-archive-kind="' + escHtml(kind) + '">'
    + '<span class="danger-archive-item-kind">' + escHtml(kindLabel) + '</span>'
    + '<span class="danger-archive-item-time">' + escHtml(dangerArchiveFormatClock(nowLabel)) + '</span>'
    + '<span class="danger-archive-item-main">' + escHtml(listLabel + ' · ' + historyLabel + ' · ' + listenLabel) + '</span>'
    + '<span class="danger-archive-item-song">' + escHtml(songLabel) + '</span>'
    + '</button>' + del + '</div>';
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
  var note = document.getElementById('danger-archive-note');
  if (!list) return;
  if (!res || res.ok !== true) {
    dangerArchiveLastList = [];
    list.innerHTML = '<div class="danger-archive-empty">存档读不出来：'
      + escHtml((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误')
      + '。为防丢备份，清空按钮已停用。</div>';
    if (count) count.textContent = '';
    var broken = document.querySelector('#danger-archive-modal .danger-archive-clear-all');
    if (broken) broken.setAttribute('disabled', 'disabled');
    return;
  }
  var archives = Array.isArray(res.archives) ? res.archives : [];
  dangerArchiveLastList = archives;
  // 待确认的那条已经不在列表里了（被删了/文件被外部改过），别把确认态留在界面上
  if (dangerArchivePendingDeleteId && !archives.some(function (item) {
    return String(item && item.id) === dangerArchivePendingDeleteId;
  })) dangerArchivePendingDeleteId = '';
  var clearBtn = document.querySelector('#danger-archive-modal .danger-archive-clear-all');
  if (clearBtn) clearBtn.removeAttribute('disabled');
  if (count) count.textContent = archives.length ? ('共 ' + archives.length + ' 份 · 最多留 20 份') : '';
  list.innerHTML = archives.length
    ? archives.map(dangerArchiveItemMarkup).join('')
    : '<div class="danger-archive-empty">还没有存档。按上面的「一键清空」清空一次，清空前的状态就会存进这里。</div>';
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
      if (typeof showToast === 'function') {
        showToast('存档删除失败：' + ((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误'));
      }
      return dangerArchiveRefreshList().then(function () {
        return { ok: false, error: (res && res.error) || 'REMOVE_FAILED' };
      });
    }
    dangerArchiveRenderList(res);
    if (typeof showToast === 'function') {
      var s = (target && target.summary) || {};
      showToast('已删除这份存档（' + (s.queueLength || 0) + ' 首 · ' + (s.searchItems || 0) + ' 条搜索记录 · '
        + (s.listenRecords || 0) + ' 条聆听记录），剩下 ' + (res.archives || []).length + ' 份');
    }
    return { ok: true, id: clean, remaining: (res.archives || []).length };
  }).catch(function (e) {
    if (typeof showToast === 'function') showToast('存档删除失败：' + String((e && e.message) || e));
    return { ok: false, error: 'THROW', detail: String((e && e.message) || e) };
  }).then(function (out) {
    dangerArchiveBusy = false;
    return out;
  });
}

function dangerArchiveSetPhase(unlocked) {
  var modal = dangerArchiveModal();
  if (!modal) return;
  modal.classList.toggle('unlocked', !!unlocked);
  if (!unlocked) {
    var input = document.getElementById('danger-archive-password');
    if (input) input.value = '';
    var status = document.getElementById('danger-archive-status');
    if (status) { status.textContent = ''; status.classList.remove('is-error'); }
  }
}

// ---------- 开关门 ----------

function openDangerArchiveGate() {
  // 装载期那次注入可能赶在 body 解析完之前（模块是同步拼进一个 script 的），这里补一次
  dangerArchiveEnsureMounted();
  var modal = dangerArchiveModal();
  if (!modal) return;
  // 沉浸模式会把所有 .modal-mask 直接 display:none（index.css 里那条规则），
  // 那时按 Ctrl+H 会"什么也没发生"，所以先把沉浸关掉
  if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') {
    setImmersiveMode(false);
  }
  dangerArchiveAttempts = 0;
  dangerArchivePendingDeleteId = '';
  dangerArchiveSetPhase(false);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  var input = document.getElementById('danger-archive-password');
  if (input) {
    input.value = '';
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { } }, 30);
  }
}

function closeDangerArchiveModal() {
  var modal = dangerArchiveModal();
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  dangerArchivePendingDeleteId = '';
  dangerArchiveSetPhase(false);
}

function dangerArchiveModalOpen() {
  var modal = dangerArchiveModal();
  return !!(modal && modal.classList.contains('show'));
}

function dangerArchiveSetStatus(message, isError) {
  var status = document.getElementById('danger-archive-status');
  if (!status) return;
  status.textContent = String(message || '');
  status.classList.toggle('is-error', !!isError);
}

function dangerArchivePasswordOk(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === DANGER_ARCHIVE_PASSWORD;
}

function submitDangerArchiveGate() {
  var input = document.getElementById('danger-archive-password');
  var value = input ? input.value : '';
  if (dangerArchivePasswordOk(value)) {
    dangerArchiveAttempts = 0;
    dangerArchiveSetPhase(true);
    dangerArchiveRefreshList();
    return true;
  }
  dangerArchiveAttempts += 1;
  if (input) input.value = '';
  dangerArchiveSetStatus(dangerArchiveAttempts >= 3
    ? '密码不对。已经错了 ' + dangerArchiveAttempts + ' 次——想不起来就按取消，这个门不影响软件其它功能。'
    : '密码不对', true);
  if (input) { try { input.focus(); } catch (e) { } }
  return false;
}

// ---------- 一键清空 ----------

// 停播。顺序很讲究，两步都不能换：
//  1. 先把 listenSession 摘掉。停播会走音频事件链，里面的 finalizeListenSession 会把
//     "刚听完的这一段"写回聆听统计（他刚听了 6 分半，这一下就会又冒出一条最近播放），
//     等于前脚清后脚补。摘掉之后 finalize 第一句 !listenSession 直接 return。
//  2. 再 pause + 清 src + load。这是本仓库换源时已经在用的清场写法。
// 之后 currentCoverSong() 为空，进度 tick 与音频事件那两处 saveLastPlaybackSnapshot
// 都会早退，不会把刚删掉的播放存档又写回来。
function dangerArchiveStopPlayback() {
  try { listenSession = null; } catch (e) { }
  try {
    if (typeof audio !== 'undefined' && audio) {
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) { }
      // load() 之后 Chromium 会把 paused 复位成 false（实测：清空后 audio.paused
      // 仍是 false），所以这里必须再 pause 一次，否则"停了没停"这件事没法用 paused 判。
      try { audio.pause(); } catch (e) { }
    }
  } catch (e) { }
  try { playing = false; } catch (e) { }
  try { if (typeof setPlayIcon === 'function') setPlayIcon(false); } catch (e) { }
  try { if (typeof hideLoading === 'function') hideLoading(); } catch (e) { }
  // 播放条与封面缩略图也要归零，否则"还挂着刚才那首"，看着就是没清
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
// （那是 setControlCoverSrc 那条路）。用户 2026-10-10 看到的"还剩一个图标和平台标签"
// 就是这两处：封面背景图还挂着、.control-source-chip(BL) 被后面某次异步重绘又写了回来。
// 所以这里既调 app 自己的函数，也直接写 DOM 兜底。
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

// 异步收尾（音质探测、歌词、换源、首页推荐）会在清空之后再回来写一次播放条，
// 所以补两次归零。判据卡死在"队列确实还是空的、也没有声音"上，
// 不会踩到用户清空后立刻自己点歌起播的情况。
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
  try { localStorage.removeItem(HOME_LISTEN_STATS_KEY); } catch (e) { }
}

function dangerArchiveClearEverything() {
  // 先停播再清：反过来会被 pause 事件链把当前曲目写回存档
  dangerArchiveStopPlayback();
  // 走 app 自己的两个清空函数：它们除了删数据还要重绘队列面板、歌单架和空主页
  if (typeof clearSearchHistory === 'function') clearSearchHistory();
  else {
    try { localStorage.removeItem(SEARCH_HISTORY_STORE_KEY); } catch (e) { }
  }
  if (typeof clearQueue === 'function') clearQueue();
  else {
    try { localStorage.removeItem(LAST_PLAYBACK_STORE_KEY); } catch (e) { }
  }
  dangerArchiveWipeListenStats();
  // 首页那两张卡（CONTINUE / RECENT）读的是聆听统计，清完要立刻重画，
  // 否则卡片上还挂着刚才那首，看起来就是"没清"
  try { if (typeof renderHomeDashboardQuickCards === 'function') renderHomeDashboardQuickCards(); } catch (e) { }
  try { if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: true }); } catch (e) { }
  // 清完之后还有异步收尾会回来写播放条（音质探测、歌词、首页推荐、换源），
  // 所以再补两次归零。判据是"队列仍然是空的且没声音"，恢复存档时不会被误踩。
  try {
    if (typeof setTimeout === 'function') {
      setTimeout(function () { dangerArchiveReassertEmptyControlBar('after-clear-380'); }, 380);
      setTimeout(function () { dangerArchiveReassertEmptyControlBar('after-clear-1400'); }, 1400);
    }
  } catch (e) { }
}

function runDangerArchiveClearAll() {
  if (dangerArchiveBusy) return Promise.resolve({ ok: false, error: 'BUSY' });
  var state = dangerArchiveCaptureState();
  if (!dangerArchiveStateHasContent(state)) {
    if (typeof showToast === 'function') showToast('没有需要清空的内容：搜索记录、播放列表和聆听统计本来就是空的');
    return Promise.resolve({ ok: false, error: 'NOTHING_TO_CLEAR' });
  }
  dangerArchiveBusy = true;
  var record = dangerArchiveBuildRecord('clear', state);
  return dangerArchiveAppendRecord(record).then(function (res) {
    if (!res || res.ok !== true) {
      // 落盘没成功就绝不动用户的数据，不然"备份"就是个谎言
      if (typeof showToast === 'function') {
        showToast('存档失败，已取消清空：' + ((res && (res.error + (res.detail ? ' / ' + res.detail : ''))) || '未知错误'));
      }
      return { ok: false, error: (res && res.error) || 'ARCHIVE_FAILED', archived: false };
    }
    dangerArchiveRenderList(res);
    dangerArchiveClearEverything();
    if (typeof showToast === 'function') {
      showToast('已清空搜索记录、播放列表与聆听统计，播放已停止（清空前状态已存档：'
        + record.summary.queueLength + ' 首 · ' + record.summary.searchItems + ' 条）');
    }
    return { ok: true, archived: true, id: record.id };
  }).catch(function (e) {
    if (typeof showToast === 'function') showToast('清空失败：' + String((e && e.message) || e));
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
    if (raw) localStorage.setItem(SEARCH_HISTORY_STORE_KEY, raw);
    else localStorage.removeItem(SEARCH_HISTORY_STORE_KEY);
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
    if (raw) localStorage.setItem(LAST_PLAYBACK_STORE_KEY, raw);
    else localStorage.removeItem(LAST_PLAYBACK_STORE_KEY);
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
    if (raw) localStorage.setItem(HOME_LISTEN_STATS_KEY, raw);
    else localStorage.removeItem(HOME_LISTEN_STATS_KEY);
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
  dangerArchiveApplySearchHistory(snapshot[SEARCH_HISTORY_STORE_KEY] || '');
  dangerArchiveApplyListenStats(snapshot[HOME_LISTEN_STATS_KEY] || '');
  var playbackApplied = dangerArchiveApplyPlayback(snapshot[LAST_PLAYBACK_STORE_KEY] || '');
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
      if (typeof showToast === 'function') showToast('存档失败，已取消恢复：' + ((res && res.error) || '未知错误'));
      return { ok: false, error: (res && res.error) || 'ARCHIVE_FAILED' };
    }
    var applied = dangerArchiveApplyState(target.state);
    if (typeof showToast === 'function') {
      var s = target.summary || {};
      showToast('已恢复到 ' + dangerArchiveFormatClock(s.queueChangedAt || s.snapshotSavedAt || target.createdAt)
        + ' 的状态（' + (s.queueLength || 0) + ' 首 · ' + (s.searchItems || 0) + ' 条搜索记录 · '
        + (s.listenRecords || 0) + ' 条聆听记录）'
        + (applied.playbackApplied ? '' : ' · 队列已恢复，等下次播放数据能取到'));
    }
    closeDangerArchiveModal();
    return dangerArchiveRefreshList().then(function () {
      return { ok: true, id: target.id, playbackApplied: applied.playbackApplied };
    });
  }).catch(function (e) {
    if (typeof showToast === 'function') showToast('恢复失败：' + String((e && e.message) || e));
    return { ok: false, error: 'THROW', detail: String((e && e.message) || e) };
  }).then(function (out) {
    dangerArchiveBusy = false;
    return out;
  });
}

// ---------- 入口绑定 ----------

function dangerArchiveHandleHotkey(e) {
  var combo = typeof normalizeHotkeyEvent === 'function' ? normalizeHotkeyEvent(e) : '';
  if (combo !== DANGER_ARCHIVE_HOTKEY) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;
  if (dangerArchiveModalOpen()) closeDangerArchiveModal();
  else openDangerArchiveGate();
  return true;
}

function dangerArchiveHandleModalKeys(e) {
  if (!dangerArchiveModalOpen()) return false;
  // 回车只服务于还没解锁的那一步：光标在密码框里，按回车等于点「确认」。
  // 解锁之后列表才是主角，回车不该有任何动作（避免手一抖就恢复了一份存档）
  if (e.key === 'Enter') {
    if (dangerArchivePanelUnlocked()) return false;
    e.preventDefault();
    e.stopPropagation();
    submitDangerArchiveGate();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    // 有待确认的删除时，Esc 先当"取消"：这时关窗会让用户以为"按 Esc 就删了"或"没删成"
    if (dangerArchivePanelUnlocked() && dangerArchivePendingDeleteId) {
      dangerArchivePendingDeleteId = '';
      dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
      return true;
    }
    closeDangerArchiveModal();
    return true;
  }
  return false;
}

function dangerArchivePanelUnlocked() {
  var modal = dangerArchiveModal();
  return !!(modal && modal.classList.contains('unlocked'));
}

// 存档条目的点击用委托：id 来自动画文件，拼进 inline onclick 会把文件里的内容
// 当成代码执行；这里只认 data-danger-archive-* 这些属性，值本身不参与代码。
// 顺序：删除三步（del / confirm / cancel）先判，最后才轮到"点整行=恢复"。
function dangerArchiveHandleClick(event) {
  if (!dangerArchiveModalOpen()) return false;
  var target = event && event.target;
  if (!target || typeof target.closest !== 'function') return false;
  var cancel = target.closest('[data-danger-archive-del-cancel]');
  if (cancel) {
    event.preventDefault();
    event.stopPropagation();
    dangerArchivePendingDeleteId = '';
    dangerArchiveRenderList({ ok: true, archives: dangerArchiveLastList });
    return true;
  }
  var confirm = target.closest('[data-danger-archive-del-confirm]');
  if (confirm) {
    event.preventDefault();
    event.stopPropagation();
    confirmDangerArchiveDelete(confirm.getAttribute('data-danger-archive-del-confirm'));
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

// 密码框在输入框里，而全局快捷键那条链（10-shell/01）第一句就是
// `if (isTypingTarget(e.target)) return;` —— 走那条路会导致"光标在搜索框里时 Ctrl+H 失灵"。
// 所以这里单独挂一个捕获阶段监听，抢在它前面。
document.addEventListener('keydown', function (e) {
  if (dangerArchiveHandleHotkey(e)) return;
  dangerArchiveHandleModalKeys(e);
}, true);
document.addEventListener('click', function (e) {
  dangerArchiveHandleClick(e);
}, true);

window.openDangerArchiveGate = openDangerArchiveGate;
window.closeDangerArchiveModal = closeDangerArchiveModal;
window.submitDangerArchiveGate = submitDangerArchiveGate;
window.runDangerArchiveClearAll = runDangerArchiveClearAll;
window.restoreDangerArchive = restoreDangerArchive;
window.requestDangerArchiveDelete = requestDangerArchiveDelete;
window.confirmDangerArchiveDelete = confirmDangerArchiveDelete;
window.dangerArchivePasswordOk = dangerArchivePasswordOk;
window.dangerArchiveCaptureState = dangerArchiveCaptureState;
window.dangerArchiveApplyState = dangerArchiveApplyState;

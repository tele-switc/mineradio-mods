// ============================================================
//  快速搜索浮窗在主窗口这一侧的宿主（Ctrl+Space，2026-10-09 加，10-10 加平台切换，
//  10-11 加"B 站合集分段"与"查看更多"）
//
//  为什么要有这一层：音频元素（HTMLAudioElement）活在主窗口的渲染进程里，
//  浮窗那个独立窗口既没有播放器，也不该重新实现一遍搜索（源顺序、登录判定、
//  合并去重、音质档位都在 07-search.js 里）。所以浮窗只负责打字、选平台、选择，
//  搜索与起播都回到这里，用 app 自己的 fetchMusicSearchResults 与 playQueueAt。
//
//  定位是"把软件里那个搜索框搬到浮窗上"，所以：
//   - 平台标签的顺序与文案直接对齐 public/index.html 里那排 .search-mode-tabs
//     （All / NE / QQ / KG / QS / BL / MG / RP / IA / Podcast），不是另起一套名字；
//   - 能不能搜、要不要提示登录，用 app 自己的 searchProviderCanSearch 与
//     searchProviderLoginNotice，行为跟主窗口点同一个标签一致；
//   - 搜到的词同样进 rememberSearchQuery —— 它就是软件的搜索历史，
//     Ctrl+H 那个面板清空/恢复的也是这一份，两边不该有两套账。
//   - Podcast 那一档在软件里是两级的（先搜到播客，点开才是单集），
//     所以这里也提供 podcastPrograms，浮窗点进去看单集，不然这个标签是假的。
//   - B 站那一档同样是两级的（2026-10-11，用户报"合集在浮窗里看不出来"）：
//     一条搜索结果可能是一整个合集（实测有 162/190/191/200 段的），而搜索接口只给
//     bvid 与整条时长，到底几段必须问 view 才知道。所以这里给每条 B 站结果打上
//     qsKind / qsBadge / qsMeta，并单独提供 biliParts 下钻；返回的分段行**已经是可播的
//     歌曲对象**（bvid + 自己的 cid + 分标题），浮窗那一侧不需要懂 cid 是什么。
//   - 结果不再硬截 12 条：初屏 24，「查看更多」每次再往前翻一页（本地已经取回的先给完，
//     再打下一批接口）。B 站一页正好回 12 条，原来那层截断等于永远看不到第 13 条。
//
//  两条刻意的选择：
//   1. 主窗口收进后台时这里照样能跑（win.hide() 不销毁渲染进程），
//      所以"不叫出主界面就能播放"是成立的；但我们不去 show 主窗口。
//   2. 选中的歌**追加**到现有队列末尾再跳过去，不推翻用户攒着的列表。
//      推翻是不可逆的，而"快速搜一首来听"本来也不需要清空现场。
//      合集的"整包入队"守同一条：只往末尾追加，已在队列里的段靠 queueItemKey
//      （B 站的键带 cid，见 09-queue-snapshot-autoplay.js）跳过，不会重复堆两份。
// ============================================================

var quickSearchHostSeq = 0;
// 一次给浮窗铺多少条。原来是硬截 12 条，而 B 站一页正好回 12 条 —— 第 13 条永远拿不到。
// 现在初屏 24、「查看更多」每次再 +24，上限 120：浮窗卡片只有 470px 宽、列表 300px 高，
// 再多就是让用户在一屏滚不到头的东西里找歌（主界面那份上限是 MUSIC_SEARCH_MAX_RESULTS=180）。
var QUICK_SEARCH_PAGE_SIZE = 24;
var QUICK_SEARCH_MAX_ITEMS = 120;
var QUICK_SEARCH_PODCAST_LIMIT = 18;
var QUICK_SEARCH_PROGRAM_LIMIT = 30;
// 分段一次最多铺多少行给浮窗（主界面同一口径是 60 行，实测有 191 段的合集）。
// 剩下的不装作不存在：列表顶上那条「整包入队 N 段」覆盖的是全部段落。
var QUICK_SEARCH_PART_RENDER_LIMIT = 80;
// 上一次用的是哪个平台。软件主界面的 searchMode 本来不落盘（每次打开都是 All），
// 但浮窗是一次性窗口，关掉就销毁，不落盘就等于每次按 Ctrl+Space 都退回 All。
var QUICK_SEARCH_MODE_STORE_KEY = 'mineradio-quick-search-mode-v1';

// 顺序与文案对齐 index.html 的 .search-mode-tabs；title 用软件的中文名，
// 给浮窗当悬停提示与无障碍名字。
var QUICK_SEARCH_MODES = [
  { mode: 'song', label: 'All', title: '全部音乐源（合并搜索）' },
  { mode: 'netease', label: 'NE', title: '网易云音乐' },
  { mode: 'qq', label: 'QQ', title: 'QQ 音乐' },
  { mode: 'kugou', label: 'KG', title: '酷狗音乐' },
  { mode: 'qishui', label: 'QS', title: '汽水音乐' },
  { mode: 'bilibili', label: 'BL', title: 'B 站（mineradio-mods 外挂源）', modProvider: true },
  { mode: 'radioparadise', label: 'RP', title: 'Radio Paradise 直播电台（免登录 320k AAC，mineradio-mods 外挂源）', modProvider: true },
  { mode: 'internetarchive', label: 'IA', title: 'Internet Archive 公开音频（免登录，mineradio-mods 外挂源）', modProvider: true },
  { mode: 'podcast', label: 'Podcast', title: '播客' },
];
// 外挂源那一档只有后端真在（装了对应的源）才亮起来，免得点出一个空列表。
QUICK_SEARCH_MODES = QUICK_SEARCH_MODES.filter(function (entry) {
  if (!entry.modProvider) return true;
  return typeof window !== 'undefined' && typeof window.__mrModsHas === 'function' && window.__mrModsHas(entry.mode);
});
// 咪咕还没搬进包里（要处理会话，见 README 的已搬/待搬），先不放点了没反应的标签出来骗人。

// 浮窗这一侧的"已经取回哪些歌、翻到哪儿了"。翻页游标留在这里而不是浮窗里，
// 理由与本文件开头那条一样：两边各实现一遍搜索，行为迟早分叉。
var quickSearchHostPool = {
  key: '', query: '', mode: 'song', providerPages: {}, songs: [], shown: 0, remoteHasMore: false,
};

// 分段缓存优先复用主界面那一份 biliPartsCache（同一条合集在软件里点开过，浮窗就不该
// 再打一次 view 接口）；取不到时（单测沙箱里没有 07-search.js）退回这份本地的。
var quickSearchHostPartsLocal = {};

// 上游那份桥接叫 desktopWindow，外挂自己加的这段叫 desktopMods。
// 两个都认，是为了"装在已经逆向过的开发版上也能跑"。
function quickSearchHostBridge() {
  if (typeof window === 'undefined') return null;
  return window.desktopMods || window.desktopWindow || null;
}

function quickSearchHostApi() {
  var api = quickSearchHostBridge();
  return api && typeof api.sendQuickSearchResults === 'function' ? api : null;
}

function quickSearchHostReply(requestId, payload) {
  var api = quickSearchHostApi();
  if (!api) return;
  try {
    api.sendQuickSearchResults(Object.assign({ requestId: Number(requestId) || 0 }, payload || {}));
  } catch (e) {
    console.warn('[QuickSearch] 回结果失败:', e && e.message || e);
  }
}

function quickSearchHostNormalizeMode(mode) {
  var want = String(mode || 'song');
  for (var i = 0; i < QUICK_SEARCH_MODES.length; i++) {
    if (QUICK_SEARCH_MODES[i].mode === want) return want;
  }
  return 'song';
}

function quickSearchHostReadMode() {
  var saved = '';
  try { saved = String(localStorage.getItem(QUICK_SEARCH_MODE_STORE_KEY) || ''); } catch (e) { }
  return quickSearchHostNormalizeMode(saved || 'song');
}

function quickSearchHostWriteMode(mode) {
  var normalized = quickSearchHostNormalizeMode(mode);
  try { localStorage.setItem(QUICK_SEARCH_MODE_STORE_KEY, normalized); } catch (e) { }
  return normalized;
}

// 每个标签"现在到底能不能搜、登录了没"，全部问软件自己的判断函数，
// 浮窗只负责把结果画出来（未登录的标签会被标灰，但依然可点 —— 跟主界面一样，
// 点了搜不到时给的是同一句 searchProviderLoginNotice）。
function quickSearchHostTabs() {
  return QUICK_SEARCH_MODES.map(function (entry) {
    var provider = typeof searchModeProvider === 'function' ? searchModeProvider(entry.mode) : '';
    var available = true;
    var loggedIn = true;
    if (entry.mode === 'song') {
      available = typeof activeSearchProvidersForMode === 'function'
        ? activeSearchProvidersForMode('song').length > 0 : true;
    } else if (provider) {
      available = typeof searchProviderCanSearch === 'function' ? !!searchProviderCanSearch(provider) : true;
      var status = typeof searchProviderStatus === 'function' ? (searchProviderStatus(provider) || {}) : {};
      loggedIn = status.publicCatalog === true || status.searchReady === true || !!status.loggedIn
        || !(status.loggedIn === false);
    }
    return {
      mode: entry.mode,
      label: entry.label,
      title: entry.title,
      available: available !== false,
      loggedIn: loggedIn !== false,
    };
  });
}

function quickSearchHostProviderKey(song) {
  if (typeof songProviderKey === 'function') return songProviderKey(song);
  return String((song && (song.provider || song.source || song.type)) || 'song');
}

function quickSearchHostBvid(song) {
  return String((song && (song.bvid || song.id)) || '');
}

function quickSearchHostPartsCache() {
  return (typeof biliPartsCache === 'object' && biliPartsCache) ? biliPartsCache : quickSearchHostPartsLocal;
}

function quickSearchHostRememberParts(bvid, entry) {
  if (typeof rememberBiliPartsEntry === 'function') { rememberBiliPartsEntry(bvid, entry); return; }
  quickSearchHostPartsLocal[bvid] = entry;
  var keys = Object.keys(quickSearchHostPartsLocal);
  if (keys.length > 40) delete quickSearchHostPartsLocal[keys[0]];
}

// 分 P 优先于 ugc_season（同主界面 biliCollectionItems 的口径）：pages 才是这条视频自己的
// 曲目表，season 是平台另外挂上来的另一个列表，两者都给会让用户点开的不是自己搜到的那条。
function quickSearchHostPartsItems(entry) {
  if (typeof biliCollectionItems === 'function') return biliCollectionItems(entry);
  if (!entry || entry.state !== 'ready') return [];
  if (entry.parts && entry.parts.length > 1) return entry.parts;
  if (entry.seasonItems && entry.seasonItems.length > 1) return entry.seasonItems;
  return entry.parts || [];
}

// 一段 = 一条可播的歌（bvid + 这一段的 cid + 分标题）。口径与主界面 biliPartSongFrom 一致，
// 沙箱里没有那个函数时按同一份规则自己拼，保证单测走的字段路径与真机一致。
function quickSearchHostPartSong(parent, item) {
  if (typeof biliPartSongFrom === 'function' && parent) return biliPartSongFrom(parent, item);
  parent = parent || {};
  var ownBvid = String((item && item.bvid) || '');
  var parentBvid = quickSearchHostBvid(parent) || ownBvid;
  var song = Object.assign({}, parent);
  song.provider = song.provider || 'bilibili';
  song.source = song.source || 'bilibili';
  song.bvid = (ownBvid && ownBvid !== parentBvid) ? ownBvid : parentBvid;
  song.id = song.bvid;
  song.cid = String((item && item.cid) || '');
  song.name = (item && item.part) || parent.name || '未命名分段';
  if (item && item.duration) song.duration = Number(item.duration) || song.duration;
  song.biliCollectionTitle = String(parent.name || '');
  song.biliPartIndex = Number(item && item.index) || 0;
  return song;
}

function quickSearchHostDurationSec(song) {
  // B 站与播客单集的 duration 是**秒**（bilibili-api 的 durationToSeconds、主界面
  // formatProgramTime 都按秒算），网易云那类是毫秒。浮窗原来一律"大于 1000 就当毫秒除一遍"，
  // 于是 20 分钟的分段会被显示成 0:1 —— 单位在这里说清楚，别让浮窗猜。
  var provider = quickSearchHostProviderKey(song);
  var value = Number(song && (song.duration || song.durationMs || song.dt) || 0);
  if (!isFinite(value) || value <= 0) return 0;
  if (provider === 'bilibili' || provider === 'podcast' || (song && song.type === 'podcast')) return Math.round(value);
  return value > 1000 ? Math.round(value / 1000) : Math.round(value);
}

// 搜索结果里的 song 对象原样透传：各源起播要看的字段不一样（bilibili 要 bvid+cid、
// archive 要 archiveId+archiveFile、咪咕要 contentId…），这里做白名单裁剪会把歌裁没。
// qs* 是"只加不改"的画图用标注，浮窗拿它们决定徽章、能不能下钻、回车是播还是展开。
function quickSearchHostItem(song) {
  if (!song || typeof song !== 'object') return null;
  var item = Object.assign({}, song);
  var sec = quickSearchHostDurationSec(song);
  if (sec) item.qsDurationSec = sec;
  var providerKey = quickSearchHostProviderKey(song);
  // 免登录的两个外挂源都"不像一首歌"，明说一句比让用户点了才发现强：
  // RP 是连续直播（拖不了进度、没有单曲），IA 一行是 archive.org 的一个**条目**
  // （往往是一整张专辑/一场演出），实际播哪个文件由后端按音质档从条目里挑。
  if (typeof window.__mrModsIsLive === 'function' && window.__mrModsIsLive(providerKey)) {
    item.qsBadge = '直播';
    item.qsBadgeTitle = '电台直播流：没有单曲、没有可拖的进度条，也没有同步歌词';
  } else if (providerKey === 'internetarchive') {
    item.qsBadge = '条目';
    item.qsBadgeTitle = 'archive.org 的一个条目（常见为一整张专辑或一场演出）· 播放时后端按音质档从条目里挑一个浏览器能解码的文件';
  }
  if (typeof searchBiliVersionBits === 'function') {
    // 分区名 / "合集/串烧，非单曲" / 非原唱版本 —— 与主界面结果行同一套话，两边不各说各的
    var bits = searchBiliVersionBits(song) || [];
    if (bits.length) item.qsMeta = bits.join('  ·  ');
  } else if (quickSearchHostProviderKey(song) === 'bilibili') {
    // 上游原版没有主界面那套标注函数，外挂自己凑一句（分区名 + 是不是合集），
    // 判据仍来自适配层的 categoryName / isCompilation，不在这里另立标准
    var fallback = [];
    if (song.categoryName) fallback.push(song.categoryName);
    if (song.isCompilation) fallback.push('合集/串烧，非单曲');
    if (fallback.length) item.qsMeta = fallback.join('  ·  ');
  }
  var bvid = quickSearchHostBvid(song);
  if (quickSearchHostProviderKey(song) === 'bilibili' && bvid) {
    var entry = quickSearchHostPartsCache()[bvid];
    // qsKind 只给浮窗看（决定"回车是播整条还是下钻分段"），起播本身用不到
    item.qsKind = 'bili-collection';
    if (entry && entry.state === 'ready') {
      var count = quickSearchHostPartsItems(entry).length;
      item.qsBadge = count > 1 ? (count + ' 段') : '单段';
      item.qsBadgeWeak = count <= 1;
      if (count > 1) item.qsParts = count;
    } else if (song.isCompilation || song.isCollection) {
      // 适配层已经按"15 分钟以上 / 5 分钟以上且标题写着合集串烧"判过一轮（bilibili-api.js）
      item.qsBadge = '合集';
      item.qsBadgeWeak = false;
    } else {
      // 没被规则命中的也留个入口：真实段数只有 view 知道，别让用户以为这行只能整条播
      item.qsBadge = '可查分段';
      item.qsBadgeWeak = true;
    }
  }
  return item;
}

function quickSearchHostItems(songs) {
  return (Array.isArray(songs) ? songs : []).map(quickSearchHostItem).filter(Boolean);
}

function quickSearchHostMerged(existing, incoming) {
  // 合并去重用主界面那一个（跨源同曲折叠 + 上限截断）；沙箱里没有时退回最朴素的按 key 去重
  if (typeof mergeUniqueSearchSongPools === 'function') return mergeUniqueSearchSongPools(existing, incoming);
  var out = [];
  var seen = {};
  (Array.isArray(existing) ? existing : []).concat(Array.isArray(incoming) ? incoming : []).forEach(function (song) {
    if (!song || !song.name) return;
    var key = quickSearchHostProviderKey(song) + ':' + (song.mid || song.id || (song.name + '|' + song.artist));
    if (seen[key]) return;
    seen[key] = true;
    out.push(song);
  });
  return out;
}

// 把"这池子里已经取回多少、还能不能往前翻"算清楚再画给浮窗
function quickSearchHostPoolView() {
  var pool = quickSearchHostPool;
  var shown = Math.min(pool.shown, pool.songs.length, QUICK_SEARCH_MAX_ITEMS);
  var total = Math.min(pool.songs.length, QUICK_SEARCH_MAX_ITEMS);
  var items = quickSearchHostItems(pool.songs.slice(0, shown));
  return {
    items: items, shown: items.length, total: total,
    hasMore: shown < total || !!pool.remoteHasMore,
  };
}

function quickSearchHostPoolReply(requestId, extra) {
  var view = quickSearchHostPoolView();
  quickSearchHostReply(requestId, Object.assign({ mode: quickSearchHostPool.mode }, view, extra || {}));
  return view.items;
}

function quickSearchHostResetPool() {
  quickSearchHostPool = {
    key: '', query: '', mode: 'song', providerPages: {}, songs: [], shown: 0, remoteHasMore: false,
  };
}

// 外挂自己的源（B 站）不进软件的源注册表：直接问外挂后端那一页，游标自己记。
// 这样"加一个源"不用去包装 fetchMusicSearchResults / searchProviderUrl 那一整串。
async function quickSearchHostModSearch(mode, useNextPages) {
  var pool = quickSearchHostPool;
  var entry = (typeof window !== 'undefined' && window.__mrModsProviders) ? window.__mrModsProviders[mode] : null;
  if (!entry) return { songs: [], providerPages: {}, hasMore: false };
  var previous = pool.providerPages[mode] || {};
  var offset = useNextPages ? Math.max(0, Number(previous.nextOffset) || 0) : 0;
  // 取页这件事交给源模块本身（主界面与浮窗共用同一份，不各写一遍）
  if (typeof window.__mrModsSearchPage === 'function') return await window.__mrModsSearchPage(mode, pool.query, offset);
  var limit = Number(entry.pageLimit) || 12;
  var data = await apiJson(entry.search + '?keywords=' + encodeURIComponent(pool.query)
    + '&limit=' + limit + '&offset=' + offset);
  var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
  var nextOffset = Number(data && data.nextOffset);
  if (!isFinite(nextOffset) || nextOffset <= offset) nextOffset = offset + songs.length;
  var hasMore = data && data.hasMore != null ? !!data.hasMore : (songs.length >= limit);
  if (!songs.length) hasMore = false;
  var pages = {};
  pages[mode] = { offset: offset, nextOffset: nextOffset, hasMore: hasMore, limit: limit };
  return { songs: songs, providerPages: pages, hasMore: hasMore };
}

async function quickSearchHostFetchPage(useNextPages) {
  var pool = quickSearchHostPool;
  var isMod = typeof window !== 'undefined' && typeof window.__mrModsHas === 'function' && window.__mrModsHas(pool.mode);
  var page = isMod ? await quickSearchHostModSearch(pool.mode, useNextPages)
    : await fetchMusicSearchResults(pool.query, pool.mode, useNextPages ? pool.providerPages : null);
  var incoming = (page && Array.isArray(page.songs)) ? page.songs : [];
  var before = pool.songs.length;
  pool.songs = useNextPages ? quickSearchHostMerged(pool.songs, incoming) : incoming;
  pool.providerPages = isMod
    ? Object.assign({}, pool.providerPages, (page && page.providerPages) || {})
    : ((page && page.providerPages) || {});
  pool.remoteHasMore = !!(page && page.hasMore) && pool.songs.length < QUICK_SEARCH_MAX_ITEMS;
  // 翻了一页却没有新歌（源到头了 / 全是重复）就别再翻，浮窗那个「查看更多」要自己消失
  if (useNextPages && pool.songs.length === before) pool.remoteHasMore = false;
  return page;
}

function quickSearchHostFindPoolSong(bvid) {
  var songs = quickSearchHostPool.songs || [];
  for (var i = 0; i < songs.length; i++) {
    if (quickSearchHostBvid(songs[i]) === bvid) return songs[i];
  }
  return null;
}

async function quickSearchHostPodcastSearch(query) {
  var data = await apiJson('/api/podcast/search?keywords=' + encodeURIComponent(query) + '&limit=' + QUICK_SEARCH_PODCAST_LIMIT);
  var radios = (data && Array.isArray(data.podcasts)) ? data.podcasts : [];
  return {
    items: quickSearchHostItems(radios.slice(0, QUICK_SEARCH_PAGE_SIZE).map(function (radio) {
      // qsKind 只给浮窗看（决定"回车是播放还是下钻"），起播用不到
      return Object.assign({ qsKind: 'podcast-radio' }, radio);
    })),
  };
}

async function quickSearchHostPodcastPrograms(radioId) {
  var data = await apiJson('/api/podcast/programs?id=' + encodeURIComponent(radioId) + '&limit=' + QUICK_SEARCH_PROGRAM_LIMIT);
  var programs = (data && Array.isArray(data.programs)) ? data.programs : [];
  var items = quickSearchHostItems(programs.slice(0, QUICK_SEARCH_PAGE_SIZE));
  // 取回多少、画了多少分开报：截掉的那一截要浮窗老实说一句，不能装作这个播客只有 24 集
  return { items: items, fetchedCount: programs.length, radio: (data && data.radio) || {} };
}

// ---------- B 站合集分段：一条搜索结果可能是一整个播放列表 ----------
// 只有 view 接口知道真实段数，所以这里是"点开才取"，并且与主界面共用那份 biliPartsCache。
async function quickSearchHostLoadParts(bvid) {
  var cache = quickSearchHostPartsCache();
  var entry = cache ? cache[bvid] : null;
  if (entry && entry.state === 'ready') return entry;
  if (entry && entry.state === 'loading') {
    // 主界面可能正好也在取同一条：不再打一次接口，短等它落（实测 view 一千多段也就几百毫秒）
    for (var wait = 0; wait < 24 && entry.state === 'loading'; wait++) {
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    if (entry.state === 'ready') return entry;
    if (entry.state === 'error') throw new Error(entry.error || 'BILI_PARTS_FAILED');
    throw new Error('分段还在读取中，稍后再点一次');
  }
  var pending = { bvid: bvid, state: 'loading', open: true, parts: [], seasonItems: [], partCount: 0, seasonTitle: '', error: '' };
  quickSearchHostRememberParts(bvid, pending);
  try {
    var data = await apiJson('/api/bilibili/parts?bvid=' + encodeURIComponent(bvid));
    pending.state = 'ready';
    pending.parts = Array.isArray(data.parts) ? data.parts : [];
    pending.seasonItems = Array.isArray(data.seasonEpisodes) ? data.seasonEpisodes : [];
    pending.partCount = Number(data.partCount) || pending.parts.length;
    pending.seasonTitle = String(data.seasonTitle || '');
    // view 自己就带标题/UP主/封面，浮窗下钻时不必依赖搜索池子里那条还在不在
    pending.viewName = String(data.name || '');
    pending.viewArtist = String(data.artist || '');
    pending.viewCover = String(data.cover || '');
    pending.viewDuration = Number(data.duration) || 0;
    pending.error = '';
  } catch (e) {
    pending.state = 'error';
    pending.error = String((e && e.message) || e || 'BILI_PARTS_FAILED');
    throw e;
  }
  return pending;
}

function quickSearchHostPartsParent(bvid, entry) {
  var found = quickSearchHostFindPoolSong(bvid);
  if (found) return found;
  return {
    provider: 'bilibili', source: 'bilibili', type: 'bilibili',
    bvid: bvid, id: bvid, cid: '',
    name: (entry && entry.viewName) || bvid,
    artist: (entry && entry.viewArtist) || '',
    cover: (entry && entry.viewCover) || '',
    duration: (entry && entry.viewDuration) || 0,
  };
}

// 下钻返回的行**已经是能直接起播的歌曲对象**：浮窗按普通歌播掉就行，不用懂 bvid/cid。
function quickSearchHostPartRows(parent, entry) {
  var items = quickSearchHostPartsItems(entry);
  var rows = items.slice(0, QUICK_SEARCH_PART_RENDER_LIMIT).map(function (item, k) {
    var song = quickSearchHostPartSong(parent, item);
    song.qsKind = 'bili-part';
    song.qsPartIndex = Number(item && item.index) || (k + 1);
    var sec = quickSearchHostDurationSec(song);
    if (sec) song.qsDurationSec = sec;
    return song;
  });
  // 铺不完的那截做成列表下面的一行说明，不占行号（191 段的合集全铺会把小窗口拖垮）
  var moreNote = items.length > rows.length
    ? ('只显示前 ' + rows.length + ' 段，共 ' + items.length + ' 段 · 用「整包入队」一次全部加入队列')
    : '';
  return { rows: rows, moreNote: moreNote, total: items.length };
}

async function quickSearchHostBiliParts(requestId, payload) {
  var bvid = String((payload && payload.bvid) || '').trim();
  if (!bvid) { quickSearchHostReply(requestId, { error: '缺少合集 id' }); return; }
  var mode = quickSearchHostNormalizeMode(payload && payload.mode);
  try {
    var entry = await quickSearchHostLoadParts(bvid);
    var parent = quickSearchHostPartsParent(bvid, entry);
    var drilled = quickSearchHostPartRows(parent, entry);
    if (drilled.total <= 1) {
      // 单段视频不该装作合集（主界面同一口径）
      quickSearchHostReply(requestId, {
        mode: mode, action: 'biliParts', items: [], single: true,
        name: parent.name || '', bvid: bvid,
      });
      return;
    }
    // 列表第一行是"整包入队"：小窗口里翻不动 191 段的人要的是把整张专辑塞进队列
    var head = Object.assign({}, parent, {
      qsKind: 'bili-collection-all',
      name: '整包入队 · 共 ' + drilled.total + ' 段',
    });
    quickSearchHostReply(requestId, {
      mode: mode, action: 'biliParts',
      items: [head].concat(drilled.rows),
      partCount: drilled.total,
      moreNote: drilled.moreNote,
      name: parent.name || entry.viewName || '',
      artist: parent.artist || '',
      bvid: bvid,
      season: !!(entry.seasonTitle && (!entry.parts || entry.parts.length <= 1)),
    });
  } catch (e) {
    quickSearchHostReply(requestId, { mode: mode, action: 'biliParts', error: '分段读取失败：' + String((e && e.message) || e) });
  }
}

// 「查看更多」：本地池子里还有没画完的先画完（不打接口），真翻完了才往前取下一页
async function quickSearchHostMore(requestId) {
  var pool = quickSearchHostPool;
  if (!pool.query) { quickSearchHostPoolReply(requestId, { action: 'more' }); return; }
  try {
    var cap = Math.min(pool.songs.length, QUICK_SEARCH_MAX_ITEMS);
    if (pool.shown < cap || pool.remoteHasMore) {
      if (pool.shown >= cap && pool.remoteHasMore) await quickSearchHostFetchPage(true);
      pool.shown = Math.min(Math.max(QUICK_SEARCH_PAGE_SIZE, pool.shown + QUICK_SEARCH_PAGE_SIZE),
        Math.min(pool.songs.length, QUICK_SEARCH_MAX_ITEMS));
    }
    quickSearchHostPoolReply(requestId, { action: 'more' });
  } catch (e) {
    quickSearchHostReply(requestId, { mode: pool.mode, action: 'more', error: '加载更多失败：' + String((e && e.message) || e) });
  }
}

async function quickSearchHostFreshSearch(query, mode) {
  quickSearchHostPool = {
    key: mode + '\u0000' + query, query: query, mode: mode,
    providerPages: {}, songs: [], shown: 0, remoteHasMore: false,
  };
  await quickSearchHostFetchPage(false);
  quickSearchHostPool.shown = Math.min(quickSearchHostPool.songs.length, QUICK_SEARCH_PAGE_SIZE);
  return quickSearchHostPool.songs;
}

async function quickSearchHostRunQuery(payload) {
  var requestId = Number(payload && payload.requestId) || 0;
  var action = String((payload && payload.action) || 'search');
  var mode = quickSearchHostNormalizeMode(payload && payload.mode);
  // 合集分段下钻与「查看更多」都没有查询词，必须先于"空查询"那条判断处理
  if (action === 'biliParts') { await quickSearchHostBiliParts(requestId, payload); return; }
  if (action === 'more') { await quickSearchHostMore(requestId); return; }
  if (action === 'podcastPrograms') {
    var radioId = String((payload && payload.radioId) || '').trim();
    if (!radioId) { quickSearchHostReply(requestId, { error: '缺少播客 id' }); return; }
    try {
      var drilled = await quickSearchHostPodcastPrograms(radioId);
      var note = drilled.fetchedCount > drilled.items.length
        ? ('只列出前 ' + drilled.items.length + ' 集，本次取了 ' + drilled.fetchedCount + ' 集')
        : '';
      quickSearchHostReply(requestId, {
        mode: mode, action: action, items: drilled.items, radio: drilled.radio,
        shown: drilled.items.length, total: drilled.items.length, hasMore: false, moreNote: note,
      });
    } catch (e) {
      quickSearchHostReply(requestId, { error: '单集取不到：' + String((e && e.message) || e) });
    }
    return;
  }
  var query = String((payload && payload.query) || '').trim();
  if (!query) { quickSearchHostReply(requestId, { mode: mode, items: [], shown: 0, total: 0, hasMore: false }); return; }
  if (typeof apiJson !== 'function') {
    quickSearchHostReply(requestId, { error: '搜索模块还没装载完，稍后再试' });
    return;
  }
  quickSearchHostSeq += 1;
  try {
    var items = [];
    var view = null;
    if (mode === 'podcast') {
      // 播客那一档自己带 limit（搜 18 档 / 取 30 集），不参与歌曲那套分页池子
      quickSearchHostResetPool();
      items = (await quickSearchHostPodcastSearch(query)).items;
      view = { items: items, shown: items.length, total: items.length, hasMore: false };
    } else {
      // 走池子：这一次把各源第一页都取回来攒着，「查看更多」先在本地往前画，画完才打下一批接口
      await quickSearchHostFreshSearch(query, mode);
      view = quickSearchHostPoolView();
      items = view.items;
    }
    if (!items.length) {
      // 软件给"这个源要登录 / 暂时不可用"留了话，直接显示它，比"没搜到"三个字有用得多
      var notice = typeof searchProviderNotice === 'string' ? searchProviderNotice : '';
      if (notice) { quickSearchHostReply(requestId, { mode: mode, error: notice }); return; }
      quickSearchHostReply(requestId, { mode: mode, items: [], shown: 0, total: 0, hasMore: false });
      return;
    }
    // 与主界面同一条账：搜出来的词进软件的搜索历史（Ctrl+H 面板清/恢复的也是它）
    if (typeof rememberSearchQuery === 'function') rememberSearchQuery(query);
    quickSearchHostReply(requestId, Object.assign({ mode: mode }, view));
  } catch (e) {
    quickSearchHostReply(requestId, { mode: mode, error: '搜索失败：' + String((e && e.message) || e) });
  }
}

// 浮窗那些 qs* 只是画图用的标注，别跟着进队列、更别跟着落进播放存档
function quickSearchHostStripMarks(song) {
  Object.keys(song || {}).forEach(function (key) {
    if (key.indexOf('qs') === 0 && key.length > 2 && key.charAt(2) >= 'A' && key.charAt(2) <= 'Z') delete song[key];
  });
  return song;
}

function quickSearchHostCloneForQueue(song) {
  var clone = typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song);
  return quickSearchHostStripMarks(clone);
}

// 追加到队列末尾并回它的下标；已经在队列里就跳回那一条，不重复堆两份
function quickSearchHostPushQueue(clone) {
  if (!Array.isArray(playQueue)) playQueue = [];
  var key = typeof queueItemKey === 'function' ? queueItemKey(clone) : '';
  if (key) {
    for (var i = 0; i < playQueue.length; i++) {
      if (queueItemKey(playQueue[i]) === key) { currentIdx = i; return i; }
    }
  }
  playQueue.push(clone);
  currentIdx = playQueue.length - 1;
  return currentIdx;
}

// 这三行是 playSearchSong 的现场准备：不关主页遮罩，起播后界面会停在首页上
function quickSearchHostStartPlayback(firstIndex) {
  homeForcedOpen = false;
  homeSuppressed = false;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
  if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('quick-search', { scrollCurrent: true });
  if (typeof safeShelfRebuild === 'function') safeShelfRebuild('quick-search', true);
  var startAt = Number.isFinite(Number(firstIndex)) ? Number(firstIndex) : currentIdx;
  currentIdx = startAt;
  if (typeof playQueueAt === 'function') {
    Promise.resolve(playQueueAt(currentIdx, { manual: true }))
      .catch(function (e) { console.warn('[QuickSearch] 起播失败:', e && e.message || e); })
      .finally(function () {
        if (typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, 'quick-search');
      });
  }
  return { ok: true, index: currentIdx, total: Array.isArray(playQueue) ? playQueue.length : 0 };
}

// 「整包入队」：整张合集按段顺序追加到队尾，从第一段起播（用户要的是"这一整张专辑"，
// 不是又一条只能听第一首的结果行）。段与段各自带 cid，所以 queueItemKey 分得开它们。
function quickSearchHostPlayCollection(song) {
  var bvid = quickSearchHostBvid(song);
  var entry = bvid ? (quickSearchHostPartsCache()[bvid] || null) : null;
  var items = quickSearchHostPartsItems(entry);
  if (!items.length) return { ok: false, error: 'PARTS_NOT_LOADED' };
  var parent = quickSearchHostPartsParent(bvid, entry);
  if (!Array.isArray(playQueue)) playQueue = [];
  var before = playQueue.length;
  var firstIndex = -1;
  for (var i = 0; i < items.length; i++) {
    var at = quickSearchHostPushQueue(quickSearchHostCloneForQueue(quickSearchHostPartSong(parent, items[i])));
    if (i === 0) firstIndex = at;
  }
  // added 与 parts 分开报：队列里本来就有几段时，"入队了几段"和"这张合集有几段"不是一回事
  return Object.assign(quickSearchHostStartPlayback(firstIndex), { parts: items.length, added: playQueue.length - before });
}

function quickSearchHostPlay(song) {
  if (!song || typeof song !== 'object') return { ok: false, error: 'NO_SONG' };
  if (String(song.qsKind) === 'bili-collection-all') return quickSearchHostPlayCollection(song);
  quickSearchHostPushQueue(quickSearchHostCloneForQueue(song));
  return quickSearchHostStartPlayback(currentIdx);
}

// 开窗时把"上次用的平台 + 每个平台现在能不能搜"一起送给浮窗，
// 浮窗自己不猜、也不另存一份状态。
function quickSearchHostHello() {
  var mode = quickSearchHostReadMode();
  quickSearchHostReply(0, { hello: true, mode: mode, tabs: quickSearchHostTabs() });
}

function bindQuickSearchHost() {
  var api = quickSearchHostBridge();
  if (!api || typeof api.onQuickSearchQuery !== 'function') return false;
  api.onQuickSearchQuery(function (payload) { return quickSearchHostRunQuery(payload); });
  if (typeof api.onQuickSearchCommand === 'function') {
    api.onQuickSearchCommand(function (payload) {
      var action = String((payload && payload.action) || '');
      if (action === 'setMode') return { ok: true, mode: quickSearchHostWriteMode(payload && payload.mode) };
      if (action === 'hello') { quickSearchHostHello(); return { ok: true }; }
      if (action === 'play') return quickSearchHostPlay(payload && payload.song);
      return { ok: false, error: 'UNKNOWN_ACTION' };
    });
  }
  return true;
}

// 主窗口的模块是同步拼进一个 script 的，DOM/其它模块的函数在这行执行时都已就位；
// 但 IPC 监听要等到 window.desktopWindow 存在——浏览器里跑前端时它不存在，直接跳过。
if (!bindQuickSearchHost()) {
  window.addEventListener('DOMContentLoaded', function () { bindQuickSearchHost(); });
}

window.quickSearchHostPlay = quickSearchHostPlay;
window.quickSearchHostRunQuery = quickSearchHostRunQuery;
window.quickSearchHostTabs = quickSearchHostTabs;
window.quickSearchHostModes = QUICK_SEARCH_MODES;
// 给 tools/quick-search-e2e.mjs 看的"这一池子取到哪儿了"：取回多少 / 画了多少 / 还能不能翻。
// 浮窗那一侧只能看 DOM，主窗口这一侧的池子状态没法从 DOM 反推，留一个只读口子。
window.quickSearchHostPoolState = function () {
  return {
    key: quickSearchHostPool.key, query: quickSearchHostPool.query, mode: quickSearchHostPool.mode,
    fetched: (quickSearchHostPool.songs || []).length, shown: quickSearchHostPool.shown,
    remoteHasMore: !!quickSearchHostPool.remoteHasMore, pageSize: QUICK_SEARCH_PAGE_SIZE,
    maxItems: QUICK_SEARCH_MAX_ITEMS,
  };
};

// ============================================================
//  mineradio-mods 外挂模块：口味档案 · 个人数据 → 搜索个性化
//  （原版上游文件不改动，通过运行时注入样式、按钮、模态框并包装搜索导出）
// ============================================================
// ============================================================
//  口味档案 · 个人数据 → 搜索个性化（2026-10-19 加）
//
//  要解决的问题：搜索结果的顺序只由"查询词与这首歌唱得多准"决定，跟这个人听过什么、
//  收藏过什么无关。同一批结果里，那首他听了 40 次的歌可能排在第 11 行。
//
//  个人数据三条路，各自存在不同的地方（这是这套设计最容易看错的一点）：
//   1. 本机聆听：直接用 mineradio-listen-stats-v1 里那份（02-listen-stats.js 在维护）。
//      **档案里不复制一份**——匹配时按签名现建索引。省掉一份会走样的副本，也让
//      Ctrl+H「回到从来没听过歌」自动把聆听这一路的证据一起归零（口径见
//      20-danger-archive.js 顶部），本模块不需要再挂一次清空钩子。
//   2. 导入文件：TXT / CSV / JSON / M3U，含网易云、Spotify、Apple Music 的导出格式。
//   3. 连接平台：从已登录平台拉歌单与收藏，走 app 自己的 /api/{provider}/user/playlists
//      与 /api/{provider}/playlist/tracks，不打任何新后端接口。
//  2 与 3 存进 mineradio-taste-profile-v1，并镜像到 userData 的
//  mineradio-taste-profile.json（落盘见 desktop/taste-store.js）——那是他攒的资产，
//  不该跟着缓存清理一起没；它也不属于"听过的痕迹"，所以 Ctrl+H 不动它。
//
//  打分口径（三档都写死上限，见 TASTE_STRENGTHS）：个性化只决定"同样相关的东西谁在前"，
//  不能把完全不相干的歌挤进首页。证据强度走 log 缩放：听满 12 次拿满，听 1 次只拿四成，
//  免得"手滑播过一次"就把一首歌焊死在第一行。命中多类不叠加，只取最强那一路 ——
//  叠起来会把 merge 里 -95 的合集沉底规则顶穿。
//
//  为什么不动 scoreSongSearchResult()：那个函数被 tests/search-frontend-pagination.test.js
//  钉成"通用评分、不许有 provider 判断"，而且它算的是纯查询相关性。口味是另一件事，
//  所以在 merge 之后另加一层，只写 _taste* 字段并重排，原分数一分不改 ——
//  关掉开关就回到今天的行为，可对照、可回退。
// ============================================================

var TASTE_PROFILE_STORE_KEY = 'mineradio-taste-profile-v1';
var TASTE_IMPORT_ROW_LIMIT = 20000;
var TASTE_PLAYLIST_PAGE_SIZE = 100;
var TASTE_PLAYLIST_MAX_PAGES = 20;
// 歌手命中要先按规范化名字精确查，查不到才在"最铁的这些位"里找互相包含的写法。
// 全表扫描会随档案规模变成每次搜索几万次数串比较，这里用前 300 位封顶。
var TASTE_ARTIST_FUZZY_LIMIT = 300;
var tasteProfileSaveTimer = 0;
var tasteProfileSaveError = '';
var tastePendingClearSource = '';
var tasteStats = { profileSongs: 0, profileArtists: 0, listenSongs: 0, listenArtists: 0, sources: 0 };
var tasteImportSummary = { files: 0, songs: 0, skipped: 0, format: '' };
var tasteProviderImportState = { provider: '', loading: false, error: '', playlists: [], picked: {}, busy: false, progress: '' };

// 三档强度。cap 是"一首歌最多因为口味加多少分"，song/artist/title 是各类命中的基准分。
var TASTE_STRENGTHS = {
  soft: { label: '轻', song: 22, artist: 10, title: 4, cap: 26 },
  standard: { label: '标准', song: 38, artist: 16, title: 7, cap: 46 },
  strong: { label: '强', song: 58, artist: 26, title: 11, cap: 70 },
};

// 档案（导入 + 收藏）与聆听索引合并成的匹配视图。签名 = 档案 updatedAt + 聆听签名，
// 两边都不变就不重建 —— 一次搜索几百行，不能每行都去合并一遍 6000 条档案。
var tasteViewCache = { signature: '', songs: {}, artists: {}, artistKeys: [] };

var tasteProfileState = (function tasteBootProfile() {
  try {
    var raw = localStorage.getItem(TASTE_PROFILE_STORE_KEY);
    if (!raw) return tasteEmptyDocument();
    return tasteNormalizeDocument(JSON.parse(raw));
  } catch (e) {
    return tasteEmptyDocument();
  }
})();

function tasteStrength() {
  var key = tasteProfileState && tasteProfileState.strength;
  return TASTE_STRENGTHS[key] ? key : 'standard';
}

// 与 07-search.js 的 simpleSearchNorm 同语义，这里自带一份：档案存量 key 必须稳定，
// 不能因为那个函数哪天改了实现就让导入进来的几千条全部对不上。
function tasteNormalizeText(text) {
  var raw = String(text == null ? '' : text);
  if (raw.normalize) raw = raw.normalize('NFKC');
  return raw.toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
}

function tasteIsNoiseArtist(part) {
  return !part || part.length < 1 || /^(unknown|未知|no name|无名)$/.test(part);
}

// 「周杰伦 / 费玉清」「A, B」「X feat. Y」拆成逐个歌手
function tasteArtistParts(artist) {
  var out = [];
  String(artist == null ? '' : artist)
    .split(/\s*\/\s*|\s*,\s*|\s*&\s*|、|\s+feat\.?\s+|\s+ft\.?\s+/i)
    .forEach(function (part) {
      var norm = tasteNormalizeText(part);
      if (tasteIsNoiseArtist(norm)) return;
      if (out.indexOf(norm) < 0) out.push(norm);
    });
  return out;
}

function tasteTitleKey(name) {
  return tasteNormalizeText(name);
}

// 证据 → 缩放系数：weight=12 拿满，1 只有四成。用 log 是因为"听第 20 遍"不该比
// "听第 8 遍"再多一倍权重，口味到一定次数就饱和了。
function tasteEvidenceScale(weight) {
  var w = Math.max(0, Number(weight) || 0);
  if (!w) return 0;
  return Math.min(1, 0.4 + 0.6 * Math.log(1 + w) / Math.log(13));
}

function tastePlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tasteEmptyDocument() {
  return {
    version: 1,
    enabled: true,
    strength: 'standard',
    songs: {},
    artists: {},
    sources: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

// localStorage 与磁盘都算不可信输入：坏条目在入口丢掉，不留到匹配时再炸。
function tasteNormalizeDocument(value) {
  var src = tastePlainObject(value) ? value : null;
  if (!src) return tasteEmptyDocument();
  var doc = tasteEmptyDocument();
  doc.enabled = src.enabled !== false;
  doc.strength = TASTE_STRENGTHS[src.strength] ? String(src.strength) : 'standard';
  doc.createdAt = Math.max(0, Number(src.createdAt) || 0);
  doc.updatedAt = Math.max(0, Number(src.updatedAt) || 0);
  Object.keys(tastePlainObject(src.songs) ? src.songs : {}).slice(0, 6000).forEach(function (key) {
    var entry = src.songs[key];
    if (!tastePlainObject(entry)) return;
    var name = String(entry.name == null ? key : entry.name).slice(0, 120);
    var normKey = tasteTitleKey(name);
    var weight = Math.max(0, Math.min(200, Number(entry.weight) || 0));
    if (!normKey || !weight) return;
    var artists = [];
    var rawArtists = Array.isArray(entry.artists)
      ? entry.artists
      : (entry.artist ? tasteArtistParts(entry.artist) : []);
    rawArtists.forEach(function (part) {
      var norm = tasteNormalizeText(part);
      if (tasteIsNoiseArtist(norm) || artists.indexOf(norm) >= 0) return;
      if (artists.length < 6) artists.push(norm);
    });
    doc.songs[normKey] = {
      key: normKey,
      name: name,
      artists: artists,
      weight: weight,
      hits: Math.max(0, Math.min(9999, Math.round(Number(entry.hits) || 0))),
      sources: tasteNormalizeSourceCounts(entry.sources),
      addedAt: Math.max(0, Number(entry.addedAt) || 0),
    };
  });
  Object.keys(tastePlainObject(src.artists) ? src.artists : {}).slice(0, 1200).forEach(function (key) {
    var entry = src.artists[key];
    if (!tastePlainObject(entry)) return;
    var name = String(entry.name == null ? key : entry.name).slice(0, 120);
    var normKey = tasteNormalizeText(name);
    var weight = Math.max(0, Math.min(200, Number(entry.weight) || 0));
    if (!normKey || !weight) return;
    doc.artists[normKey] = {
      name: name,
      weight: weight,
      hits: Math.max(0, Math.min(9999, Math.round(Number(entry.hits) || 0))),
      sources: tasteNormalizeSourceCounts(entry.sources),
      addedAt: Math.max(0, Number(entry.addedAt) || 0),
    };
  });
  Object.keys(tastePlainObject(src.sources) ? src.sources : {}).slice(0, 60).forEach(function (id) {
    var entry = src.sources[id];
    if (!tastePlainObject(entry)) return;
    var kind = entry.kind === 'playlist' ? 'playlist' : (entry.kind === 'file' ? 'file' : '');
    if (!kind) return;
    doc.sources[String(id).slice(0, 64)] = {
      id: String(id).slice(0, 64),
      kind: kind,
      label: String(entry.label || '').slice(0, 80),
      provider: String(entry.provider || '').slice(0, 24),
      count: Math.max(0, Math.round(Number(entry.count) || 0)),
      addedAt: Math.max(0, Number(entry.addedAt) || 0),
    };
  });
  return doc;
}

function tasteNormalizeSourceCounts(value) {
  var out = {};
  Object.keys(tastePlainObject(value) ? value : {}).slice(0, 12).forEach(function (id) {
    var count = Math.max(0, Math.min(9999, Math.round(Number(value[id]) || 0)));
    if (count) out[String(id).slice(0, 64)] = count;
  });
  return out;
}

// ---------- 落盘：localStorage 同步写，userData 那份异步镜像 ----------

function tasteBridge() {
  if (typeof window === 'undefined') return null;
  if (window.desktopMods && typeof window.desktopMods.readTasteProfile === 'function') {
    return window.desktopMods;
  }
  if (window.desktopWindow && typeof window.desktopWindow.readTasteProfile === 'function') {
    return window.desktopWindow;
  }
  return null;
}

function tasteWriteLocal(profile) {
  try {
    localStorage.setItem(TASTE_PROFILE_STORE_KEY, JSON.stringify(profile));
  } catch (e) { }
}

// 落盘失败要说出来（与 Ctrl+H 存档同一个道理：不能让用户以为有备份）。
function tastePersistDocument(profile) {
  tasteWriteLocal(profile);
  var bridge = tasteBridge();
  if (!bridge) {
    tasteProfileSaveError = '';
    return Promise.resolve({ ok: true, disk: false });
  }
  try {
    return Promise.resolve(bridge.saveTasteProfile(profile)).then(function (res) {
      if (res && res.ok) {
        tasteProfileSaveError = res.dropped ? ('TASTE_DISK_TRIMMED:' + res.dropped) : '';
        return { ok: true, disk: true, dropped: res.dropped || 0 };
      }
      tasteProfileSaveError = (res && res.error) || 'TASTE_SAVE_FAILED';
      return { ok: false, disk: true, error: tasteProfileSaveError };
    }, function (e) {
      tasteProfileSaveError = String((e && e.message) || e || 'TASTE_SAVE_FAILED');
      return { ok: false, disk: true, error: tasteProfileSaveError };
    });
  } catch (e) {
    tasteProfileSaveError = String((e && e.message) || e || 'TASTE_SAVE_FAILED');
    return Promise.resolve({ ok: false, disk: false, error: tasteProfileSaveError });
  }
}

function tasteSaveProfile() {
  tasteProfileState.updatedAt = Date.now();
  tasteViewCache.signature = '';
  tasteWriteLocal(tasteProfileState);
  if (tasteProfileSaveTimer) clearTimeout(tasteProfileSaveTimer);
  tasteProfileSaveTimer = setTimeout(function () {
    tasteProfileSaveTimer = 0;
    tastePersistDocument(tasteProfileState);
  }, 420);
}

// 开机时磁盘那份可能比 localStorage 新（换过缓存目录、清过缓存、手改过文件）。
// 谁的 updatedAt 大用谁；localStorage 更新时反过来推回磁盘，别让两份长期各走各的。
function tasteHydrateFromDisk() {
  var bridge = tasteBridge();
  if (!bridge) return Promise.resolve({ ok: true, source: 'local' });
  return Promise.resolve(bridge.readTasteProfile()).then(function (res) {
    if (!res || !res.ok || !res.document) {
      return { ok: false, source: 'local', error: (res && res.error) || 'TASTE_READ_FAILED' };
    }
    var disk = tasteNormalizeDocument(res.document);
    var localCount = Object.keys(tasteProfileState.songs || {}).length;
    var diskCount = Object.keys(disk.songs || {}).length;
    if (disk.updatedAt > (tasteProfileState.updatedAt || 0) || diskCount > localCount) {
      tasteProfileState = disk;
      tasteWriteLocal(tasteProfileState);
      tasteViewCache.signature = '';
      return { ok: true, source: 'disk' };
    }
    if (localCount || tasteProfileState.updatedAt) {
      return tastePersistDocument(tasteProfileState).then(function () { return { ok: true, source: 'local' }; });
    }
    return { ok: true, source: 'empty' };
  }, function (e) {
    return { ok: false, source: 'local', error: String((e && e.message) || e) };
  });
}

// ---------- 本机聆听：现建索引，档案里不存副本 ----------

function tasteListenSignature() {
  var st = (typeof listenStatsState !== 'undefined' && listenStatsState) || {};
  var songs = tastePlainObject(st.songs) ? st.songs : {};
  var artists = tastePlainObject(st.artists) ? st.artists : {};
  return String(st.updatedAt || 0) + ':' + Object.keys(songs).length + ':' + Object.keys(artists).length;
}

function tasteProfileSignature() {
  return String((tasteProfileState && tasteProfileState.updatedAt) || 0)
    + ':' + Object.keys((tasteProfileState && tasteProfileState.songs) || {}).length
    + ':' + Object.keys((tasteProfileState && tasteProfileState.artists) || {}).length
    + ':' + tasteStrength();
}

function tasteBuildListenIndex() {
  var st = (typeof listenStatsState !== 'undefined' && listenStatsState) || {};
  var index = { songs: {}, artists: {} };
  Object.keys(tastePlainObject(st.songs) ? st.songs : {}).forEach(function (key) {
    var entry = st.songs[key] || {};
    var titleKey = tasteTitleKey(entry.name);
    if (!titleKey) return;
    var plays = Math.max(0, Number(entry.plays) || 0);
    // 听完一遍比开播一遍更是喜欢
    var weight = plays + Math.max(0, Number(entry.completed) || 0) * 0.5;
    if (!weight) return;
    var song = index.songs[titleKey] || { name: String(entry.name || '').slice(0, 120), artists: [], weight: 0, hits: 0 };
    song.weight = Math.max(song.weight, weight);
    song.hits += plays;
    tasteArtistParts(entry.artist).forEach(function (part) {
      if (part && song.artists.indexOf(part) < 0 && song.artists.length < 6) song.artists.push(part);
    });
    index.songs[titleKey] = song;
  });
  Object.keys(tastePlainObject(st.artists) ? st.artists : {}).forEach(function (name) {
    var entry = st.artists[name] || {};
    var norm = tasteNormalizeText(name);
    var plays = Math.max(0, Number(entry.plays) || 0);
    if (!norm || !plays) return;
    var artist = index.artists[norm] || { name: String(name || '').slice(0, 120), weight: 0, hits: 0 };
    artist.weight = Math.max(artist.weight, plays);
    artist.hits += plays;
    index.artists[norm] = artist;
  });
  return index;
}

function tasteMergeEntry(target, source, from) {
  if (!source) return target;
  var out = target || { name: '', weight: 0, hits: 0, artists: [], sources: {}, inProfile: false, inListen: false };
  out.weight = Math.max(out.weight, Number(source.weight) || 0);
  out.hits = Math.max(out.hits, Number(source.hits) || 0);
  (source.artists || []).forEach(function (part) {
    if (part && out.artists.indexOf(part) < 0 && out.artists.length < 8) out.artists.push(part);
  });
  Object.keys(source.sources || {}).forEach(function (id) { out.sources[id] = source.sources[id]; });
  if (!out.name && source.name) out.name = source.name;
  if (from === 'profile') out.inProfile = true; else out.inListen = true;
  return out;
}

// 档案 + 聆听合成一份匹配视图；两边签名都没变就直接复用上一份。
function tasteView() {
  var signature = tasteProfileSignature() + '|' + tasteListenSignature();
  if (tasteViewCache.signature === signature) return tasteViewCache;
  var view = { signature: signature, songs: {}, artists: {}, artistKeys: [] };
  try {
    var profile = tasteProfileState || tasteEmptyDocument();
    Object.keys(profile.artists || {}).forEach(function (key) {
      view.artists[key] = tasteMergeEntry(view.artists[key], profile.artists[key], 'profile');
    });
    Object.keys(profile.songs || {}).forEach(function (key) {
      view.songs[key] = tasteMergeEntry(view.songs[key], profile.songs[key], 'profile');
    });
    var listen = tasteBuildListenIndex();
    Object.keys(listen.artists).forEach(function (key) {
      view.artists[key] = tasteMergeEntry(view.artists[key], listen.artists[key], 'listen');
    });
    Object.keys(listen.songs).forEach(function (key) {
      view.songs[key] = tasteMergeEntry(view.songs[key], listen.songs[key], 'listen');
    });
    // 互相包含的写法（"周杰伦" vs "jaychou周杰伦"）要能在候选里找到，按铁的程度排序后封顶
    view.artistKeys = Object.keys(view.artists).sort(function (a, b) {
      return view.artists[b].weight - view.artists[a].weight;
    }).slice(0, TASTE_ARTIST_FUZZY_LIMIT);
  } catch (e) {
    console.warn('[TasteView]', e);
  }
  tasteViewCache = view;
  return tasteViewCache;
}

function tasteHasData() {
  var view = tasteView();
  return Object.keys(view.songs).length > 0 || Object.keys(view.artists).length > 0;
}

function tasteFindArtistEntry(view, parts, resolved) {
  var best = null;
  parts.forEach(function (part) {
    if (!part) return;
    if (!(part in resolved)) {
      var entry = view.artists[part] || null;
      if (!entry) {
        // 精确名没命中才在最铁的 300 位里找互相包含的写法
        for (var i = 0; i < view.artistKeys.length; i++) {
          var key = view.artistKeys[i];
          if (key === part || key.indexOf(part) >= 0 || part.indexOf(key) >= 0) { entry = view.artists[key]; break; }
        }
      }
      resolved[part] = entry || null;
    }
    var hit = resolved[part];
    if (hit && (!best || hit.weight > best.weight)) best = hit;
  });
  return best;
}

function tasteArtistsOverlap(stored, parts) {
  var list = stored || [];
  for (var i = 0; i < list.length; i++) {
    var storedPart = list[i];
    if (!storedPart) continue;
    for (var k = 0; k < parts.length; k++) {
      var candidate = parts[k];
      if (!candidate) continue;
      if (storedPart === candidate || storedPart.indexOf(candidate) >= 0 || candidate.indexOf(storedPart) >= 0) return true;
    }
  }
  return false;
}

// 来源名要说人话：文件来源写"导入自 xx.txt"，平台歌单写"在你的收藏里"。
function tasteSourceLabel(sources, kind) {
  var ids = Object.keys(sources || {});
  if (!ids.length) return '';
  var profile = tasteProfileState || tasteEmptyDocument();
  for (var i = 0; i < ids.length; i++) {
    var src = (profile.sources || {})[ids[i]];
    if (!src) continue;
    if (src.kind === 'file') return '导入自 ' + (src.label || '文件');
    if (src.kind === 'playlist') return '在你的收藏里';
  }
  return kind === 'song' ? '在你的收藏里' : '收藏的歌手';
}

function tasteReasonLabel(match) {
  if (!match) return '';
  if (match.kind === 'song') {
    if (match.sourceLabel) return match.sourceLabel;
    if (match.inProfile) return '在你的收藏里';
    if (match.hits >= 2) return '听过 ' + match.hits + ' 次';
    return '听过';
  }
  if (match.kind === 'artist') {
    if (match.sourceLabel) return match.sourceLabel;
    if (match.inProfile) return '收藏的歌手';
    if (match.hits >= 5) return '常听歌手';
    return '听过这位';
  }
  if (match.kind === 'title') return '你听过这首歌';
  return '';
}

function tasteReasonDetail(match) {
  if (!match) return '';
  var strength = TASTE_STRENGTHS[tasteStrength()] || TASTE_STRENGTHS.standard;
  var bits = [];
  if (match.kind === 'song') bits.push('标题与歌手都在你的口味里');
  else if (match.kind === 'artist') bits.push('这位歌手在你的口味里（' + (match.name || '') + '）');
  else bits.push('这首歌你听过，当前结果是别的版本');
  if (match.inListen && match.hits) bits.push('本机听过 ' + match.hits + ' 次');
  if (match.inProfile) bits.push('来源：' + (match.sourceLabel || '导入/收藏'));
  bits.push('加 ' + Math.round(match.bonus) + ' 分（' + strength.label + '档上限 ' + strength.cap + '）');
  return bits.join(' · ');
}

function tasteMatchSong(song, view, resolved) {
  if (!song || !song.name) return null;
  var parts = tasteArtistParts(song.artist);
  var songEntry = view.songs[tasteTitleKey(song.name)] || null;
  var artistEntry = tasteFindArtistEntry(view, parts, resolved);
  var match = null;
  if (songEntry) {
    var overlap = tasteArtistsOverlap(songEntry.artists, parts);
    match = {
      // 标题精确相等但歌手对不上 = 你听的是另一个版本。这类不能给足分量：
      // merge 里翻唱本来就要沉底，口味只把它抬回"别按 -46 打死"的程度。
      kind: overlap ? 'song' : 'title',
      weight: overlap ? songEntry.weight : Math.min(songEntry.weight, 6),
      hits: songEntry.hits,
      inProfile: songEntry.inProfile,
      inListen: songEntry.inListen,
      sources: songEntry.sources,
      name: songEntry.name,
    };
  }
  // 歌手这一路只有在"这首歌本身没命中"时才当主理由，否则会把已经命中的歌改口成"常听歌手"
  if (!match && artistEntry) {
    match = {
      kind: 'artist',
      weight: artistEntry.weight,
      hits: artistEntry.hits,
      inProfile: artistEntry.inProfile,
      inListen: artistEntry.inListen,
      sources: artistEntry.sources,
      name: artistEntry.name,
    };
  }
  if (!match) return null;
  var strength = TASTE_STRENGTHS[tasteStrength()] || TASTE_STRENGTHS.standard;
  var base = match.kind === 'song' ? strength.song : (match.kind === 'artist' ? strength.artist : strength.title);
  match.bonus = Math.min(strength.cap, base * tasteEvidenceScale(match.weight));
  match.sourceLabel = tasteSourceLabel(match.sources, match.kind);
  match.label = tasteReasonLabel(match);
  return match;
}

// ---------- 接进搜索：merge 之后加一层，原分数一分不改 ----------

function tasteSearchEnabled() {
  return !!(tasteProfileState && tasteProfileState.enabled !== false);
}

function applyTasteSearchBoost(songs) {
  var list = Array.isArray(songs) ? songs : [];
  if (!list.length) return list;
  if (!tasteSearchEnabled()) {
    // 关掉时连已有标记一起抹掉，否则上一轮的徽章还挂在行上
    list.forEach(tasteClearMarks);
    return list;
  }
  var view = tasteView();
  if (!tasteHasData()) return list;
  var resolved = {};
  var touched = 0;
  var otherMaxByTitle = {};
  list.forEach(function (song) {
    var match = tasteMatchSong(song, view, resolved);
    if (!match || !match.bonus) {
      tasteClearMarks(song);
      var tk0 = tasteTitleKey(song && song.name);
      if (tk0) {
        var s0 = Number(song && song._searchScore) || 0;
        if (otherMaxByTitle[tk0] == null || s0 > otherMaxByTitle[tk0]) otherMaxByTitle[tk0] = s0;
      }
      return;
    }
    touched += 1;
    song._tasteBonus = Math.round(match.bonus * 100) / 100;
    song._tasteScore = (Number(song._searchScore) || 0) + song._tasteBonus;
    song._tasteKind = match.kind;
    song._tasteReason = match.label || '';
    song._tasteDetail = tasteReasonDetail(match);
    var tk = tasteTitleKey(song && song.name);
    if (tk && match.kind !== 'song') {
      if (otherMaxByTitle[tk] == null || song._tasteScore > otherMaxByTitle[tk]) {
        otherMaxByTitle[tk] = song._tasteScore;
      }
    }
  });
  if (!touched) return list;

  // 版本优先：同名版本（如都叫「晴天」）里，档案里明确有的这首歌（song 级命中）
  // 应当优先于翻唱或垃圾同名行排在最前。给它继承同名组内非 song 版本的最高分，
  // 这样不论翻唱因为热度虚高出多少分，你的版本都在本组第一位。
  list.forEach(function (song) {
    var tk = tasteTitleKey(song && song.name);
    var otherMax = tk ? otherMaxByTitle[tk] : null;
    if (song && song._tasteKind === 'song' && otherMax != null && otherMax >= (song._tasteScore || 0)) {
      song._tasteSortScore = otherMax + (song._tasteBonus || 1);
    } else {
      song._tasteSortScore = song ? (song._tasteScore || song._searchScore || 0) : 0;
    }
  });

  list.sort(function (a, b) {
    var as = a && (a._tasteSortScore != null ? a._tasteSortScore : (a._tasteScore || a._searchScore)) || 0;
    var bs = b && (b._tasteSortScore != null ? b._tasteSortScore : (b._tasteScore || b._searchScore)) || 0;
    if (bs !== as) return bs - as;
    var at = a && (a._tasteScore || a._searchScore) || 0;
    var bt = b && (b._tasteScore || b._searchScore) || 0;
    if (bt !== at) return bt - at;
    return (b && b._searchScore || 0) - (a && a._searchScore || 0);
  });
  return list;
}

function tasteClearMarks(song) {
  if (!song) return;
  song._tasteBonus = 0;
  song._tasteScore = Number(song._searchScore) || 0;
  song._tasteSortScore = Number(song._searchScore) || 0;
  song._tasteKind = '';
  song._tasteReason = '';
  song._tasteDetail = '';
}

function searchTasteTagHtml(song) {
  if (!song || !song._tasteReason || !tasteSearchEnabled()) return '';
  return '<span class="tag-taste ' + escHtml(song._tasteKind || '') + '" title="'
    + escHtml(song._tasteDetail || song._tasteReason) + '">' + escHtml(song._tasteReason) + '</span>';
}

// 开关与强度改完，界面上已经画出来的那批结果要立刻换个说法：重排现成的列表，
// 不再打一次接口（搜索记录与翻页游标都还在原处）。
function tasteRerankOpenSearchResults() {
  try {
    if (typeof searchMusicRenderState === 'undefined') return false;
    var songs = searchMusicRenderState && searchMusicRenderState.songs;
    if (!Array.isArray(songs) || !songs.length) return false;
    applyTasteSearchBoost(songs);
    if (!tasteSearchEnabled()) {
      songs.sort(function (a, b) { return (Number(b._searchScore) || 0) - (Number(a._searchScore) || 0); });
    }
    // 行索引直接取 playlist，两边必须还是同一个数组引用
    if (typeof playlist !== 'undefined') playlist = songs;
    searchMusicRenderState.songs = songs;
    if (typeof rerenderSongSearchRows === 'function') rerenderSongSearchRows();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 导入文件 ----------

function tasteCleanTitle(text) {
  return String(text == null ? '' : text)
    .replace(/^\s*\d{1,3}\s*[-.、)]\s*/, '')
    .replace(/\s*\[(?:MV|mv|live|Live|现场|FLAC|flac|320|ape|高品|无损)\]\s*$/i, '')
    .replace(/\.(mp3|flac|m4a|aac|wav|ogg|wma|opus|mp4)$/i, '')
    .trim();
}

function tasteSplitLine(line, bareAsTitle) {
  var text = tasteCleanTitle(line);
  if (!text) return null;
  var m = /^([^\-–—]{1,80})\s+[-–—]\s+(.{1,120})$/.exec(text);
  if (m && m[1].trim() && m[2].trim()) {
    return { name: m[2].trim().slice(0, 120), artist: m[1].trim().slice(0, 120), keyword: '' };
  }
  // 没有「歌手 - 歌名」这个分隔时，两种文件的读法不一样，分开处理：
  //   M3U 那一行是文件名/显示名 → 当歌名收（曲库导出基本都是这样）
  //   手写 TXT 那一行更可能是"我喜欢某某" → 当歌手/关键词收，不造一条没有歌手的假歌
  if (bareAsTitle) return { name: text.slice(0, 120), artist: '', keyword: '' };
  return { name: '', artist: '', keyword: text.slice(0, 120) };
}

// #EXTINF 的显示名各家写法不同：VLC 写「林俊杰 - 她说」，也有导出写「-,林俊杰 - 她说」，
// 先把第一个逗号后面剩下的那截前面挂的 -、, 清掉，再走通用拆分。
function tasteStripExtinfPrefix(rest) {
  return String(rest == null ? '' : rest).replace(/^[-,\s]+/, '').trim();
}

// 只收字符串：Spotify 的 {track:{...}} 里 item.track 是个对象，网易云导出里 item.track
// 经常是音轨序号（数字），两者当"歌名"都会得到一行垃圾，所以数字一律不收。
function tasteFirstText(value) {
  return typeof value === 'string' ? value : '';
}

function tasteJoinArtistNames(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      if (!item) return '';
      return typeof item === 'string' ? item : String(item.name || item.artist || '');
    }).filter(Boolean).join('/');
  }
  return tastePlainObject(value) ? String(value.name || value.artist || '') : '';
}

function tasteRowFromObject(item) {
  if (!tastePlainObject(item)) return null;
  // 候选字段按"最像歌名"排序；track 放最后是因为它在不少导出里是音轨序号
  // （数字 3 当歌名就荒唐了），而 Spotify 的 track 是个对象、走下面的钻壳分支
  var name = tasteFirstText(item.name) || tasteFirstText(item.title) || tasteFirstText(item.song)
    || tasteFirstText(item.songName) || tasteFirstText(item.song_name) || tasteFirstText(item.musicName)
    || tasteFirstText(item.trackName) || tasteFirstText(item.song_title) || tasteFirstText(item.track);
  name = tasteCleanTitle(name);
  if (!name) {
    // 字段名各家不同，先钻一层常见的"歌在里头"壳再认一次
    var nestKeys = ['track', 'song', 'info', 'baseRepo', 'musicInfo', 'entry', 'meta'];
    for (var i = 0; i < nestKeys.length; i++) {
      if (tastePlainObject(item[nestKeys[i]])) return tasteRowFromObject(item[nestKeys[i]]);
    }
    return null;
  }
  var artist = tasteJoinArtistNames(item.artist || item.artists || item.singer || item.singers
    || item.singerName || item.singer_name || item.authorName || item.author_name || item.ar
    || item.artistName || item.artist_name || item.performer || item.interpreter);
  return { name: String(name).slice(0, 120), artist: String(artist || '').slice(0, 120), keyword: '' };
}

var TASTE_JSON_CONTAINER_KEYS = ['items', 'tracks', 'songs', 'list', 'results', 'data', 'body'];

function tasteCollectJsonRows(value, out) {
  if (!value || out.length >= TASTE_IMPORT_ROW_LIMIT) return;
  if (Array.isArray(value)) {
    value.forEach(function (item) { tasteCollectJsonRows(item, out); });
    return;
  }
  if (!tastePlainObject(value)) return;
  // 歌单壳优先：对象里挂着曲目数组时，它自己是"一张歌单"而不是"一首歌"
  // （网易云导出就是 {name:"我的歌单", songs:[...]}，先认名字会得到一行歌单名）
  for (var i = 0; i < TASTE_JSON_CONTAINER_KEYS.length; i++) {
    var bucket = value[TASTE_JSON_CONTAINER_KEYS[i]];
    if (Array.isArray(bucket) && bucket.length) {
      tasteCollectJsonRows(bucket, out);
      return;
    }
  }
  var row = tasteRowFromObject(value);
  if (row && row.name) { out.push(row); return; }
  for (var k = 0; k < TASTE_JSON_CONTAINER_KEYS.length; k++) {
    if (value[TASTE_JSON_CONTAINER_KEYS[k]]) tasteCollectJsonRows(value[TASTE_JSON_CONTAINER_KEYS[k]], out);
  }
}

function tasteSplitCsvLine(line) {
  var cells = [];
  var current = '';
  var quoted = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      current += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',' || ch === '\t' || ch === ';') { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

var TASTE_CSV_NAME_COLS = ['name', 'title', 'track', 'track name', 'track_name', 'song', 'song name', 'song_name',
  'music name', 'music_name', '歌曲名', '歌名', '曲名', '标题', '歌曲', '音乐名'];
var TASTE_CSV_ARTIST_COLS = ['artist', 'artists', 'artist name', 'artist_name', 'performer', 'singer', 'singer name',
  'singer_name', 'author', 'author_name', '歌手', '演唱者', '演唱', '艺术家', '艺人', '作者', '专辑艺人'];

function tasteParseImportText(text, fileName) {
  var raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  var rows = [];
  var skipped = 0;
  var lower = String(fileName || '').toLowerCase();
  var trimmed = raw.trim();
  if (!trimmed) return { rows: rows, skipped: 0, format: 'empty' };

  if (/\.json$/.test(lower) || /^[[{]/.test(trimmed)) {
    try {
      tasteCollectJsonRows(JSON.parse(trimmed), rows);
    } catch (e) {
      return { rows: [], skipped: 1, format: 'json-broken' };
    }
    if (rows.length) return { rows: rows.slice(0, TASTE_IMPORT_ROW_LIMIT), skipped: 0, format: 'json' };
    if (/\.json$/.test(lower)) return { rows: [], skipped: 1, format: 'json-no-song' };
  }

  var lines = trimmed.split(/\r?\n/);
  var isCsv = /\.csv$/.test(lower) || /\.tsv$/.test(lower);
  var isM3u = /\.m3u/.test(lower);
  if (!isCsv && !isM3u) {
    // 没扩展名时靠内容猜：前 12 行里有两行以上带两个逗号，且首行像表头 → CSV
    var commas = lines.slice(0, 12).filter(function (line) { return (line.match(/,/g) || []).length >= 2; }).length;
    if (commas >= 2) isCsv = true;
  }

  if (isM3u) {
    lines.forEach(function (line) {
      var entry = line.trim();
      if (!entry) return;
      if (/^#/.test(entry)) {
        var extinf = /^#EXTINF:[^,]*,(.+)$/i.exec(entry);
        var tagged = extinf ? tasteSplitLine(tasteStripExtinfPrefix(extinf[1]), true) : null;
        if (tagged && tagged.name) rows.push(tagged);
        return;
      }
      var base = entry.replace(/\\/g, '/').split('/').pop();
      var row = tasteSplitLine(base, true);
      if (row && row.name) rows.push(row); else skipped += 1;
    });
    return { rows: rows.slice(0, TASTE_IMPORT_ROW_LIMIT), skipped: skipped, format: 'm3u' };
  }

  if (isCsv) {
    var header = tasteSplitCsvLine(lines[0]).map(function (cell) { return cell.toLowerCase(); });
    var nameIdx = -1, artistIdx = -1;
    header.forEach(function (cell, i) {
      if (nameIdx < 0 && TASTE_CSV_NAME_COLS.indexOf(cell) >= 0) nameIdx = i;
      if (artistIdx < 0 && TASTE_CSV_ARTIST_COLS.indexOf(cell) >= 0) artistIdx = i;
    });
    // 认不出歌名列就不导，不猜位置：没有表头的 CSV，第 0 列可能是歌名、可能是序号或专辑名，
    // 猜错会把几千行垃圾灌进档案。面板里已经写明"CSV 要有表头"，纯清单请用 TXT 一行一条。
    if (nameIdx < 0) return { rows: [], skipped: lines.length, format: 'csv-no-name' };
    // 认出歌名列就说明第 0 行是表头，那一行本身不是歌
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var cells = tasteSplitCsvLine(lines[i]);
      var name = tasteCleanTitle(cells[nameIdx] || '');
      // 认不出歌手列就只记歌名，不猜"第二列大概是歌手"：那一列经常是专辑或年份，
      // 猜错会让这首歌在匹配时降级成"同名不同人"，比空着更糟。
      var artist = artistIdx >= 0 ? String(cells[artistIdx] || '') : '';
      if (!name) { skipped += 1; continue; }
      rows.push({ name: name.slice(0, 120), artist: artist.slice(0, 120), keyword: '' });
      if (rows.length >= TASTE_IMPORT_ROW_LIMIT) break;
    }
    return { rows: rows, skipped: skipped, format: 'csv' };
  }

  lines.forEach(function (line) {
    var entry = line.trim();
    if (!entry || /^#/.test(entry)) return;
    var row = tasteSplitLine(entry);
    if (!row) { skipped += 1; return; }
    if (row.name) rows.push(row); else rows.push(row);
  });
  return { rows: rows.slice(0, TASTE_IMPORT_ROW_LIMIT), skipped: skipped, format: 'text' };
}

// ---------- 写档案 ----------

// 一条曲目挂的来源数封顶：来源表本身只留最近 60 个，但一条被 200 个来源供过的歌
// 会把 JSON 撑成"每条几千字节"，落盘与 localStorage 都遭殃。留贡献最大的那几个。
function tasteCapEntrySources(entry, limit) {
  var ids = Object.keys(entry.sources || {});
  if (ids.length <= limit) return;
  ids.sort(function (a, b) { return (entry.sources[b] || 0) - (entry.sources[a] || 0); });
  var kept = {};
  ids.slice(0, limit).forEach(function (id) { kept[id] = entry.sources[id]; });
  entry.sources = kept;
}

function tasteMergeSongEntry(profile, titleKey, name, parts, weight, sourceId) {
  var entry = profile.songs[titleKey] || {
    key: titleKey, name: String(name || '').slice(0, 120), artists: [], weight: 0, hits: 0, sources: {}, addedAt: Date.now(),
  };
  parts.forEach(function (part) {
    if (entry.artists.indexOf(part) < 0 && entry.artists.length < 6) entry.artists.push(part);
  });
  entry.name = entry.name || String(name || '').slice(0, 120);
  entry.weight = Math.min(200, (Number(entry.weight) || 0) + weight);
  entry.hits = Math.min(9999, (Number(entry.hits) || 0) + 1);
  if (sourceId) entry.sources[sourceId] = Math.min(9999, (entry.sources[sourceId] || 0) + 1);
  tasteCapEntrySources(entry, 12);
  profile.songs[titleKey] = entry;
  return true;
}

function tasteMergeArtistEntry(profile, artistText, sourceId, weight) {
  tasteArtistParts(artistText).forEach(function (part) {
    var entry = profile.artists[part] || { name: String(artistText || '').slice(0, 120), weight: 0, hits: 0, sources: {}, addedAt: Date.now() };
    entry.weight = Math.min(200, (Number(entry.weight) || 0) + weight);
    entry.hits = Math.min(9999, (Number(entry.hits) || 0) + 1);
    if (sourceId) entry.sources[sourceId] = Math.min(9999, (entry.sources[sourceId] || 0) + 1);
    tasteCapEntrySources(entry, 12);
    profile.artists[part] = entry;
  });
}

function tasteIngestRows(profile, rows, source) {
  // 歌与歌手给的权重不同：收藏里出现一首歌 = "这首歌我要"，一位歌手出现只是"N 首的可能"。
  // 平台收藏比手写的 TXT 清单更是明确表态，所以 kind 决定基准分。
  var songWeight = source.kind === 'playlist' ? 2 : 1.2;
  var artistWeight = source.kind === 'playlist' ? 0.7 : 0.5;
  var addedSongs = 0, addedArtists = 0, skipped = 0;
  var seenKeyword = {};
  (rows || []).forEach(function (row) {
    if (!row) { skipped += 1; return; }
    if (!row.name && row.keyword) {
      var norm = tasteNormalizeText(row.keyword);
      if (!norm || seenKeyword[norm]) { skipped += 1; return; }
      seenKeyword[norm] = true;
      tasteMergeArtistEntry(profile, row.keyword, source.id, artistWeight * 2);
      addedArtists += 1;
      return;
    }
    var titleKey = tasteTitleKey(row.name);
    if (!titleKey) { skipped += 1; return; }
    tasteMergeSongEntry(profile, titleKey, row.name, tasteArtistParts(row.artist), songWeight, source.id);
    addedSongs += 1;
    if (row.artist) tasteMergeArtistEntry(profile, row.artist, source.id, artistWeight);
  });
  profile.sources[source.id] = {
    id: String(source.id).slice(0, 64),
    kind: source.kind,
    label: String(source.label || '').slice(0, 80),
    provider: String(source.provider || '').slice(0, 24),
    count: Math.max(0, Math.round(Number(source.count) || (rows || []).length)),
    addedAt: Date.now(),
  };
  return { addedSongs: addedSongs, addedArtists: addedArtists, skipped: skipped };
}

function tasteTrimDocument(profile) {
  [['songs', 6000], ['artists', 1200]].forEach(function (pair) {
    var field = pair[0], limit = pair[1];
    var keys = Object.keys(profile[field] || {});
    if (keys.length <= limit) return;
    keys.sort(function (a, b) {
      return (profile[field][b].weight - profile[field][a].weight)
        || ((profile[field][b].addedAt || 0) - (profile[field][a].addedAt || 0));
    });
    var out = {};
    keys.slice(0, limit).forEach(function (key) { out[key] = profile[field][key]; });
    profile[field] = out;
  });
  var sourceKeys = Object.keys(profile.sources || {});
  if (sourceKeys.length > 60) {
    sourceKeys.sort(function (a, b) { return (profile.sources[b].addedAt || 0) - (profile.sources[a].addedAt || 0); });
    var keep = {};
    sourceKeys.slice(0, 60).forEach(function (key) { keep[key] = profile.sources[key]; });
    profile.sources = keep;
  }
}

function tasteApplyRows(rows, source) {
  var profile = tasteProfileState || tasteEmptyDocument();
  var result = tasteIngestRows(profile, rows, source);
  tasteTrimDocument(profile);
  tasteProfileState = profile;
  tasteSaveProfile();
  tasteRecount();
  return result;
}

function tasteFileSourceId(file) {
  return 'file:' + String((file && file.name) || '').slice(0, 64) + ':' + (Number(file && file.size) || 0);
}

function tasteReadFile(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || '')); };
    reader.onerror = function () { reject(new Error('文件读不出来')); };
    reader.readAsText(file, 'utf-8');
  });
}

async function tasteHandleFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return tasteImportSummary;
  var summary = { files: 0, songs: 0, skipped: 0, format: '' };
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    try {
      var text = await tasteReadFile(file);
      var parsed = tasteParseImportText(text, file.name);
      if (!parsed.rows.length) {
        summary.skipped += 1;
        tasteToast('「' + file.name + '」没认出歌曲（格式判成 ' + (parsed.format || '未知')
          + '）。TXT 要一行一条「歌手 - 歌名」，CSV 要有歌名列，JSON 要带歌名与歌手。');
        continue;
      }
      var result = tasteApplyRows(parsed.rows, {
        id: tasteFileSourceId(file), kind: 'file', label: String(file.name || '').slice(0, 80), provider: '', count: parsed.rows.length,
      });
      summary.files += 1;
      summary.songs += result.addedSongs;
      summary.skipped += parsed.skipped + result.skipped;
      summary.format = parsed.format;
    } catch (e) {
      summary.skipped += 1;
      tasteToast('「' + file.name + '」失败：' + String((e && e.message) || e));
    }
  }
  tasteImportSummary = summary;
  if (summary.files) {
    tasteToast('口味档案加了 ' + summary.songs + ' 首（来自 ' + summary.files + ' 个文件）'
      + (summary.skipped ? '，跳掉 ' + summary.skipped + ' 行认不出的' : ''));
    tasteRerankOpenSearchResults();
  }
  renderTasteModal();
  return summary;
}

// ---------- 连接平台：拉歌单列表 → 勾选 → 分页拉曲目 ----------

var TASTE_CONNECTABLE_PROVIDERS = ['netease', 'qq', 'kugou', 'qishui', 'spotify'];

function tasteProviderLoggedIn(provider) {
  try {
    if (typeof searchProviderIsLoggedIn === 'function') return !!searchProviderIsLoggedIn(provider);
  } catch (e) { }
  try {
    if (provider === 'netease') return !!(typeof loginStatus === 'object' && loginStatus && loginStatus.loggedIn);
    if (provider === 'qq') return !!(typeof qqLoginStatus === 'object' && qqLoginStatus && qqLoginStatus.loggedIn);
    if (provider === 'kugou') return !!(typeof kugouLoginStatus === 'object' && kugouLoginStatus && kugouLoginStatus.loggedIn);
    if (provider === 'qishui') return !!(typeof qishuiLoginStatus === 'object' && qishuiLoginStatus && qishuiLoginStatus.loggedIn);
    if (provider === 'spotify') return !!(typeof spotifyLoginStatus === 'object' && spotifyLoginStatus && spotifyLoginStatus.loggedIn);
  } catch (e) { }
  return false;
}

function tasteProviderLabel(provider) {
  try {
    if (typeof platformMeta === 'function') {
      var meta = platformMeta(provider);
      if (meta && meta.label) return meta.label;
    }
  } catch (e) { }
  return provider === 'netease' ? '网易云'
    : (provider === 'qq' ? 'QQ 音乐'
      : (provider === 'kugou' ? '酷狗'
        : (provider === 'qishui' ? '汽水' : (provider === 'spotify' ? 'Spotify' : provider))));
}

function tastePlaylistsUrl(provider, offset, limit) {
  if (provider === 'netease') return '/api/user/playlists?paged=1&limit=' + limit + '&offset=' + offset;
  if (provider === 'spotify') return '/api/spotify/user/playlists?limit=' + Math.min(50, limit) + '&offset=' + offset;
  if (provider === 'qq') return '/api/qq/user/playlists';
  if (provider === 'kugou') return '/api/kugou/user/playlists';
  if (provider === 'qishui') return '/api/qishui/user/playlists';
  return '';
}

function tasteTracksUrl(provider, id, offset, limit) {
  var query = 'id=' + encodeURIComponent(id) + '&limit=' + limit + '&offset=' + offset;
  if (provider === 'qq') return '/api/qq/playlist/tracks?' + query;
  // 酷狗那侧一页最多 50，写死在 URL 里，别把 100 递过去让它自己截
  if (provider === 'kugou') return '/api/kugou/playlist/tracks?id=' + encodeURIComponent(id) + '&limit=50&offset=' + offset;
  if (provider === 'qishui') return '/api/qishui/playlist/tracks?' + query;
  if (provider === 'spotify') return '/api/spotify/playlist/tracks?' + query;
  return '/api/playlist/tracks?' + query;
}

async function tasteLoadProviderPlaylists(provider) {
  tasteProviderImportState = { provider: provider, loading: true, error: '', playlists: [], picked: {}, busy: false, progress: '' };
  renderTasteModal();
  var collected = [];
  var seen = {};
  try {
    var offset = 0;
    for (var page = 0; page < 8; page++) {
      var url = tastePlaylistsUrl(provider, offset, 50);
      if (!url) break;
      var res = await apiJson(url, { timeoutMs: 15000 });
      var list = (res && Array.isArray(res.playlists)) ? res.playlists : [];
      list.forEach(function (pl) {
        var key = String((pl && pl.id) || '');
        if (!key || seen[key]) return;
        seen[key] = true;
        collected.push({
          id: key,
          name: String((pl && pl.name) || '未命名歌单').slice(0, 80),
          trackCount: Math.max(0, Number(pl && pl.trackCount) || 0),
          creator: String((pl && pl.creator) || '').slice(0, 60),
          subscribed: !!(pl && pl.subscribed),
        });
      });
      var next = res && res.nextOffset != null ? Number(res.nextOffset) : offset + list.length;
      if (!list.length || (res && res.hasMore === false) || next <= offset) break;
      offset = next;
    }
    if (!collected.length) tasteProviderImportState.error = '这个账号下没读到歌单（账号里确实没有，或登录态弱到读不了私有数据）';
    // 默认全勾，但 >800 首的不默认勾：一次拉进来会把档案撑满
    var picked = {};
    collected.forEach(function (pl) { if (pl.trackCount <= 800) picked[pl.id] = true; });
    tasteProviderImportState = { provider: provider, loading: false, error: tasteProviderImportState.error, playlists: collected, picked: picked, busy: false, progress: '' };
  } catch (e) {
    tasteProviderImportState = {
      provider: provider, loading: false, playlists: [], picked: {}, busy: false,
      error: String((e && e.message) || e || '歌单读取失败'), progress: '',
    };
  }
  renderTasteModal();
  return tasteProviderImportState;
}

function tasteTrackRow(track) {
  if (!tastePlainObject(track)) return null;
  var name = tasteCleanTitle(track.name || track.title || '');
  if (!name) return null;
  var artist = track.artist || track.singer || '';
  if (!artist && Array.isArray(track.artists)) artist = track.artists.map(function (a) { return a && a.name; }).filter(Boolean).join('/');
  return { name: String(name).slice(0, 120), artist: String(artist || '').slice(0, 120), keyword: '' };
}

async function tasteImportSelectedPlaylists() {
  var state = tasteProviderImportState;
  if (!state.provider || state.busy) return { added: 0 };
  var ids = Object.keys(state.picked || {}).filter(function (id) { return state.picked[id]; });
  if (!ids.length) { tasteToast('先勾上要导入的歌单'); return { added: 0 }; }
  state.busy = true;
  var totalAdded = 0;
  var profile = tasteProfileState || tasteEmptyDocument();
  var failedNames = [];
  try {
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var meta = (state.playlists || []).filter(function (pl) { return String(pl.id) === String(id); })[0] || {};
      var rows = [];
      var offset = 0;
      for (var page = 0; page < TASTE_PLAYLIST_MAX_PAGES; page++) {
        var res = await apiJson(tasteTracksUrl(state.provider, id, offset, TASTE_PLAYLIST_PAGE_SIZE), { timeoutMs: 20000 });
        var tracks = res && Array.isArray(res.tracks) ? res.tracks : (res && Array.isArray(res.songs) ? res.songs : []);
        tracks.forEach(function (track) { var row = tasteTrackRow(track); if (row) rows.push(row); });
        var next = res && res.nextOffset != null ? Number(res.nextOffset) : offset + tracks.length;
        state.progress = (meta.name || '歌单') + '：已读 ' + rows.length + ' 首';
        renderTasteModal();
        if (!tracks.length || (res && res.hasMore === false) || next <= offset) break;
        offset = next;
        if (rows.length >= 2000) break;
      }
      if (!rows.length) { failedNames.push(meta.name || id); continue; }
      var result = tasteIngestRows(profile, rows, {
        id: 'pl:' + state.provider + ':' + id,
        kind: 'playlist',
        label: ((meta.name || '歌单') + '（' + tasteProviderLabel(state.provider) + '）').slice(0, 80),
        provider: state.provider,
        count: rows.length,
      });
      totalAdded += result.addedSongs;
    }
    tasteTrimDocument(profile);
    profile.updatedAt = Date.now();
    tasteProfileState = profile;
    tasteViewCache.signature = '';
    await tastePersistDocument(profile);
    tasteRecount();
    tasteProviderImportState.busy = false;
    tasteProviderImportState.progress = '';
    tasteToast('已从' + tasteProviderLabel(state.provider) + '加入 ' + totalAdded + ' 首到口味档案'
      + (failedNames.length ? '；' + failedNames.length + ' 个歌单没读到曲目' : '')
      + (tasteProfileSaveError ? '；落盘提示：' + tasteProfileSaveError : ''));
    tasteRerankOpenSearchResults();
  } catch (e) {
    tasteProviderImportState.busy = false;
    tasteProviderImportState.progress = '';
    tasteProviderImportState.error = String((e && e.message) || e || '导入失败');
    tasteToast('歌单导入失败：' + tasteProviderImportState.error);
  }
  renderTasteModal();
  return { added: totalAdded };
}

// 撤掉某一个来源：把它的贡献从歌与歌手上摘干净，摘完没权重的条目整条删。
function tasteRemoveSource(sourceId) {
  var profile = tasteProfileState || tasteEmptyDocument();
  var source = (profile.sources || {})[sourceId] || {};
  var perSong = source.kind === 'playlist' ? 2 : 1.2;
  var perArtist = source.kind === 'playlist' ? 0.7 : 0.5;
  var removedSongs = 0, removedArtists = 0;
  Object.keys(profile.songs || {}).forEach(function (key) {
    var entry = profile.songs[key];
    if (!entry.sources || !(sourceId in entry.sources)) return;
    var contributed = Math.max(0, Number(entry.sources[sourceId]) || 0);
    delete entry.sources[sourceId];
    entry.weight = Math.max(0, (Number(entry.weight) || 0) - contributed * perSong);
    entry.hits = Math.max(0, (Number(entry.hits) || 0) - contributed);
    if (!entry.weight) { delete profile.songs[key]; removedSongs += 1; }
  });
  Object.keys(profile.artists || {}).forEach(function (key) {
    var entry = profile.artists[key];
    if (!entry.sources || !(sourceId in entry.sources)) return;
    var contributed = Math.max(0, Number(entry.sources[sourceId]) || 0);
    delete entry.sources[sourceId];
    entry.weight = Math.max(0, (Number(entry.weight) || 0) - contributed * perArtist);
    entry.hits = Math.max(0, (Number(entry.hits) || 0) - contributed);
    if (!entry.weight) { delete profile.artists[key]; removedArtists += 1; }
  });
  delete profile.sources[sourceId];
  tasteProfileState = profile;
  tasteSaveProfile();
  tasteRecount();
  tasteRerankOpenSearchResults();
  renderTasteModal();
  tasteToast('已撤掉这个来源（' + removedSongs + ' 首、' + removedArtists + ' 位歌手随之移除）');
  return { removedSongs: removedSongs, removedArtists: removedArtists };
}

function tasteClearAll() {
  tasteProfileState = {
    version: 1,
    enabled: tasteSearchEnabled(),
    strength: tasteStrength(),
    songs: {},
    artists: {},
    sources: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasteViewCache.signature = '';
  tasteWriteLocal(tasteProfileState);
  var bridge = tasteBridge();
  if (bridge) {
    try { bridge.clearTasteProfile(); } catch (e) { }
  }
  tastePendingClearSource = '';
  tasteRecount();
  tasteRerankOpenSearchResults();
  renderTasteModal();
  tasteToast('导入与收藏那部分已清空（本机聆听的口味是照聆听统计现算的，没动，也清不掉）');
  return true;
}

function tasteRecount() {
  var profile = tasteProfileState || tasteEmptyDocument();
  var view = tasteView();
  var listen = tasteBuildListenIndex();
  tasteStats = {
    profileSongs: Object.keys(profile.songs || {}).length,
    profileArtists: Object.keys(profile.artists || {}).length,
    listenSongs: Object.keys(listen.songs || {}).length,
    listenArtists: Object.keys(listen.artists || {}).length,
    sources: Object.keys(profile.sources || {}).length,
    viewSongs: Object.keys(view.songs).length,
    viewArtists: Object.keys(view.artists).length,
  };
  tasteSyncToggleButton();
  return tasteStats;
}

// ---------- 开关与强度 ----------

function tasteSetEnabled(next) {
  tasteProfileState = tasteProfileState || tasteEmptyDocument();
  tasteProfileState.enabled = !!next;
  tasteSaveProfile();
  tasteSyncToggleButton();
  tasteRerankOpenSearchResults();
  return tasteProfileState.enabled;
}

function tasteToggleSearchBoost() {
  var next = !tasteSearchEnabled();
  tasteSetEnabled(next);
  tasteToast(next
    ? '搜索个性化：开。命中口味档案的结果会提权，并写明为什么。再搜一次就能看出顺序差别。'
    : '搜索个性化：关。现在只按查询相关度排序，与没做这个功能时一致。');
  renderTasteModal();
  return next;
}

function tasteSetStrength(value) {
  if (!TASTE_STRENGTHS[value]) return tasteStrength();
  tasteProfileState = tasteProfileState || tasteEmptyDocument();
  tasteProfileState.strength = value;
  tasteSaveProfile();
  tasteViewCache.signature = '';
  tasteRecount();
  tasteRerankOpenSearchResults();
  renderTasteModal();
  return value;
}

function tasteSyncToggleButton() {
  try {
    var btn = document.getElementById('taste-btn');
    if (!btn) return;
    var on = tasteSearchEnabled();
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('title', (on ? '搜索个性化：开' : '搜索个性化：关')
      + ' · 档案 ' + tasteStats.profileSongs + ' 首 / 本机听过 ' + tasteStats.listenSongs + ' 首'
      + ' · 点按开档案，Shift+点按只切开关');
  } catch (e) { }
}

function tasteToast(text) {
  try {
    if (typeof showToast === 'function') { showToast(text); return; }
  } catch (e) { }
  console.info('[Taste]', text);
}

// ---------- 界面 ----------

var TASTE_MODAL_ID = 'taste-modal';


// ---------- 模态框与按钮：运行时注入（原版 index.html / index.css 里没有这两处） ----------

var TASTE_MODAL_HTML = ''
  + '<div id="taste-modal" class="modal-mask" role="dialog" aria-modal="true" aria-hidden="true">'
  + '  <div class="modal taste-modal">'
  + '    <div class="login-panel-head">'
  + '      <button class="login-panel-close" type="button" onclick="closeTasteModal()">×</button>'
  + '    </div>'
  + '    <div class="taste-title"><b>口味档案</b><small>Taste Profile · 个人数据 → 搜索个性化</small></div>'
  + '    <div id="taste-modal-body" class="taste-body"></div>'
  + '  </div>'
  + '</div>';

var TASTE_BUTTON_HTML = ''
  + '<button id="taste-btn" class="taste-search-chip active" type="button" onclick="tasteHandleButton(event)"'
  + ' aria-pressed="true" title="口味档案"><svg width="13" height="13" fill="none" stroke="currentColor"'
  + ' stroke-width="1.7" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17l-1.9-4.8-4.9-1.9 4.9-1.9z" />'
  + '<circle cx="18.4" cy="18" r="2.1" />'
  + '</svg><span>个性化</span></button>';

function tasteInjectStyle() {
  try {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector('link[data-mineradio-mods="taste-profile"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-mineradio-mods', 'taste-profile');
    link.href = 'css/mods-taste-profile.css?v=' + Date.now();
    document.head.appendChild(link);
  } catch (e) { }
}

function tasteInjectModal() {
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById(TASTE_MODAL_ID)) return true;
    var holder = document.createElement('div');
    holder.innerHTML = TASTE_MODAL_HTML;
    var node = holder.firstElementChild;
    if (!node) return false;
    document.body.appendChild(node);
    return true;
  } catch (e) {
    return false;
  }
}

function tasteInjectButton() {
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById('taste-btn')) return true;
    var searchBox = document.getElementById('search-box');
    if (!searchBox) return false;
    var holder = document.createElement('div');
    holder.innerHTML = TASTE_BUTTON_HTML;
    var btn = holder.firstElementChild;
    if (!btn) return false;
    searchBox.appendChild(btn);
    tasteSyncToggleButton();
    return true;
  } catch (e) {
    return false;
  }
}

function tasteHookSearch() {
  if (typeof window === 'undefined') return;
  // 1. 包装 fetchMusicSearchResults 实施排序提权
  if (typeof window.fetchMusicSearchResults === 'function' && !window.fetchMusicSearchResults.__tasteBoosted) {
    var rawFetch = window.fetchMusicSearchResults;
    var wrappedFetch = async function (q, mode, previousPages) {
      var res = await rawFetch.apply(this, arguments);
      if (res && Array.isArray(res.songs)) {
        applyTasteSearchBoost(res.songs, q);
      }
      return res;
    };
    wrappedFetch.__tasteBoosted = true;
    window.fetchMusicSearchResults = wrappedFetch;
  }
  // 2. 包装 searchSongResultHtml 注入理由徽章
  if (typeof window.searchSongResultHtml === 'function' && !window.searchSongResultHtml.__tasteHooked) {
    var rawHtml = window.searchSongResultHtml;
    var wrappedHtml = function (s, i) {
      var html = rawHtml.apply(this, arguments);
      if (typeof searchTasteTagHtml === 'function') {
        var tag = searchTasteTagHtml(s);
        if (tag) {
          html = html.replace(/(<div class="search-result-title">[\s\S]*?)(<\/div>)/, '$1' + tag + '$2');
        }
      }
      return html;
    };
    wrappedHtml.__tasteHooked = true;
    window.searchSongResultHtml = wrappedHtml;
  }
}

function tasteEnsureMounted() {
  tasteInjectStyle();
  tasteInjectModal();
  tasteInjectButton();
  tasteHookSearch();
}

function tasteModal() {
  return document.getElementById(TASTE_MODAL_ID);
}

function tasteModalOpen() {
  var modal = tasteModal();
  return !!(modal && modal.classList.contains('show'));
}

function openTasteModal() {
  tasteEnsureMounted();
  var modal = tasteModal();
  if (!modal) return;
  tasteRecount();
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  renderTasteModal();
}

function closeTasteModal() {
  var modal = tasteModal();
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  tastePendingClearSource = '';
}

function tasteToggleModal() {
  if (tasteModalOpen()) closeTasteModal();
  else openTasteModal();
}

// Shift+点按钮 = 只做开关、不进面板：想在两次搜索之间对照效果时少一次点击
function tasteHandleButton(e) {
  if (e && e.shiftKey) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    tasteToggleSearchBoost();
    return false;
  }
  tasteToggleModal();
  return false;
}

function tasteStrengthHtml() {
  var current = tasteStrength();
  return Object.keys(TASTE_STRENGTHS).map(function (key) {
    return '<button class="taste-chip' + (key === current ? ' active' : '') + '" type="button" data-taste-strength="'
      + key + '">' + escHtml(TASTE_STRENGTHS[key].label) + '</button>';
  }).join('');
}

function tasteSourceRow(src) {
  var pending = tastePendingClearSource === src.id;
  return '<div class="taste-source-row' + (pending ? ' pending' : '') + '">'
    + '<span class="taste-source-kind ' + escHtml(src.kind) + '">' + (src.kind === 'file' ? '文件' : '收藏') + '</span>'
    + '<span class="taste-source-label">' + escHtml(src.label || src.id) + '</span>'
    + '<span class="taste-source-count">' + escHtml(String(src.count || 0)) + ' 首</span>'
    + '<button class="taste-mini-btn' + (pending ? ' danger' : '') + '" type="button" data-taste-remove-source="'
    + escHtml(src.id) + '">' + (pending ? '确认撤掉' : '撤掉') + '</button>'
    + '</div>';
}

function tasteProviderRow(provider) {
  var loggedIn = tasteProviderLoggedIn(provider);
  var state = tasteProviderImportState;
  var active = state.provider === provider;
  return '<button class="taste-provider' + (loggedIn ? ' ready' : '') + (active ? ' active' : '') + '" type="button" data-taste-provider="'
    + escHtml(provider) + '"><span>' + escHtml(tasteProviderLabel(provider)) + '</span><small>'
    + (loggedIn ? (active && state.loading ? '读取中…' : (active && state.playlists.length ? '已读 ' + state.playlists.length + ' 个歌单' : '已登录 · 读歌单')) : '未登录')
    + '</small></button>';
}

function tastePlaylistRows() {
  var state = tasteProviderImportState;
  if (!state.provider || state.loading) return '';
  if (state.error && !state.playlists.length) return '<div class="taste-note error">' + escHtml(state.error) + '</div>';
  if (!state.playlists.length) return '';
  var rows = state.playlists.map(function (pl) {
    return '<label class="taste-pl-row"><input type="checkbox" data-taste-pick="' + escHtml(pl.id) + '"'
      + (state.picked[pl.id] ? ' checked' : '') + ' onchange="tasteHandlePick(this)">'
      + '<span class="taste-pl-name">' + escHtml(pl.name) + '</span>'
      + '<span class="taste-pl-count">' + escHtml(String(pl.trackCount || '?')) + ' 首'
      + (pl.subscribed ? ' · 收藏' : '') + '</span></label>';
  }).join('');
  var pickedCount = Object.keys(state.picked || {}).filter(function (id) { return state.picked[id]; }).length;
  var action = state.busy
    ? '<button class="taste-primary-btn" type="button" disabled>' + escHtml(state.progress || '正在读取…') + '</button>'
    : '<button class="taste-primary-btn" type="button" data-taste-import-playlists="1">导入勾中的 ' + pickedCount + ' 个歌单</button>';
  return '<div class="taste-pl-head">' + escHtml(tasteProviderLabel(state.provider))
    + ' 的歌单 · 超过 800 首的默认不勾（一次拉进来会把档案撑满）</div>'
    + '<div class="taste-pl-list">' + rows + '</div>' + action;
}

function renderTasteModal() {
  var body = document.getElementById('taste-modal-body');
  if (!body) return;
  tasteRecount();
  var profile = tasteProfileState || tasteEmptyDocument();
  var sources = Object.keys(profile.sources || {}).map(function (key) { return profile.sources[key]; });
  sources.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
  var listenText = tasteStats.listenSongs
    ? ('本机聆听现算：' + tasteStats.listenSongs + ' 首、' + tasteStats.listenArtists + ' 位歌手。这部分不在档案里另存，'
      + '所以按 Ctrl+H 回到"从来没听过歌"时它会跟着聆听统计一起归零，不用这里再清一次。')
    : '本机还没有聆听记录。一首歌听满 45 秒、或过半，就算一条口味。';
  body.innerHTML = '<div class="taste-switch-row">'
    + '<button class="taste-chip big' + (tasteSearchEnabled() ? ' active' : '') + '" type="button" data-taste-toggle="1">'
    + (tasteSearchEnabled() ? '搜索个性化：开' : '搜索个性化：关') + '</button>'
    + '<span class="taste-inline-label">强度</span>' + tasteStrengthHtml() + '</div>'
    + '<div class="desc">命中口味档案的结果会往上排，并在行上写明为什么。关掉就完全回到只按查询相关度排序，'
    + '已经画出来的这一屏会当场换顺序，不用重搜。</div>'
    + '<div class="taste-stats">'
    + '<span><b>' + tasteStats.profileSongs + '</b><small>档案曲目</small></span>'
    + '<span><b>' + tasteStats.profileArtists + '</b><small>档案歌手</small></span>'
    + '<span><b>' + tasteStats.listenSongs + '</b><small>本机听过的歌</small></span>'
    + '<span><b>' + sources.length + '</b><small>已导入来源</small></span>'
    + '</div>'
    + '<div class="taste-note">' + escHtml(listenText) + '</div>'
    + '<div class="taste-block-title">导入文件</div>'
    + '<div class="taste-drop" id="taste-drop">把 TXT / CSV / JSON / M3U 拖到这里，'
    + '<label class="taste-file-label">选择文件<input id="taste-file-input" type="file" multiple '
    + 'accept=".txt,.csv,.tsv,.json,.m3u,.m3u8,text/plain,text/csv,application/json" hidden></label></div>'
    + '<div class="taste-note small">TXT 一行一条，写「歌手 - 歌名」；只有名字的那行当歌手收。'
    + '网易云 / Spotify / Apple Music 导出的 JSON 与 CSV 直接拖进来。'
    + (tasteProfileSaveError ? '<br>落盘提示：' + escHtml(tasteProfileSaveError) : '') + '</div>'
    + '<div class="taste-block-title">连接平台，拉收藏</div>'
    + '<div class="taste-provider-row">' + TASTE_CONNECTABLE_PROVIDERS.map(tasteProviderRow).join('') + '</div>'
    + tastePlaylistRows()
    + '<div class="taste-block-title">已导入的来源' + (sources.length ? '' : '（还没有）') + '</div>'
    + (sources.length ? sources.map(tasteSourceRow).join('')
      : '<div class="taste-note small">一次都没有。导入文件或勾中平台歌单后会出现在这里。</div>')
    + (sources.length
      ? '<div class="taste-danger-row"><button class="taste-mini-btn' + (tastePendingClearSource === '__all__' ? ' danger' : '')
      + '" type="button" data-taste-clear-all="1">'
      + (tastePendingClearSource === '__all__' ? '确认清掉全部来源' : '清掉全部导入与收藏') + '</button>'
      + '<span class="taste-note small">只撤导入与收藏这一路；聆听统计、平台账号里的歌单都不动。</span></div>'
      : '');
  tasteBindModalControls();
}

function tasteBindModalControls() {
  var input = document.getElementById('taste-file-input');
  if (input) {
    input.onchange = function () {
      tasteHandleFiles(input.files);
      input.value = '';
    };
  }
  var drop = document.getElementById('taste-drop');
  if (drop) {
    drop.ondragover = function (e) { if (e) e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    drop.ondrop = function (e) {
      if (e) { e.preventDefault(); drop.classList.remove('over'); }
      if (e && e.dataTransfer && e.dataTransfer.files) tasteHandleFiles(e.dataTransfer.files);
    };
  }
}

function tasteHandlePick(input) {
  if (!input) return false;
  var id = input.getAttribute('data-taste-pick');
  tasteProviderImportState.picked[id] = !!input.checked;
  var btn = document.querySelector('[data-taste-import-playlists]');
  if (btn) {
    var count = Object.keys(tasteProviderImportState.picked || {}).filter(function (key) { return tasteProviderImportState.picked[key]; }).length;
    btn.textContent = '导入勾中的 ' + count + ' 个歌单';
  }
  return true;
}

// 全局捕获阶段监听：只在口味面板与搜索框那颗开关里找 data-*，别的点击第一句就退出
function tasteHandleClick(e) {
  var target = e && e.target;
  if (!target || !target.closest) return;
  var host = target.closest('#taste-modal, #search-box');
  if (!host) return;
  var strength = target.closest('[data-taste-strength]');
  if (strength) {
    tasteSetStrength(strength.getAttribute('data-taste-strength'));
    return;
  }
  if (target.closest('[data-taste-toggle]')) {
    tasteToggleSearchBoost();
    return;
  }
  var provider = target.closest('[data-taste-provider]');
  if (provider) {
    var name = provider.getAttribute('data-taste-provider');
    if (!tasteProviderLoggedIn(name)) { tasteToast(tasteProviderLabel(name) + ' 还没登录：先在音质菜单或托盘里补登'); return; }
    tasteLoadProviderPlaylists(name);
    return;
  }
  if (target.closest('[data-taste-import-playlists]')) {
    tasteImportSelectedPlaylists();
    return;
  }
  var remove = target.closest('[data-taste-remove-source]');
  if (remove) {
    var id = remove.getAttribute('data-taste-remove-source');
    if (tastePendingClearSource === id) { tastePendingClearSource = ''; tasteRemoveSource(id); }
    else { tastePendingClearSource = id; renderTasteModal(); }
    return;
  }
  if (target.closest('[data-taste-clear-all]')) {
    if (tastePendingClearSource === '__all__') tasteClearAll();
    else { tastePendingClearSource = '__all__'; renderTasteModal(); }
  }
}

// 开机：localStorage 那份已经在 tasteProfileState 里了，再拿磁盘那份比一次新旧
function tasteProfileInit() {
  tasteEnsureMounted();
  tasteRecount();
  return tasteHydrateFromDisk().then(function (res) {
    tasteEnsureMounted();
    tasteRecount();
    tasteSyncToggleButton();
    return res || { ok: true, source: 'local' };
  });
}

document.addEventListener('click', function (e) {
  tasteHandleClick(e);
}, true);

// 自己接开机：这份档案既不在启动链上，也不该让 05-startup-bindings 为一件它不管的事改行
tasteProfileInit();

window.openTasteModal = openTasteModal;
window.closeTasteModal = closeTasteModal;
window.tasteSearchEnabled = tasteSearchEnabled;
window.tasteStatsSnapshot = function () { return JSON.parse(JSON.stringify(tasteStats)); };
window.tasteToggleModal = tasteToggleModal;
window.tasteHandleButton = tasteHandleButton;
window.tasteHandlePick = tasteHandlePick;
window.tasteToggleSearchBoost = tasteToggleSearchBoost;
window.tasteSetStrength = tasteSetStrength;
window.tasteHandleFiles = tasteHandleFiles;
window.applyTasteSearchBoost = applyTasteSearchBoost;
window.searchTasteTagHtml = searchTasteTagHtml;
window.tasteProfileInit = tasteProfileInit;

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tasteEnsureMounted);
  } else {
    tasteEnsureMounted();
  }
  // 简约/DIY 切换或动态重建搜索框时做安全重试
  setTimeout(tasteEnsureMounted, 300);
  setTimeout(tasteEnsureMounted, 1000);
  setTimeout(tasteEnsureMounted, 2500);
}

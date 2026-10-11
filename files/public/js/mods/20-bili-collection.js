// ============================================================
//  外挂：主界面搜索结果行里的 B 站合集分 P 面板
//
//  上游把一条 B 站结果当"一首歌"画：点下去就是整条视频的第一 P。
//  这里不改上游 07-search.js，而是**包装它的行渲染函数**
//  searchSongResultHtml(s, i)：原样拿回上游那段 HTML，在行尾追一条分 P 面板。
//  因为整个应用与内联 onclick 走的都是 window 上的全局函数，
//  外挂模块在所有上游模块之后执行，替换 window 上的那一份就够。
//
//  与开发版的一处差别：开发版还会把"已知是多段"的整行点击改成展开，
//  那需要改动上游 HTML 里的 onclick 字符串（脆）。这里保留上游的行点击（播整条），
//  展开走面板上那颗按钮 —— 多一下点击，但不去动上游拼出来的那串属性。
// ============================================================
(function mineradioModsBiliCollection() {
  'use strict';

  var RENDER_LIMIT = 60;   // 实测有 162/190/191/200 段的合集，一次铺完会拖垮结果区
  var CACHE_LIMIT = 40;
  var cache = {};

  // 样式随外挂注入（上游 CSS 里没有这些类名，也不需要知道）
  try {
    if (!document.querySelector('link[data-mineradio-mods="bili-collection"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-mineradio-mods', 'bili-collection');
      link.href = 'css/mods-bili-collection.css?v=' + Date.now();
      document.head.appendChild(link);
    }
  } catch (e) { }

  function esc(value) {
    var d = document.createElement('div');
    d.textContent = value == null ? '' : String(value);
    return d.innerHTML;
  }

  function bvidOf(song) { return String((song && (song.bvid || song.id)) || ''); }
  function isBili(song) {
    if (!song) return false;
    if (typeof window.__mrModsProviderOf === 'function') return window.__mrModsProviderOf(song) === 'bilibili';
    return !!song.bvid;
  }
  function timeOf(sec) {
    var n = Number(sec) || 0;
    if (!n) return '';
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function remember(bvid, entry) {
    cache[bvid] = entry;
    var keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) delete cache[keys[0]];   // 搜索翻页会一直攒，不封顶会涨
  }

  function itemsOf(entry) {
    if (!entry || entry.state !== 'ready') return [];
    // 分 P 才是这条视频自己的曲目表；ugc_season 是平台另外挂上来的另一个列表
    if (entry.parts && entry.parts.length > 1) return entry.parts;
    if (entry.seasonItems && entry.seasonItems.length > 1) return entry.seasonItems;
    return entry.parts || [];
  }

  async function loadParts(bvid) {
    var entry = cache[bvid];
    if (entry && entry.state === 'ready') return entry;
    if (entry && entry.state === 'loading') return entry;
    var pending = { bvid: bvid, state: 'loading', open: true, parts: [], seasonItems: [] };
    remember(bvid, pending);
    try {
      var data = await window.apiJson('/api/bilibili/parts?bvid=' + encodeURIComponent(bvid));
      pending.state = 'ready';
      pending.parts = Array.isArray(data.parts) ? data.parts : [];
      pending.seasonItems = Array.isArray(data.seasonEpisodes) ? data.seasonEpisodes : [];
      pending.error = '';
    } catch (e) {
      pending.state = 'error';
      pending.error = String((e && e.message) || e || 'BILI_PARTS_FAILED');
    }
    rerender();
    return pending;
  }

  function rerender() {
    if (typeof window.renderSongSearchResults !== 'function') return;
    var songs = (typeof window.playlist !== 'undefined' && Array.isArray(window.playlist)) ? window.playlist : null;
    if (!songs) return;
    try { window.renderSongSearchResults(songs); } catch (e) { }
  }

  // 一段 = 一条可播的歌：合集的 bvid + 这一段自己的 cid + 分标题
  function partSong(parent, item) {
    var song = typeof window.cloneSong === 'function' ? window.cloneSong(parent) : Object.assign({}, parent);
    var own = String((item && item.bvid) || '');
    var parentBvid = bvidOf(parent);
    song.bvid = (own && own !== parentBvid) ? own : parentBvid;
    song.id = song.bvid;
    song.cid = String((item && item.cid) || '');
    song.name = (item && item.part) || song.name;
    if (item && item.duration) song.duration = Number(item.duration) || song.duration;
    song.biliCollectionTitle = String(parent.name || '');
    song.biliPartIndex = Number(item && item.index) || 0;
    return song;
  }

  function playAt(song) {
    if (!Array.isArray(window.playQueue)) return;
    var key = typeof window.queueItemKey === 'function' ? window.queueItemKey(song) : '';
    var at = -1;
    if (key) {
      for (var i = 0; i < window.playQueue.length; i++) {
        if (window.queueItemKey(window.playQueue[i]) === key) { at = i; break; }
      }
    }
    if (at < 0) { window.playQueue.push(song); at = window.playQueue.length - 1; }
    window.currentIdx = at;
    if (typeof window.renderQueuePanel === 'function') { try { window.renderQueuePanel(); } catch (e) { } }
    if (typeof window.playQueueAt === 'function') window.playQueueAt(at, { manual: true });
  }

  function parentAt(i) { return (typeof window.playlist !== 'undefined' && Array.isArray(window.playlist)) ? window.playlist[i] : null; }

  window.toggleBiliParts = async function (i) {
    var song = parentAt(i);
    var bvid = bvidOf(song);
    if (!bvid) return;
    var entry = cache[bvid];
    if (entry && entry.state === 'ready') { entry.open = !entry.open; rerender(); return; }
    await loadParts(bvid);
  };
  window.playBiliPart = function (i, k) {
    var song = parentAt(i); var entry = cache[bvidOf(song)]; var item = itemsOf(entry)[k];
    if (!song || !item) return;
    playAt(partSong(song, item));
  };
  window.queueBiliPart = function (i, k) {
    var song = parentAt(i); var entry = cache[bvidOf(song)]; var item = itemsOf(entry)[k];
    if (!song || !item) return;
    if (typeof window.queueSong === 'function') window.queueSong(partSong(song, item));
    if (typeof window.showToast === 'function') window.showToast('已加入队列: ' + ((item && item.part) || ''));
  };
  window.queueBiliCollection = function (i) {
    var song = parentAt(i); var entry = cache[bvidOf(song)]; var items = itemsOf(entry);
    if (!song || !items.length || typeof window.queueSong !== 'function') return;
    items.forEach(function (item) { window.queueSong(partSong(song, item)); });
    if (typeof window.showToast === 'function') window.showToast('合集已入队: ' + items.length + ' 段');
  };

  function panelHtml(song, i) {
    if (!isBili(song) || !bvidOf(song)) return '';
    var bvid = bvidOf(song);
    var entry = cache[bvid];
    if (!entry) {
      return '<div class="bili-parts-bar"><button class="bili-parts-toggle" type="button" '
        + 'title="这条 B 站结果可能是一整个合集，展开后按段播放" '
        + 'onclick="event.stopPropagation();toggleBiliParts(' + i + ')">'
        + (song.isCollection || song.isCompilation ? '展开合集分段' : '分段 / 合集') + '</button></div>';
    }
    if (entry.state === 'loading') return '<div class="bili-parts-bar"><span class="bili-parts-state">正在读取分段…</span></div>';
    if (entry.state === 'error') {
      return '<div class="bili-parts-bar"><button class="bili-parts-toggle" type="button" '
        + 'onclick="event.stopPropagation();toggleBiliParts(' + i + ')">分段读取失败（'
        + esc(entry.error || '') + '），点此重试</button></div>';
    }
    var items = itemsOf(entry);
    if (items.length <= 1) return '<div class="bili-parts-bar"><span class="bili-parts-state">单段视频</span></div>';
    var shown = items.slice(0, RENDER_LIMIT);
    var head = '<div class="bili-parts-bar"><button class="bili-parts-toggle" type="button" '
      + 'onclick="event.stopPropagation();toggleBiliParts(' + i + ')">' + (entry.open ? '收起' : '展开')
      + ' ' + items.length + ' 段</button>'
      + (entry.open ? '<button class="bili-parts-queue-all" type="button" onclick="event.stopPropagation();queueBiliCollection('
        + i + ')">整包入队 ' + items.length + ' 段</button>' : '') + '</div>';
    if (!entry.open) return head;
    var rows = shown.map(function (item, k) {
      return '<div class="bili-part-row" onclick="event.stopPropagation();playBiliPart(' + i + ',' + k + ')">'
        + '<span class="bili-part-index">' + (Number(item.index) || (k + 1)) + '</span>'
        + '<span class="bili-part-title">' + esc(item.part || '') + '</span>'
        + '<span class="bili-part-duration">' + timeOf(item.duration) + '</span>'
        + '<button class="add-btn" title="加入队列" onclick="event.stopPropagation();queueBiliPart(' + i + ',' + k + ')">+</button>'
        + '</div>';
    }).join('');
    if (items.length > shown.length) {
      rows += '<div class="bili-parts-more">只显示前 ' + RENDER_LIMIT + ' 段，共 ' + items.length
        + ' 段 · 用「整包入队」一次全部加入队列</div>';
    }
    return head + '<div class="bili-parts-panel">' + rows + '</div>';
  }

  var original = window.searchSongResultHtml;
  if (typeof original !== 'function') {
    console.warn('[mods] 上游没有 searchSongResultHtml，分 P 面板这次不生效（不是错误，只是没有入口）');
    return;
  }
  window.searchSongResultHtml = function (song, i) {
    var html = original.apply(this, arguments);
    try { return String(html) + panelHtml(song, i); } catch (e) { return html; }
  };
})();

// ============================================================
//  外挂源：B 站（渲染层这一半）
//
//  上游的"源注册表"是一堆顶层函数（normalizePlaybackProvider / lyricEndpointForSong …），
//  外挂模块在这个文件里是**最后**执行的，所以可以直接包装它们 —— 应用与内联 onclick
//  调的都是 window 上那份，包装后立刻生效。
//
//  取址走的是 mods.json 里那两个 playback-* 锚点调的 window.__mrModsSongUrl。
//  判断"这条是不是 B 站"用 song.bvid，不用 playbackProvider —— 上游那个归一函数
//  本来不认识 bilibili，是我们在下面替它补的一课。
// ============================================================
(function mineradioModsSources() {
  'use strict';

  var REGISTRY = {
    bilibili: {
      label: 'B 站',
      search: '/api/bilibili/search',
      parts: '/api/bilibili/parts',
      songUrl: '/api/bilibili/song/url',
      lyric: '/api/bilibili/lyric',
      pageLimit: 12,
    },
  };
  window.__mrModsProviders = REGISTRY;

  function providerOf(song) {
    if (!song || typeof song !== 'object') return '';
    if (song.bvid) return 'bilibili';
    var key = typeof window.songProviderKey === 'function' ? window.songProviderKey(song)
      : String(song.provider || song.source || song.type || '');
    return REGISTRY[key] ? key : '';
  }
  window.__mrModsProviderOf = providerOf;

  var qs = function (value) { return encodeURIComponent(value == null ? '' : value); };

  // 锚点调的就是这个：命中返回后端那一份取址结果，不命中返回 null 让上游继续走它自己的
  window.__mrModsSongUrl = async function (song, playbackProvider, qualityParam) {
    var provider = providerOf(song);
    if (!provider) return null;
    var entry = REGISTRY[provider];
    var url = entry.songUrl + '?';
    if (provider === 'bilibili') url += 'bvid=' + qs(song.bvid || song.id) + '&cid=' + qs(song.cid);
    url += (qualityParam || '');
    if (typeof window.apiJson !== 'function') return null;
    var data = await window.apiJson(url, { timeoutMs: 15000 });
    if (!data || (!data.url && !data.playable)) return data || null;
    return data;
  };

  // 上游那个 songProviderKey 只认 netease/qq/kugou/qishui/spotify，**其它一律回 'netease'**，
  // 于是 B 站行会被画成网易云、浮窗也不会给它"这是合集"的徽章（徽章与下钻都判 bilibili）。
  // 在这里补一课，比去改上游那个函数好：上游改了实现，我们这层照样只管"是不是 bvid"。
  var originalProviderKey = window.songProviderKey;
  window.songProviderKey = function (song) {
    if (song && (song.bvid || song.provider === 'bilibili' || song.source === 'bilibili' || song.type === 'bilibili')) return 'bilibili';
    return typeof originalProviderKey === 'function' ? originalProviderKey.apply(this, arguments) : '';
  };

  // 让上游认识这个新源（它原来只认 netease/qq/kugou/qishui/spotify/local）
  var originalNormalize = window.normalizePlaybackProvider;
  if (typeof originalNormalize === 'function') {
    window.normalizePlaybackProvider = function (provider) {
      var want = String(provider || '');
      if (REGISTRY[want]) return want;
      return originalNormalize.apply(this, arguments);
    };
  }

  // B 站没有官方同步歌词：如实问自己的端点，别拿歌名去网易云捞一份错歌词
  var originalLyric = window.lyricEndpointForSong;
  window.lyricEndpointForSong = function (songOrId) {
    var provider = providerOf(songOrId);
    if (provider) return REGISTRY[provider].lyric + '?bvid=' + qs(songOrId.bvid || songOrId.id);
    return typeof originalLyric === 'function' ? originalLyric.apply(this, arguments) : '';
  };

  // 让主界面的搜索结果里也出现 B 站行：上游的 fetchMusicSearchResults 只认识它自己那几家，
  // 所以在这里把外挂源的一页并进去（All 档）。BL 单独那一档上游没有标签，交给浮窗自己走。
  var originalFetch = window.fetchMusicSearchResults;
  if (typeof originalFetch === 'function') {
    window.fetchMusicSearchResults = async function (q, mode, previousPages) {
      var base = await originalFetch.apply(this, arguments);
      try {
        var previous = (previousPages && previousPages.bilibili) || null;
        var offset = previous && previous.hasMore ? (Number(previous.nextOffset) || 0) : 0;
        var data = await window.apiJson(REGISTRY.bilibili.search + '?keywords=' + encodeURIComponent(q)
          + '&limit=12&offset=' + offset);
        var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
        var nextOffset = Number(data && data.nextOffset);
        if (!isFinite(nextOffset) || nextOffset <= offset) nextOffset = offset + songs.length;
        var pages = Object.assign({}, (base && base.providerPages) || {});
        pages.bilibili = {
          offset: offset, nextOffset: nextOffset, limit: 12,
          hasMore: songs.length > 0 && (data && data.hasMore != null ? !!data.hasMore : true),
        };
        var merged = ((base && base.songs) || []).concat(songs);
        return {
          songs: merged, providerPages: pages,
          hasMore: !!(base && base.hasMore) || pages.bilibili.hasMore,
        };
      } catch (e) { return base; }
    };
  }

  // 浮窗那一侧的合并搜索也认这个源（它自己判 __mrModsHas）
  window.__mrModsSearchPage = async function (mode, q, offset) {
    var entry = REGISTRY[mode];
    if (!entry) return { songs: [], providerPages: {}, hasMore: false };
    var data = await window.apiJson(entry.search + '?keywords=' + encodeURIComponent(q)
      + '&limit=' + (Number(entry.pageLimit) || 12) + '&offset=' + (Number(offset) || 0));
    var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
    var nextOffset = Number(data && data.nextOffset);
    if (!isFinite(nextOffset) || nextOffset <= (Number(offset) || 0)) nextOffset = (Number(offset) || 0) + songs.length;
    var pages = {};
    pages[mode] = {
      offset: Number(offset) || 0, nextOffset: nextOffset, limit: entry.pageLimit || 12,
      hasMore: songs.length > 0 && (data && data.hasMore != null ? !!data.hasMore : true),
    };
    return { songs: songs, providerPages: pages, hasMore: pages[mode].hasMore };
  };

  // 浮窗与主界面都问这句："这个源在不在？"（不装 bili-source 时 BL 档就该消失）
  window.__mrModsHas = function (provider) { return !!REGISTRY[String(provider || '')]; };
})();

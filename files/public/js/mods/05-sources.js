// ============================================================
//  外挂源（渲染层这一半）：B 站 / Internet Archive / Radio Paradise
//
//  上游的"源注册表"是一堆顶层函数（normalizePlaybackProvider / lyricEndpointForSong …），
//  外挂模块在这个文件里是**最后**执行的，所以可以直接包装它们 —— 应用与内联 onclick
//  调的都是 window 上那份，包装后立刻生效。
//
//  取址走的是 mods.json 里那两个 playback-* 锚点调的 window.__mrModsSongUrl。
//  判断"这条是哪个源的"一律看 REGISTRY 里各源自己的 match()，不用 playbackProvider ——
//  上游那个归一函数本来不认识这些源，是我们在下面替它补的一课。
//
//  加第四个源只需要在 REGISTRY 添一项：档位标签、取址参数、歌词端点、进不进 All 档
//  都从这一项里读，不用再改下面任何一个包装函数。
// ============================================================
(function mineradioModsSources() {
  'use strict';

  function providerField(song) {
    return String((song && (song.provider || song.source || song.type)) || '');
  }
  function isProvider(song, key) { return providerField(song) === key; }
  function hasText(value) { return !!(value && String(value).trim()); }

  var REGISTRY = {
    bilibili: {
      label: 'B 站',
      tag: 'BL',
      search: '/api/bilibili/search',
      parts: '/api/bilibili/parts',
      songUrl: '/api/bilibili/song/url',
      lyric: '/api/bilibili/lyric',
      pageLimit: 12,
      inAll: true,
      // B 站行最稳的标记是 bvid（搜索与分 P 都会带）；provider 字段是给"整包入队"
      // 之后从队列快照还原出来的那些行用的
      match: function (song) { return !!song && (hasText(song.bvid) || isProvider(song, 'bilibili')); },
      songUrlParams: function (song) {
        return 'bvid=' + qs(song.bvid || song.id) + '&cid=' + qs(song.cid);
      },
      lyricParams: function (song) { return '?bvid=' + qs(song.bvid || song.id); },
    },
    internetarchive: {
      label: 'Archive',
      tag: 'IA',
      search: '/api/internetarchive/search',
      songUrl: '/api/internetarchive/song/url',
      lyric: '/api/internetarchive/lyric',
      pageLimit: 12,
      inAll: true,
      match: function (song) { return !!song && (hasText(song.archiveId) || isProvider(song, 'internetarchive')); },
      // 一行 = archive.org 的一个**条目**（常常是一整张专辑 / 一场演出）；
      // 具体取哪个文件由后端按音质档挑（过 Chromium 可播性白名单），file 只在用户点名某文件时才有值
      songUrlParams: function (song) {
        return 'archiveId=' + qs(song.archiveId || song.id) + '&file=' + qs(song.archiveFile);
      },
      lyricParams: function () { return ''; },
      // 条目级元数据没有时长，真实时长在取链那一步才回来（durationSeconds）
      durationFromUrlResult: true,
    },
    radioparadise: {
      label: 'RP',
      tag: 'RP',
      search: '/api/radioparadise/search',
      channels: '/api/radioparadise/channels',
      nowPlaying: '/api/radioparadise/now-playing',
      songUrl: '/api/radioparadise/song/url',
      lyric: '/api/radioparadise/lyric',
      pageLimit: 12,
      // 直播电台：All 档里掺进六条电台频道会把音乐结果挤下去，所以只在自己的档位出现
      inAll: false,
      live: true,
      // Main Mix 的 chan 是 0，真值判断会把它当成"没有 chan"
      match: function (song) {
        return !!song && (song.rpChan != null && song.rpChan !== '' || hasText(song.rpSlug) || isProvider(song, 'radioparadise'));
      },
      songUrlParams: function (song) {
        return 'chan=' + qs(song.rpChan) + '&slug=' + qs(song.rpSlug || song.id) + '&region=' + qs(song.rpRegion);
      },
      lyricParams: function () { return ''; },
    },
  };
  window.__mrModsProviders = REGISTRY;

  function providerOf(song) {
    if (!song || typeof song !== 'object') return '';
    var keys = Object.keys(REGISTRY);
    for (var i = 0; i < keys.length; i++) {
      try { if (REGISTRY[keys[i]].match(song)) return keys[i]; } catch (e) { }
    }
    return '';
  }
  window.__mrModsProviderOf = providerOf;

  var qs = function (value) { return encodeURIComponent(value == null ? '' : value); };

  // 锚点调的就是这个：命中返回后端那一份取址结果，不命中返回 null 让上游继续走它自己的
  window.__mrModsSongUrl = async function (song, playbackProvider, qualityParam) {
    var provider = providerOf(song);
    if (!provider) return null;
    var entry = REGISTRY[provider];
    var url = entry.songUrl + '?' + entry.songUrlParams(song || {});
    // 直播流没有音质档可换（RP 只下发实测过的 320k slug），别把档位参数带过去装作能选
    if (!entry.live) url += (qualityParam || '');
    if (typeof window.apiJson !== 'function') return null;
    var data = await window.apiJson(url, { timeoutMs: 20000 });
    if (!data || (!data.url && !data.playable)) return data || null;
    return data;
  };

  // 上游（原版 2.2.0）那个 songProviderKey 只认 spotify/qq/kugou/qishui，**其它一律回 'netease'**，
  // 于是新源那一行会被画成网易云、浮窗也不会给它对应的徽章。
  // 在这里补一课，比去改上游那个函数好：上游改了实现，我们这层照样只管"这条像哪个源"。
  var originalProviderKey = window.songProviderKey;
  window.songProviderKey = function (song) {
    var provider = providerOf(song);
    if (provider) return provider;
    return typeof originalProviderKey === 'function' ? originalProviderKey.apply(this, arguments) : '';
  };

  // 同理，normalizePlaybackProvider 也是"认不认识的都回 netease"（原版只认 qq/kugou/qishui/spotify），
  // 起播那串 if/else 拿到的就是 'netease'，于是拿新源的 id 去问网易云要直链
  var originalNormalize = window.normalizePlaybackProvider;
  if (typeof originalNormalize === 'function') {
    window.normalizePlaybackProvider = function (provider) {
      var want = String(provider || '');
      if (REGISTRY[want]) return want;
      return originalNormalize.apply(this, arguments);
    };
  }

  // 新源没有同步歌词：如实问自己的端点，别拿歌名去网易云捞一份错歌词
  var originalLyric = window.lyricEndpointForSong;
  window.lyricEndpointForSong = function (songOrId) {
    var provider = providerOf(songOrId);
    if (provider) return REGISTRY[provider].lyric + (REGISTRY[provider].lyricParams(songOrId || {}) || '');
    return typeof originalLyric === 'function' ? originalLyric.apply(this, arguments) : '';
  };

  // 结果行左上角那颗源标签：上游的标签函数是一条只认 NE/QQ/KG/QS/SP 的三元链，
  // 类别名（class）能拿到 'internetarchive'，文字却会兜成 "NE" —— 行看着像网易云的歌。
  // 这里按同一个结构自己拼那一颗，类名与上游一致（没有配色规则就是默认的中性药丸）。
  var originalTag = window.songSourceTagHtml;
  window.songSourceTagHtml = function (song, opts) {
    var provider = providerOf(song);
    var tag = provider ? REGISTRY[provider].tag : '';
    if (tag) {
      var cls = 'tag-source ' + provider;
      if (opts && opts.switcher) {
        return '<button type="button" class="' + cls + ' control-source-chip" title="'
          + escAttr(REGISTRY[provider].label) + '（mineradio-mods 外挂源）" aria-haspopup="true"'
          + ' onclick="toggleControlSourceSwitcher(event)">' + tag + '</button>';
      }
      return '<span class="' + cls + '" title="' + escAttr(REGISTRY[provider].label) + '">' + tag + '</span>';
    }
    return typeof originalTag === 'function' ? originalTag.apply(this, arguments) : '';
  };
  function escAttr(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // 让主界面的搜索结果里也出现外挂源：上游的 fetchMusicSearchResults 只认识它自己那几家，
  // 所以在这里把 inAll 的那些源各一页并进去（All 档）。
  var originalFetch = window.fetchMusicSearchResults;
  if (typeof originalFetch === 'function') {
    window.fetchMusicSearchResults = async function (q, mode, previousPages) {
      var base = await originalFetch.apply(this, arguments);
      try {
        var pages = Object.assign({}, (base && base.providerPages) || {});
        var want = searchableProviders().filter(function (provider) {
          // 上一轮已经说过"这家到头了"就别再打一次接口
          var previous = previousPages && previousPages[provider];
          return !(previous && previous.hasMore === false);
        });
        var incoming = await Promise.all(want.map(async function (provider) {
          var page = await searchPage(provider, q, offsetFor(previousPages, provider));
          if (page.providerPages) pages[provider] = page.providerPages[provider];
          return page.songs;
        }));
        var added = [].concat.apply([], incoming);
        if (!added.length) return base;
        var merged = ((base && base.songs) || []).concat(added);
        // 上游 renderSongSearchResults 只画前 MUSIC_SEARCH_INITIAL_VISIBLE 行，
        // 直接拼在末尾 = 永远看不见（第一次真跑 0 行就是这个原因）。
        // 所以用软件自己的打分重排，不另立一套排序口径；没有那个函数就退到"插在前几行之后"。
        if (typeof window.scoreSongSearchResult === 'function') {
          merged.forEach(function (song, index) {
            try { song._searchScore = window.scoreSongSearchResult(song, q, index); } catch (e) { }
          });
          merged.sort(function (a, b) { return (b && b._searchScore || 0) - (a && a._searchScore || 0); });
        } else {
          var at = Math.min(4, merged.length);
          Array.prototype.splice.apply(merged, [at, 0].concat(merged.splice(merged.length - added.length)));
        }
        var anyMore = Object.keys(pages).some(function (provider) {
          return REGISTRY[provider] && pages[provider] && pages[provider].hasMore;
        });
        return {
          songs: merged, providerPages: pages,
          hasMore: !!(base && base.hasMore) || anyMore,
        };
      } catch (e) { return base; }
    };
  }

  function searchableProviders() {
    return Object.keys(REGISTRY).filter(function (provider) { return REGISTRY[provider].inAll; });
  }

  function offsetFor(previousPages, provider) {
    var previous = previousPages && previousPages[provider];
    return previous ? Math.max(0, Number(previous.nextOffset) || 0) : 0;
  }

  // 取一页这件事只写这一份：主界面的 All 档合并与浮窗的单源档位都走它
  async function searchPage(provider, q, offset) {
    var entry = REGISTRY[provider];
    if (!entry) return { songs: [], providerPages: {}, hasMore: false };
    var start = Math.max(0, Number(offset) || 0);
    var limit = Number(entry.pageLimit) || 12;
    var data = await window.apiJson(entry.search + '?keywords=' + encodeURIComponent(q || '')
      + '&limit=' + limit + '&offset=' + start);
    var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
    var nextOffset = Number(data && data.nextOffset);
    if (!isFinite(nextOffset) || nextOffset <= start) nextOffset = start + songs.length;
    var hasMore = songs.length > 0 && (data && data.hasMore != null ? !!data.hasMore : true);
    var pages = {};
    pages[provider] = { offset: start, nextOffset: nextOffset, limit: limit, hasMore: hasMore };
    return { songs: songs, providerPages: pages, hasMore: hasMore };
  }

  // 浮窗那一侧的合并搜索也认这些源（它自己判 __mrModsHas）
  window.__mrModsSearchPage = function (mode, q, offset) {
    return searchPage(mode, q, offset);
  };

  // 浮窗与主界面都问这句："这个源在不在？"（不装某个源时那一档就该消失）
  window.__mrModsHas = function (provider) { return !!REGISTRY[String(provider || '')]; };

  // 浮窗要按源决定"这一行回车是播还是展开分段"，直播源不该有那种期待
  window.__mrModsIsLive = function (provider) { return !!(REGISTRY[String(provider || '')] || {}).live; };
})();

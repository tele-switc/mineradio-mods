// ============================================================
//  mineradio-mods: 网易云超级增强与双算法推荐漫游引擎
//  - 音乐云盘（☁️ 线上云盘 / 本地私有仓）
//  - 私人电台（📻 漫游推流 + 算法垃圾桶淘汰）
//  - 官方排行榜（🏆 飙升/新歌/热歌/原创）
//  - 双算法日推（🌟 网易云品味雷达 × 汽水信息流推流引擎，无限漫游）
//  - 心动模式与相似歌曲推荐（💓 心动模式 / 🎵 相似歌曲）
//  - 分享链接秒识别
// ============================================================
(function () {
  'use strict';

  function syncFmTrashButtonVisibility(mode) {
    var trashBtn = document.getElementById('fm-trash-btn');
    if (trashBtn) {
      trashBtn.style.display = mode === 'fm' ? 'inline-flex' : 'none';
    }
  }

  // 1. 注入私人电台模式与双算法漫游引擎
  if (typeof window.fetchNextPersonalFmTracks !== 'function') {
    var personalFmFetching = false;
    window.fetchNextPersonalFmTracks = function (playImmediately) {
      if (personalFmFetching) return Promise.resolve([]);
      personalFmFetching = true;
      var endpoint = '/api/feed/super-daily';
      return (window.apiJson ? window.apiJson(endpoint) : fetch(endpoint).then(function (r) { return r.json(); })).then(function (r) {
        var incoming = (r && r.tracks || []).filter(function (s) { return s && s.id; });
        if (!incoming.length) return [];
        var queue = window.playQueue || [];
        var existingIds = new Set(queue.map(function (s) { return String(s.id); }));
        var newTracks = incoming.filter(function (s) { return !existingIds.has(String(s.id)); });
        if (!newTracks.length) newTracks = incoming;
        if (playImmediately) {
          window.playQueue = newTracks;
          window.currentIdx = 0;
          if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('personal-fm-start');
          if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('personal-fm-start', true);
          if (typeof window.playQueueAt === 'function') window.playQueueAt(0);
        } else {
          queue.push.apply(queue, newTracks);
          if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('personal-fm-append');
          if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('personal-fm-append', true);
        }
        return newTracks;
      }).catch(function (err) {
        console.warn('[PersonalFM] fetch error:', err);
        return [];
      }).finally(function () {
        personalFmFetching = false;
      });
    };
  }

  window.startPersonalFmMode = function () {
    window.playMode = 'fm';
    syncFmTrashButtonVisibility('fm');
    if (typeof window.updatePlayModeButton === 'function') window.updatePlayModeButton(true);
    if (typeof window.showToast === 'function') window.showToast('📻 正在调频至私人电台漫游...');
    return window.fetchNextPersonalFmTracks(true).then(function (tracks) {
      if (tracks && tracks.length && typeof window.showToast === 'function') {
        window.showToast('📻 私人电台漫游已开启，支持垃圾桶淘汰过滤');
      }
    });
  };

  window.startSuperDailyFeedMode = function () {
    window.playMode = 'fm';
    syncFmTrashButtonVisibility('fm');
    if (typeof window.updatePlayModeButton === 'function') window.updatePlayModeButton(true);
    if (typeof window.showToast === 'function') window.showToast('🌟 正在根据你的品味生成双算法日推漫游...');

    var clientSeeds = null;
    try {
      if (typeof window.loadListenStatsState === 'function') {
        var stats = window.loadListenStatsState();
        var songs = stats && stats.songs ? Object.values(stats.songs) : [];
        songs.sort(function (a, b) { return (b.plays || 0) - (a.plays || 0); });
        clientSeeds = {
          keywords: typeof window.getTasteSearchSuggestions === 'function' ? window.getTasteSearchSuggestions() : [],
          artists: stats && stats.artists ? Object.keys(stats.artists) : [],
          anchorSongs: songs.slice(0, 10).map(function (s) { return { name: s.name, artist: s.artist, plays: s.plays, raw: s }; })
        };
      }
    } catch (_) {}

    var reqPromise = clientSeeds
      ? fetch('/api/feed/super-daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clientSeeds) }).then(function (r) { return r.json(); })
      : (window.apiJson ? window.apiJson('/api/feed/super-daily') : fetch('/api/feed/super-daily').then(function (r) { return r.json(); }));

    return reqPromise.then(function (r) {
      var tracks = (r && r.tracks || []).filter(function (s) { return s && s.id; });
      if (!tracks.length) return window.startPersonalFmMode();
      window.playQueue = tracks;
      window.currentIdx = 0;
      if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('super-daily-start');
      if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('super-daily-start', true);
      if (typeof window.playQueueAt === 'function') window.playQueueAt(0);
      if (typeof window.showToast === 'function') window.showToast('🌟 算法日推漫游已开启：' + tracks.length + ' 首无缝推流（超懂你胃口）');
      return tracks;
    }).catch(function () {
      return window.startPersonalFmMode();
    });
  };

  window.trashCurrentFmTrack = function () {
    var queue = window.playQueue || [];
    var song = window.currentIdx >= 0 && queue[window.currentIdx];
    if (song && song.id) {
      var url = '/api/fm_trash?id=' + encodeURIComponent(song.id);
      if (window.apiJson) window.apiJson(url, { method: 'POST' }).catch(function () {});
      else fetch(url, { method: 'POST' }).catch(function () {});
      if (typeof window.showToast === 'function') window.showToast('🗑️ 已放入算法垃圾桶，不再为您推荐此曲');
    }
    if (typeof window.nextTrack === 'function') window.nextTrack(true);
  };

  // 2. 包装首页卡片动作（若存在）
  if (typeof window.playHomeDaily === 'function') {
    var prevHomeDaily = window.playHomeDaily;
    window.playHomeDaily = function () {
      return window.startSuperDailyFeedMode();
    };
  }
  if (typeof window.playHomePrivateRadio === 'function') {
    window.playHomePrivateRadio = function () {
      return window.startPersonalFmMode();
    };
  }

  // 3. 包装 rebuildUserPlaylistsFromCatalog 自动在歌单列表中置顶卡片
  var origRebuild = window.rebuildUserPlaylistsFromCatalog;
  if (typeof origRebuild === 'function') {
    window.rebuildUserPlaylistsFromCatalog = function (opts) {
      origRebuild.apply(this, arguments);
      var loggedIn = !!(window.loginStatus && window.loginStatus.loggedIn);
      var extra = [
        {
          provider: 'netease',
          source: 'netease',
          type: 'playlist',
          id: 'super-daily-feed',
          name: '🌟 每日推荐 · 刷歌漫游',
          cover: 'https://p1.music.126.net/1y9-nQ9wB5-z_g4t7W-2tw==/109951165434200000.jpg',
          trackCount: '无限漫游',
          creator: '双算法推荐引擎（网易云品味 × 汽水信息流）',
        },
        {
          provider: 'netease',
          source: 'netease',
          type: 'playlist',
          id: 'netease-cloud-disk',
          name: '☁️ 音乐云盘 / 本地私有仓',
          cover: 'https://p1.music.126.net/0t48z7q29v-mS7-H3oE0vw==/109951165434199924.jpg',
          trackCount: loggedIn ? '云端已同步' : '本地私有曲库',
          creator: loggedIn ? '网易云音乐云盘' : '本地曲库',
        },
        {
          provider: 'netease',
          source: 'netease',
          type: 'playlist',
          id: 'netease-recent-played',
          name: '⏱️ 最近播放歌曲',
          cover: 'https://p1.music.126.net/y_m0t9sX_k7P1c8oJ_f_6Q==/109951165434208477.jpg',
          trackCount: '最近听过',
          creator: loggedIn ? '云端同步' : '播放器本地记录',
        },
        {
          provider: 'netease',
          source: 'netease',
          type: 'playlist',
          id: 'netease-toplist',
          name: '🏆 官方权威榜单',
          cover: 'https://p1.music.126.net/DrrB9-b4u8wQ5xQ-2h1t1w==/109951165434200000.jpg',
          trackCount: '飙升/新歌/热歌/原创',
          creator: '官方权威更新',
        }
      ];
      if (Array.isArray(window.userPlaylists)) {
        var existingKeys = new Set(window.userPlaylists.map(function (p) { return p.provider + ':' + p.id; }));
        var toPrepend = extra.filter(function (p) { return !existingKeys.has(p.provider + ':' + p.id); });
        if (toPrepend.length) {
          window.userPlaylists = toPrepend.concat(window.userPlaylists);
        }
      }
    };
  }

  // 4. 包装 fetchPlaylistTracksPage 拦截专用虚拟歌单
  var origFetchPage = window.fetchPlaylistTracksPage;
  if (typeof origFetchPage === 'function') {
    window.fetchPlaylistTracksPage = function (provider, id, params, requestOptions) {
      if (provider === 'netease') {
        if (id === 'super-daily-feed') {
          return (window.apiJson ? window.apiJson('/api/feed/super-daily', requestOptions || {}) : fetch('/api/feed/super-daily').then(function (r) { return r.json(); })).then(function (r) {
            var count = Number(r && r.count) || (r && r.tracks && r.tracks.length) || 0;
            return {
              playlistMeta: {
                id: 'super-daily-feed',
                name: '🌟 每日推荐 · 刷歌漫游',
                trackCount: count,
                cover: 'https://p1.music.126.net/1y9-nQ9wB5-z_g4t7W-2tw==/109951165434200000.jpg',
                description: '双推荐算法引擎融合推流：结合网易云深度品味算法与汽水音乐信息流推荐引擎，实时感知心流，无限漫游',
              },
              rawTracks: r && r.tracks || [],
              total: count,
              offset: 0,
              limit: count,
              nextOffset: count,
              hasMore: false,
            };
          });
        }
        if (id === 'netease-cloud-disk') {
          var limit = params && params.limit || 50;
          var offset = params && params.offset || 0;
          return (window.apiJson ? window.apiJson('/api/user/cloud?limit=' + limit + '&offset=' + offset, requestOptions || {}) : fetch('/api/user/cloud?limit=' + limit + '&offset=' + offset).then(function (r) { return r.json(); })).then(function (r) {
            var rawTracks = r && r.tracks || [];
            var msg = '';
            if (r && r.isGuest && !rawTracks.length) {
              msg = '未登录网易云。您可以随时拖拽音频文件到播放器作为本地私有仓，或在设置中登录同步云盘。';
            }
            var count = Number(r && r.count) || rawTracks.length;
            return {
              playlistMeta: { id: 'netease-cloud-disk', name: '☁️ 音乐云盘 / 本地私有仓', trackCount: count, cover: 'https://p1.music.126.net/0t48z7q29v-mS7-H3oE0vw==/109951165434199924.jpg' },
              rawTracks: rawTracks,
              total: count,
              offset: offset,
              limit: limit,
              nextOffset: offset + rawTracks.length,
              hasMore: !!(r && r.hasMore),
              message: msg,
            };
          });
        }
        if (id === 'netease-recent-played') {
          return (window.apiJson ? window.apiJson('/api/record/recent/song?limit=100', requestOptions || {}) : fetch('/api/record/recent/song?limit=100').then(function (r) { return r.json(); })).then(function (r) {
            var rawTracks = r && r.tracks || [];
            var queue = window.playQueue || [];
            if ((!rawTracks || !rawTracks.length) && queue.length) rawTracks = queue.slice(0, 30);
            var count = Number(r && r.total) || rawTracks.length;
            return {
              playlistMeta: { id: 'netease-recent-played', name: '⏱️ 最近播放歌曲', trackCount: count, cover: 'https://p1.music.126.net/y_m0t9sX_k7P1c8oJ_f_6Q==/109951165434208477.jpg' },
              rawTracks: rawTracks,
              total: count,
              offset: 0,
              limit: count,
              nextOffset: count,
              hasMore: false,
            };
          });
        }
        if (id === 'netease-toplist') {
          return (window.apiJson ? window.apiJson('/api/toplist', requestOptions || {}) : fetch('/api/toplist').then(function (r) { return r.json(); })).then(function (r) {
            var list = r && r.list || [];
            var firstToplistId = list.length && list[0].id ? list[0].id : 19723756;
            return (window.apiJson ? window.apiJson('/api/playlist/tracks?id=' + firstToplistId, requestOptions || {}) : fetch('/api/playlist/tracks?id=' + firstToplistId).then(function (tr) { return tr.json(); })).then(function (tr) {
              return {
                playlistMeta: {
                  id: 'netease-toplist',
                  name: '🏆 官方权威榜单 · ' + ((list[0] && list[0].name) || '飙升榜'),
                  trackCount: tr && tr.playlist && tr.playlist.trackCount || (tr && tr.tracks && tr.tracks.length) || 0,
                  cover: (list[0] && list[0].cover) || 'https://p1.music.126.net/DrrB9-b4u8wQ5xQ-2h1t1w==/109951165434200000.jpg',
                },
                rawTracks: tr && tr.tracks || [],
                total: tr && tr.tracks && tr.tracks.length || 0,
                hasMore: false,
              };
            });
          });
        }
      }
      return origFetchPage.apply(this, arguments);
    };
  }

  // 5. 心动模式与相似歌曲挂载
  window.startSongIntelligenceMode = function (songId) {
    if (!songId) { if (typeof window.showToast === 'function') window.showToast('当前歌曲不支持心动模式'); return; }
    if (typeof window.showToast === 'function') window.showToast('正在开启心动模式...');
    var modal = document.getElementById('track-detail-modal');
    if (modal && typeof window.closeGsapModal === 'function') window.closeGsapModal(modal);
    var endpoint = '/api/playmode/intelligence/list?id=' + encodeURIComponent(songId);
    (window.apiJson ? window.apiJson(endpoint) : fetch(endpoint).then(function (r) { return r.json(); })).then(function (r) {
      var tracks = r && r.tracks || [];
      if (!tracks.length) {
        if (typeof window.showToast === 'function') window.showToast('未能获取到心动推荐歌曲');
        return;
      }
      window.playQueue = tracks;
      window.currentIdx = 0;
      window.playMode = 'fm';
      syncFmTrashButtonVisibility('fm');
      if (typeof window.updatePlayModeButton === 'function') window.updatePlayModeButton(true);
      if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('intelligence-mode-start');
      if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('intelligence-mode-start', true);
      if (typeof window.playQueueAt === 'function') window.playQueueAt(0);
      if (typeof window.showToast === 'function') window.showToast('💓 心动模式已开启，已载入 ' + tracks.length + ' 首推荐曲目');
    }).catch(function (err) {
      if (typeof window.showToast === 'function') window.showToast('心动模式开启失败: ' + (err.message || ''));
    });
  };

  window.loadSongSimilarTracks = function (songId) {
    if (!songId) { if (typeof window.showToast === 'function') window.showToast('当前歌曲不支持相似推荐'); return; }
    if (typeof window.showToast === 'function') window.showToast('正在寻找相似歌曲...');
    var endpoint = '/api/song/similar?id=' + encodeURIComponent(songId);
    (window.apiJson ? window.apiJson(endpoint) : fetch(endpoint).then(function (r) { return r.json(); })).then(function (r) {
      var tracks = r && r.tracks || [];
      if (!tracks.length) {
        if (typeof window.showToast === 'function') window.showToast('未找到相似歌曲');
        return;
      }
      var modal = document.getElementById('track-detail-modal');
      if (modal && typeof window.closeGsapModal === 'function') window.closeGsapModal(modal);
      var currentSong = typeof window.currentCoverSong === 'function' ? window.currentCoverSong() : null;
      var newQueue = currentSong ? [currentSong].concat(tracks) : tracks;
      window.playQueue = newQueue;
      window.currentIdx = 0;
      if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('simi-tracks-loaded');
      if (typeof window.safeShelfRebuild === 'function') window.safeShelfRebuild('simi-tracks-loaded', true);
      if (typeof window.showToast === 'function') window.showToast('🎵 已载入 ' + tracks.length + ' 首相似歌曲到播放列表');
    }).catch(function (err) {
      if (typeof window.showToast === 'function') window.showToast('相似歌曲获取失败: ' + (err.message || ''));
    });
  };

  // 6. 包装 doSearch 识别网易云分享链接
  var origDoSearch = window.doSearch;
  if (typeof origDoSearch === 'function') {
    window.doSearch = function (q, opts) {
      var text = String(q || '').trim();
      var match = text.match(/music\.163\.com.*?[?&]id=(\d+)/i) || text.match(/playlist\/(\d+)/i);
      if (match && !/song\?id=/i.test(text)) {
        var plId = match[1];
        if (typeof window.showToast === 'function') window.showToast('已识别歌单分享链接 ID: ' + plId);
        if (typeof window.openPlaylistPanelDetail === 'function') {
          window.openPlaylistPanelDetail('netease', plId, { name: '歌单 ' + plId });
          return Promise.resolve();
        }
      }
      return origDoSearch.apply(this, arguments);
    };
  }

  // 7. 动态注入界面显性入口：顶部快捷探索胶囊栏与 FM 垃圾桶
  function injectVisibleControls() {
    // 注入顶部胶囊栏
    if (!document.getElementById('quick-explore-chips')) {
      var searchStack = document.getElementById('search-stack');
      var searchBox = document.getElementById('search-box');
      if (searchStack && searchBox) {
        var chips = document.createElement('div');
        chips.id = 'quick-explore-chips';
        chips.className = 'quick-explore-chips';
        chips.setAttribute('role', 'toolbar');
        chips.setAttribute('aria-label', '快捷探索');
        chips.innerHTML = [
          '<button class="explore-chip" type="button" onclick="startSuperDailyFeedMode()" title="双算法日推与刷歌漫游（网易云品味 × 汽水信息流引擎）"><span class="explore-chip-icon">🌟</span><span class="explore-chip-label">每日推荐</span></button>',
          '<button class="explore-chip" type="button" onclick="startPersonalFmMode()" title="私人电台智能漫游（带算法垃圾桶淘汰）"><span class="explore-chip-icon">📻</span><span class="explore-chip-label">私人电台</span></button>',
          '<button class="explore-chip" type="button" onclick="openPlaylistPanelDetail(\'netease\', \'netease-toplist\', { name: \'官方权威榜单\' })" title="查看官方飙升/新歌/热歌/原创榜"><span class="explore-chip-icon">🏆</span><span class="explore-chip-label">官方榜单</span></button>',
          '<button class="explore-chip" type="button" onclick="openPlaylistPanelDetail(\'netease\', \'netease-cloud-disk\', { name: \'音乐云盘 / 本地私有仓\' })" title="打开我的音乐云盘与本地私有曲库"><span class="explore-chip-icon">☁️</span><span class="explore-chip-label">音乐云盘</span></button>',
          '<button class="explore-chip" type="button" onclick="typeof playHomeRecent === \'function\' ? playHomeRecent() : openPlaylistPanelDetail(\'netease\', \'netease-recent-played\', { name: \'最近播放歌曲\' })" title="听最近播放过的歌曲"><span class="explore-chip-icon">⏱️</span><span class="explore-chip-label">最近播放</span></button>',
        ].join('');
        searchBox.insertAdjacentElement('afterend', chips);
      }
    }

    // 注入控制栏垃圾桶
    if (!document.getElementById('fm-trash-btn')) {
      var nextBtn = document.getElementById('next-btn');
      if (nextBtn && nextBtn.parentNode) {
        var trashBtn = document.createElement('button');
        trashBtn.id = 'fm-trash-btn';
        trashBtn.className = 'ctrl-btn';
        trashBtn.setAttribute('title', '不喜欢（算法垃圾桶淘汰，不再推荐此曲）');
        trashBtn.style.display = window.playMode === 'fm' ? 'inline-flex' : 'none';
        trashBtn.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>';
        trashBtn.onclick = window.trashCurrentFmTrack;
        nextBtn.insertAdjacentElement('afterend', trashBtn);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectVisibleControls);
  } else {
    injectVisibleControls();
  }

  console.log('[mods:netease-supercharged] 双推荐算法引擎与超级增强功能已就绪');
})();

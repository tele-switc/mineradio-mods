// ============================================================
//  mineradio-mods: 全局只播能完整听完的歌 + 实时反馈
//
//  用户口径（2026-10-24）：整个软件不允许出现只能听 30~60 秒试听的歌。
//  这一层做四件事：
//   1. 搜索/歌单/存档恢复先按元数据整条过滤（试听/会员/无版权/数字专辑）；
//   2. 播放数据再加一道硬闸门：trial/preview 一律改成无地址，交给上游自动换源/跳下一首；
//   3. 记录本机垃圾桶与短播跳过，下一次日推立即排除/降权；
//   4. 给 70 号模块提供 buildTasteSeeds()：把实时听歌历史、垃圾桶、跳过一起发给后端。
// ============================================================
(function () {
  'use strict';
  if (window.__mrModsFullPlaybackInstalled) return;
  window.__mrModsFullPlaybackInstalled = true;

  var FEEDBACK_KEY = 'mineradio-mods-feedback-v1';
  var MAX_TRASH = 300;
  var MAX_SKIPS = 200;

  function normalizeText(value) {
    return String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[（(【\[].*?[）)】\]]/g, ' ')
      .replace(/[\s·・\-—_.,，。:：\u0027\u0022“”‘’/\\|!?！？]+/g, ' ')
      .trim();
  }

  function songKey(song) {
    if (!song) return '';
    return normalizeText(String(song.name || '') + ' ' + String(song.artist || '')).replace(/\s+/g, '');
  }

  function providerKey(song) {
    var raw = String((song && (song.provider || song.source || song.type)) || '').toLowerCase();
    if (raw === 'podcast' || raw === 'local' || raw === 'bilibili' || raw === 'internetarchive' ||
        raw === 'radioparadise' || raw === 'qq' || raw === 'kugou' || raw === 'qishui' ||
        raw === 'migu' || raw === 'spotify') return raw;
    return 'netease';
  }

  function providerVip(provider) {
    var status = null;
    if (provider === 'netease') status = window.loginStatus;
    else if (provider === 'qq') status = window.qqLoginStatus;
    else if (provider === 'kugou') status = window.kugouLoginStatus;
    else if (provider === 'qishui') status = window.qishuiLoginStatus;
    else if (provider === 'spotify') status = window.spotifyLoginStatus;
    if (!status) return false;
    return !!(status.isVip || status.isSvip || status.vipLevel === 'vip' || status.vipLevel === 'svip' ||
      (provider === 'spotify' && /premium/i.test(String(status.product || ''))));
  }

  function songCannotPlayFully(song) {
    if (!song) return true;
    var provider = providerKey(song);
    if (provider === 'local' || provider === 'podcast' || provider === 'bilibili' ||
        provider === 'internetarchive' || provider === 'radioparadise') return false;
    if (song.localUrl || song.localKey || song.type === 'local' || song.source === 'local') return false;
    if (song.trial === true || song.preview === true || song.freeTrialInfo) return true;
    if (song.privilege && typeof song.privilege === 'object') {
      if (Number(song.privilege.st) < 0) return true;
      if (Number(song.privilege.pl) === 0) return true;
    }
    if (song.noCopyrightRcmd) return true;

    var fee = Number(song.fee) || 0;
    var vip = providerVip(provider);
    if (provider === 'netease') {
      if (fee === 4) return true;
      if (fee === 1 && !vip) return true;
      if (song.playable === false) return true;
      return false;
    }
    if (provider === 'qq') {
      var label = song.label_info || song.labelInfo || {};
      var vipLocked = !!(label.only_vip_playable || label.onlyVipPlayable || song.onlyVipPlayable ||
        song.only_vip_playable || song.vipRequired || song.needVip);
      return (fee > 0 || vipLocked) && !vip;
    }
    if (provider === 'kugou') {
      var privilege = Number(song.privilege);
      if (isFinite(privilege) && privilege > 8 && !vip) return true;
      return (song.vipRequired || song.onlyVipPlayable || fee > 0) && !vip;
    }
    if (provider === 'migu') return song.canListen === false || song.trialLimited === true;
    if (provider === 'qishui') return fee > 0 && !vip;
    if (provider === 'spotify') return song.playable === false && !vip;
    return false;
  }

  function filterFullyPlayable(list) {
    return (Array.isArray(list) ? list : []).filter(function (song) { return !songCannotPlayFully(song); });
  }

  // ---------- 本机实时反馈 ----------
  function readFeedback() {
    try {
      var raw = localStorage.getItem(FEEDBACK_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return {
        trash: data && Array.isArray(data.trash) ? data.trash : [],
        skips: data && data.skips && typeof data.skips === 'object' ? data.skips : {},
      };
    } catch (_) {
      return { trash: [], skips: {} };
    }
  }

  function writeFeedback(state) {
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        trash: (state.trash || []).slice(-MAX_TRASH),
        skips: state.skips || {},
      }));
    } catch (_) {}
  }

  function markTrash(song) {
    if (!song) return;
    var key = songKey(song);
    if (!key) return;
    var fb = readFeedback();
    if (!fb.trash.some(function (item) { return item && item.key === key; })) {
      fb.trash.push({ key: key, name: song.name || '', artist: song.artist || '', at: Date.now() });
    }
    delete fb.skips[key];
    writeFeedback(fb);
  }

  function markSkip(song) {
    if (!song) return;
    var provider = providerKey(song);
    if (provider === 'local' || provider === 'podcast' || provider === 'radioparadise') return;
    var key = songKey(song);
    if (!key) return;
    var fb = readFeedback();
    if (fb.trash.some(function (item) { return item && item.key === key; })) return;
    var entry = fb.skips[key] || { key: key, name: song.name || '', artist: song.artist || '', count: 0, at: 0 };
    entry.name = song.name || entry.name;
    entry.artist = song.artist || entry.artist;
    entry.count = (Number(entry.count) || 0) + 1;
    entry.at = Date.now();
    fb.skips[key] = entry;
    var keys = Object.keys(fb.skips);
    if (keys.length > MAX_SKIPS) {
      keys.sort(function (a, b) { return (fb.skips[a].at || 0) - (fb.skips[b].at || 0); });
      keys.slice(0, keys.length - MAX_SKIPS).forEach(function (oldKey) { delete fb.skips[oldKey]; });
    }
    writeFeedback(fb);
  }

  function recordSkipIfNeeded() {
    var queue = window.playQueue || [];
    var idx = Number(window.currentIdx);
    var song = idx >= 0 ? queue[idx] : null;
    if (!song) return;
    var audioEl = window.audio;
    var listened = audioEl ? (Number(audioEl.currentTime) || 0) : 0;
    var duration = audioEl ? (Number(audioEl.duration) || 0) : 0;
    if (duration > 0 && listened / duration >= 0.3) return;
    if (listened >= 30) return;
    markSkip(song);
  }

  function buildTasteSeeds() {
    try {
      var stats = typeof window.loadListenStatsState === 'function' ? window.loadListenStatsState() : null;
      var songs = stats && stats.songs ? Object.keys(stats.songs).map(function (key) { return stats.songs[key]; }) : [];
      var quality = function (item) {
        return (Number(item.plays) || 0) + (Number(item.completed) || 0) * 2 + (Number(item.listenMs) || 0) / 60000;
      };
      songs.sort(function (a, b) { return quality(b) - quality(a); });
      var history = stats && Array.isArray(stats.history) ? stats.history.slice(0, 30) : [];
      var keywords = typeof window.readSearchHistory === 'function' ? window.readSearchHistory().slice(0, 12) : [];
      var fb = readFeedback();
      return {
        keywords: keywords,
        artists: stats && stats.artists ? Object.keys(stats.artists) : [],
        anchorSongs: songs.slice(0, 12).map(function (song) {
          return {
            name: song.name,
            artist: song.artist,
            plays: song.plays,
            listenMs: song.listenMs,
            completed: song.completed,
            raw: song,
          };
        }),
        history: history.map(function (item) {
          return {
            key: item.key,
            id: item.id,
            name: item.name,
            artist: item.artist,
            completed: !!item.completed,
            listenMs: Number(item.listenMs) || 0,
            playedAt: Number(item.playedAt) || 0,
            provider: item.provider || '',
            sourceKey: item.sourceKey || '',
            type: item.type || '',
          };
        }),
        trashKeys: fb.trash.map(function (item) { return item.key; }).filter(Boolean),
        skips: Object.keys(fb.skips).map(function (key) { return fb.skips[key]; }),
      };
    } catch (_) {
      return null;
    }
  }

  window.__mrModsBuildTasteSeeds = buildTasteSeeds;
  window.__mrModsMarkTrash = markTrash;
  window.__mrModsMarkSkip = markSkip;
  window.__mrModsSongCannotPlayFully = songCannotPlayFully;

  // ---------- 播放硬闸门 ----------
  function isTrialResponse(data) {
    if (!data) return false;
    if (data.trial === true || data.preview === true || data.freeTrialInfo) return true;
    var restriction = data.restriction || {};
    return /trial_only|preview_only/i.test(String(restriction.category || restriction.reason || data.category || data.reason || ''));
  }

  window.__mrModsGuardPlaybackData = function (data) {
    if (!isTrialResponse(data)) return data;
    return Object.assign({}, data, {
      url: '',
      trial: true,
      playable: false,
      reason: 'trial_only',
      category: 'trial_only',
      message: '该版本只能试听片段，已按“只播放能完整听完的歌”跳过',
      restriction: Object.assign({}, data && data.restriction || {}, {
        category: 'trial_only',
        reason: 'trial_only',
        message: '仅提供试听片段，已跳过',
      }),
    });
  };

  // 兜底：即使没有安装 13-playback 的锚点，任何取址响应只要带 trial 也不许进音频元素
  var originalApiJson = window.apiJson;
  if (typeof originalApiJson === 'function' && !originalApiJson.__mrModsTrialGuarded) {
    var guardedApiJson = async function (url) {
      var data = await originalApiJson.apply(this, arguments);
      if (data && /^\/api\/(song|qq\/song|kugou\/song|migu\/song|qishui\/song|spotify\/song)\/url/.test(String(url || ''))) {
        return window.__mrModsGuardPlaybackData(data);
      }
      return data;
    };
    guardedApiJson.__mrModsTrialGuarded = true;
    window.apiJson = guardedApiJson;
  }

  var originalFallback = window.tryAutoPlaybackFallback;
  if (typeof originalFallback === 'function') {
    window.tryAutoPlaybackFallback = function (song, data, idx, token, opts) {
      var args = Array.prototype.slice.call(arguments);
      if (data && isTrialResponse(data)) args[1] = window.__mrModsGuardPlaybackData(data);
      return originalFallback.apply(this, args);
    };
  }

  // ---------- 列表过滤 ----------
  var originalSearch = window.fetchMusicSearchResults;
  if (typeof originalSearch === 'function') {
    window.fetchMusicSearchResults = function () {
      var self = this;
      var args = arguments;
      return Promise.resolve(originalSearch.apply(self, args)).then(function (result) {
        if (result && Array.isArray(result.songs)) {
          var kept = filterFullyPlayable(result.songs);
          var hidden = result.songs.length - kept.length;
          if (hidden > 0) {
            result = Object.assign({}, result, { songs: kept, hiddenUnplayable: hidden });
            try {
              if (!window.searchProviderNotice) {
                window.searchProviderNotice = '已隐藏 ' + hidden + ' 首只能试听或需要会员的歌曲';
              }
            } catch (_) {}
          }
        }
        return result;
      });
    };
    window.__mrModsSearchFilterInstalled = true;
  }

  var originalPlaylist = window.fetchPlaylistTracksPage;
  if (typeof originalPlaylist === 'function') {
    window.fetchPlaylistTracksPage = function () {
      var self = this;
      var args = arguments;
      return Promise.resolve(originalPlaylist.apply(self, args)).then(function (result) {
        if (result && Array.isArray(result.tracks)) {
          var kept = filterFullyPlayable(result.tracks);
          if (kept.length !== result.tracks.length) {
            return Object.assign({}, result, {
              tracks: kept,
              hiddenUnplayable: result.tracks.length - kept.length,
            });
          }
        }
        return result;
      });
    };
  }

  // ---------- 跳过 / 存档恢复 ----------
  var originalNextTrack = window.nextTrack;
  if (typeof originalNextTrack === 'function') {
    window.nextTrack = function (userInitiated) {
      if (userInitiated === true) recordSkipIfNeeded();
      return originalNextTrack.apply(this, arguments);
    };
  }

  var originalRestore = window.restoreLastPlaybackSnapshot;
  if (typeof originalRestore === 'function') {
    window.restoreLastPlaybackSnapshot = function () {
      var restored = originalRestore.apply(this, arguments);
      if (restored && Array.isArray(window.playQueue)) {
        var kept = filterFullyPlayable(window.playQueue);
        if (kept.length !== window.playQueue.length) {
          window.playQueue = kept;
          if (window.currentIdx >= kept.length) window.currentIdx = kept.length - 1;
          if (typeof window.safeRenderQueuePanel === 'function') window.safeRenderQueuePanel('mods-full-playback-filter');
        }
      }
      return restored;
    };
  }

  console.log('[mods:full-playback] 试听片段拦截与实时反馈已就绪');
})();

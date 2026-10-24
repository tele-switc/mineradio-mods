// ============================================================
//  mineradio-mods: 日推推荐引擎
//
//  2026-10-24 重构：
//   - 不再拿搜索历史碎片词去搜歌单/搜歌（"wa" 会召回一堆翻唱），改用真实听歌锚点
//     走网易云 simi_song；中文题材交给 B 站完整音频。
//   - 所有候选先过"能完整听完"判据：试听片段、会员曲、无版权、数字专辑、pl=0 全部不要。
//   - 接受客户端实时反馈（trashKeys / skips / history），跳过的不再推、听完整的加权。
// ============================================================

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tasteNormalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, ' ')
    .replace(/[\s·・\-—_.,，。:：\u0027\u0022“”‘’/\\|!?！？]+/g, ' ')
    .trim();
}

function cleanTasteQuery(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  const quoted = text.match(/《([^》]{1,60})》/);
  if (quoted && quoted[1].trim()) {
    const after = text.slice(quoted.index + quoted[0].length).replace(/^[^\w\u4e00-\u9fff]+/, ' ').trim();
    text = quoted[1].trim() + (after ? ' ' + after : '');
  }
  text = text
    .replace(/[“”\u0027\u0022‘’]/g, '')
    .replace(/全收集\s*\d+\s*首|合集\s*\d+\s*首|百万级录音棚听|高音质|无损|完整版|官方版|超清|4K/gi, ' ')
    .replace(/[|｜].*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 48 ? text.slice(0, 48).trim() : text;
}

function tasteKeywordLooksUseful(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 60) return false;
  if (/^(undefined|null|nan|test\d*)$/i.test(text)) return false;
  if (/^[\x00-\x7F]+$/.test(text) && text.replace(/[^a-z0-9]/gi, '').length < 3) return false;
  if (/^[^\w\u4e00-\u9fff]+$/.test(text)) return false;
  return true;
}

function normalizeTasteKeywordList(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(raw => {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!tasteKeywordLooksUseful(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  const compactKey = value => tasteNormalizeText(value).replace(/\s+/g, '');
  return out
    .sort((a, b) => compactKey(b).length - compactKey(a).length)
    .filter((item, index, arr) => !arr.some((other, otherIndex) =>
      otherIndex !== index && compactKey(other).length > compactKey(item).length &&
      compactKey(other).startsWith(compactKey(item))))
    .slice(0, 8);
}

function tasteTitleKey(song) {
  if (!song) return '';
  return tasteNormalizeText(String(song.name || '') + ' ' + String(song.artist || '')).replace(/\s+/g, '');
}

function tasteArtistKey(song) {
  const raw = String(song && song.artist || '');
  const primary = raw.split(/\s*\/\s*|\s*,\s*/)[0] || raw;
  return tasteNormalizeText(primary);
}

function recommendationNoisePenalty(song, tasteText) {
  tasteText = String(tasteText || '').toLowerCase();
  const text = String(song && song.name || '').toLowerCase();
  let penalty = 0;
  if (/翻唱|cover|翻自/.test(text) && !/翻唱|cover/.test(tasteText)) penalty += 26;
  if (/伴奏|karaoke|instrumental|纯音乐/.test(text) && !/伴奏|纯音乐|instrumental/.test(tasteText)) penalty += 32;
  if (/\blive\b|现场/.test(text) && !/live|现场/.test(tasteText)) penalty += 12;
  if (/\bdj\b|remix|混音/.test(text) && !/dj|串烧|mix/.test(tasteText)) penalty += 10;
  if (/加速|降调|slowed|sped up/.test(text) && !/加速|降调|dj|串烧/.test(tasteText)) penalty += 10;
  if (/铃声|彩铃|试听|片段|教学|讲解|reaction/i.test(text)) penalty += 40;
  return penalty;
}

function recommendationWithTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || 'RECOMMENDATION_TIMEOUT')), ms);
    Promise.resolve(promise).then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function recommendationWithRetry(taskFactory, ms, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await recommendationWithTimeout(taskFactory(), ms, label);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

function recommendationBiliCore(keyword) {
  return String(keyword || '')
    .replace(/b\s*'?\s*g\s*'?\s*m/gi, ' ')
    .replace(/dj\s*大?串烧|大?串烧|bgm|合集|音乐|歌曲|主题曲|片头|片尾|完整版|高音质|无损|降调|加速|dj版?/gi, ' ')
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || String(keyword || '').trim();
}

function recommendationBiliLooksRelevant(song, core) {
  const tokens = String(core || '').split(/\s+/).filter(token => token.length >= 2);
  if (!tokens.length) return true;
  const text = [
    song && song.name,
    song && song.artist,
    song && song.categoryName,
    Array.isArray(song && song.tags) ? song.tags.join(' ') : '',
  ].join(' ').toLowerCase();
  return tokens.some(token => text.includes(token.toLowerCase()));
}

function recommendationBiliMusicLike(song) {
  const duration = Number(song && song.duration) || 0;
  if (duration && duration < 45) return false;
  if (duration > 7200) return false;
  const title = String(song && song.name || '');
  const category = String(song && song.categoryName || '');
  return song && song.musicCategory === true ||
    /完整|纯享|原声|主题曲|歌曲|纯音乐|无损|hi-?res|合集|串烧|bgm|音乐|翻唱|演奏|live|现场/i.test(title) ||
    /音乐|MV|翻唱|演奏|现场|歌曲|纯享|古风|国风/.test(category);
}

function recommendationBiliScorePenalty(song) {
  const duration = Number(song && song.duration) || 0;
  let penalty = 0;
  if (duration > 3600) penalty += Math.min(30, 10 + (duration - 3600) / 600);
  if (duration && duration < 90) penalty += 10;
  if (song && song.isCompilation) penalty += 6;
  return penalty;
}

function recommendationAnchorSignature(anchor) {
  const title = String(anchor && anchor.name || '');
  const quoted = title.match(/《([^》]{2,50})》/);
  const songName = quoted ? tasteNormalizeText(quoted[1]) : '';
  const artistHint = quoted
    ? tasteNormalizeText(title.slice(quoted.index + quoted[0].length))
    : '';
  const duration = Number(anchor && (anchor.duration || (anchor.raw && anchor.raw.duration))) || 0;
  const isCompilation = /合集|串烧|全收集|首/.test(title) || duration > 600;
  return { songName, artistHint, duration, isCompilation };
}

function recommendationBiliDuplicatesAnchor(song, signatures) {
  if (!song || !Array.isArray(signatures) || !signatures.length) return false;
  const haystack = tasteNormalizeText(String(song.name || '') + ' ' + (Array.isArray(song.tags) ? song.tags.join(' ') : ''));
  const duration = Number(song.duration) || 0;
  return signatures.some(signature => {
    if (!signature.songName || signature.isCompilation) return false;
    if (!haystack.includes(signature.songName)) return false;
    const artistTokens = signature.artistHint.split(/\s+/).filter(token => token.length >= 3);
    if (artistTokens.length && !artistTokens.some(token => haystack.includes(token))) return false;
    if (signature.duration && duration &&
        Math.abs(duration - signature.duration) > Math.max(40, signature.duration * 0.25)) return false;
    return true;
  });
}

function modSongProviderKey(song) {
  const raw = String((song && (song.provider || song.source || song.type)) || '').toLowerCase();
  if (raw === 'podcast' || raw === 'local' || raw === 'bilibili' || raw === 'internetarchive' ||
      raw === 'radioparadise') return raw;
  return 'netease';
}

function ncmSongIsFullyPlayable(song, ctx) {
  ctx = ctx || {};
  if (!song) return false;
  if (song.trial === true || song.preview === true || song.freeTrialInfo) return false;
  const provider = modSongProviderKey(song);
  if (provider !== 'netease') return true;
  if (song.localUrl || song.localKey || song.type === 'local' || song.source === 'local') return true;
  if (song.privilege && typeof song.privilege === 'object') {
    if (Number(song.privilege.st) < 0) return false;
    if (Number(song.privilege.pl) === 0) return false;
  }
  if (song.noCopyrightRcmd) return false;
  const fee = Number(song.fee) || 0;
  if (fee === 4) return false;
  if (fee === 1 && !ctx.neteaseVip) return false;
  if (song.playable === false) return false;
  return true;
}

function filterNcmFullyPlayableSongs(songs, ctx) {
  return (Array.isArray(songs) ? songs : []).filter(song => ncmSongIsFullyPlayable(song, ctx));
}

function extractTasteSeeds(clientSeeds) {
  const seeds = {
    keywords: [],
    artists: [],
    anchorSongs: [],
    heardSongs: [],
    history: [],
    trashKeys: [],
    skipKeys: [],
    skipArtists: {},
  };

  if (clientSeeds && typeof clientSeeds === 'object') {
    if (Array.isArray(clientSeeds.keywords)) {
      clientSeeds.keywords.forEach(k => { if (k && typeof k === 'string') seeds.keywords.push(k.trim()); });
    }
    if (Array.isArray(clientSeeds.artists)) {
      clientSeeds.artists.forEach(a => { if (a && typeof a === 'string') seeds.artists.push(a.trim()); });
    }
    if (Array.isArray(clientSeeds.anchorSongs)) {
      seeds.anchorSongs = clientSeeds.anchorSongs.filter(s => s && s.name);
    }
    if (Array.isArray(clientSeeds.history)) {
      seeds.history = clientSeeds.history.filter(item => item && item.name).slice(0, 40);
      seeds.history.forEach(item => seeds.heardSongs.push({ name: item.name, artist: item.artist }));
    }
    if (Array.isArray(clientSeeds.trashKeys)) {
      clientSeeds.trashKeys.forEach(key => {
        if (key) seeds.trashKeys.push(String(key));
      });
    }
    if (Array.isArray(clientSeeds.skips)) {
      clientSeeds.skips.forEach(item => {
        if (!item) return;
        const skillKey = item.key || tasteTitleKey({ name: item.name, artist: item.artist });
        if (skillKey) seeds.skipKeys.push(String(skillKey));
        const artist = String(item.artist || '').split(/\s*\/\s*|\s*,\s*/)[0].trim();
        const artistKey = artist ? tasteArtistKey({ artist }) : '';
        if (artistKey) seeds.skipArtists[artistKey] = (Number(seeds.skipArtists[artistKey]) || 0) + (Number(item.count) || 1);
      });
    }
  }

  try {
    const archivePath = path.join(process.env.APPDATA || (os.homedir() + '/AppData/Roaming'), 'Mineradio', 'mineradio-danger-archive.json');
    if (fs.existsSync(archivePath)) {
      const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      if (archiveData && Array.isArray(archiveData.archives)) {
        const songMap = new Map();
        const artistMap = new Map();
        const archiveKeywords = [];

        for (const arc of archiveData.archives) {
          const searchStr = arc.state && arc.state['mineradio-search-history'];
          if (searchStr) {
            try {
              const sh = JSON.parse(searchStr);
              const items = Array.isArray(sh.items) ? sh.items : (Array.isArray(sh) ? sh : []);
              items.forEach(q => archiveKeywords.push(q));
            } catch (_) {}
          }
          const statsStr = arc.state && arc.state['mineradio-listen-stats-v1'];
          if (statsStr) {
            try {
              const stats = JSON.parse(statsStr);
              if (stats.songs) {
                Object.values(stats.songs).forEach(s => {
                  if (!s || !s.name) return;
                  const key = tasteTitleKey(s);
                  const existing = songMap.get(key);
                  const plays = Number(s.plays) || 0;
                  const ms = Number(s.listenMs) || 0;
                  if (!existing || plays > existing.plays) {
                    songMap.set(key, { name: s.name, artist: s.artist, plays, listenMs: ms, raw: s });
                  }
                  seeds.heardSongs.push({ name: s.name, artist: s.artist });
                });
              }
              if (stats.artists) {
                Object.values(stats.artists).forEach(a => {
                  if (!a || !a.name) return;
                  artistMap.set(a.name, (artistMap.get(a.name) || 0) + Number(a.plays || 1));
                });
              }
            } catch (_) {}
          }
        }

        const quality = item => (Number(item.plays) || 0) +
          (Number(item.raw && item.raw.completed) || 0) * 2 +
          (Number(item.listenMs) || 0) / 60000;
        const sortedSongs = Array.from(songMap.values()).sort((a, b) => quality(b) - quality(a));
        if (!seeds.anchorSongs.length) seeds.anchorSongs = sortedSongs.slice(0, 10);
        seeds.keywords.push.apply(seeds.keywords, archiveKeywords);
        if (!seeds.artists.length) {
          seeds.artists = Array.from(artistMap.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 8);
        }
      }
    }
  } catch (e) {
    console.warn('[mods:recommend] 读取品味存档失败：' + (e && e.message || e));
  }

  if (!seeds.anchorSongs.length && seeds.history.length) {
    seeds.anchorSongs = seeds.history.slice(0, 10).map(item => ({
      name: item.name,
      artist: item.artist,
      plays: 1,
      listenMs: Number(item.listenMs) || 0,
      raw: item.raw || item,
    }));
  }

  seeds.keywords = normalizeTasteKeywordList(seeds.keywords);
  seeds.artists = Array.from(new Set((seeds.artists || [])
    .map(a => String(a || '').trim())
    .filter(a => a && !/未知|unknown|未知歌手/i.test(a))))
    .slice(0, 8);
  seeds.anchorSongs = seeds.anchorSongs
    .slice()
    .sort((a, b) => {
      const qa = (Number(a.plays) || 0) + (Number(a.raw && a.raw.completed) || 0) * 2 + (Number(a.listenMs) || 0) / 60000;
      const qb = (Number(b.plays) || 0) + (Number(b.raw && b.raw.completed) || 0) * 2 + (Number(b.listenMs) || 0) / 60000;
      return qb - qa;
    })
    .slice(0, 8);
  seeds.anchorSongs.forEach(a => seeds.heardSongs.push({ name: a.name, artist: a.artist }));
  seeds.trashKeys = Array.from(new Set(seeds.trashKeys.filter(Boolean)));
  seeds.skipKeys = Array.from(new Set(seeds.skipKeys.filter(Boolean)));
  return seeds;
}

async function fetchTasteAnchoredNcmRecommendations(ncmApi, limit = 24, clientSeeds = null, options = {}) {
  const seeds = extractTasteSeeds(clientSeeds);
  const ctx = options.ctx || {};
  const mapNcmSong = options.mapNcmSong;
  const biliApi = options.biliApi || null;
  const biliCookie = options.biliCookie || '';
  const cloudsearchApi = ncmApi.cloudsearch || ncmApi.search;
  const simiSongApi = ncmApi.simi_song || ncmApi['simi_' + 'song'];
  const trashKeys = new Set(seeds.trashKeys);
  const skipKeys = new Set(seeds.skipKeys);
  const skipArtists = new Map(Object.entries(seeds.skipArtists || {}));
  const heardKeys = new Set((seeds.heardSongs || []).map(tasteTitleKey).filter(Boolean));
  const seenKeys = new Set();
  const seenIds = new Set();
  const tasteText = [
    seeds.keywords.join(' '),
    seeds.artists.join(' '),
    seeds.anchorSongs.map(a => a.name).join(' '),
  ].join(' ').toLowerCase();

  async function searchNcm(keyword, pageLimit) {
    if (typeof cloudsearchApi !== 'function' || typeof mapNcmSong !== 'function') return [];
    try {
      const res = await recommendationWithRetry(
        () => cloudsearchApi({ keywords: keyword, type: 1, limit: pageLimit || 8, timestamp: Date.now() }),
        5500, 'NCM_SEARCH_TIMEOUT'
      );
      const body = res.body || res || {};
      const raw = (body.result && body.result.songs) || body.songs || [];
      return raw.map(mapNcmSong).filter(song => song && song.id);
    } catch (_) {
      return [];
    }
  }

  async function resolveNeteaseAnchorId(anchor) {
    const raw = anchor.raw || {};
    const provider = String(raw.provider || raw.sourceKey || anchor.provider || '').toLowerCase();
    const directId = raw.id || anchor.id;
    if (provider === 'netease' && /^\d+$/.test(String(directId || ''))) return String(directId);
    const query = cleanTasteQuery(anchor.name || raw.name);
    if (!query) return '';
    const found = await searchNcm(query, 8);
    const targetName = tasteNormalizeText(query);
    const targetArtist = tasteNormalizeText(anchor.artist || '');
    const targetDuration = Number(anchor.duration || raw.duration || 0) || 0;
    const targetTokens = targetName.split(/\s+/).filter(token => token.length >= 3);
    let best = null;
    found.forEach(song => {
      const name = tasteNormalizeText(song.name);
      const artist = tasteNormalizeText(song.artist);
      const haystack = name + ' ' + artist;
      let score = 0;
      if (name === targetName) score += 70;
      else if (name.includes(targetName) || targetName.includes(name)) score += 24;
      if (targetArtist && artist.includes(targetArtist)) score += 25;
      let tokenHits = 0;
      targetTokens.forEach(token => { if (haystack.includes(token)) tokenHits += 1; });
      score += tokenHits * 9;
      if (targetDuration && song.duration && Math.abs(song.duration - targetDuration) <= 8000) score += 10;
      if (/翻唱|cover|伴奏|karaoke|纯音乐|instrumental/i.test(name)) score -= 18;
      if (!best || score > best.score) best = { song, score };
    });
    return best && best.score >= 40 ? String(best.song.id) : '';
  }

  const similarLane = [];
  const artistLane = [];
  const biliLane = [];
  const fallbackLane = [];

  const anchorsForSimi = seeds.anchorSongs.slice(0, 6);
  await Promise.allSettled(anchorsForSimi.map(async (anchor, anchorIndex) => {
    try {
      if (typeof simiSongApi !== 'function') return;
      const anchorId = await resolveNeteaseAnchorId(anchor);
      if (!anchorId) return;
      const res = await recommendationWithRetry(
        () => simiSongApi({ id: anchorId, limit: 15, timestamp: Date.now() }),
        6500, 'NCM_SIMI_TIMEOUT'
      );
      const body = res.body || res || {};
      const list = (body.songs || []).map(mapNcmSong).filter(song => song && song.id);
      const anchorLabel = cleanTasteQuery(anchor.name) || anchor.name;
      const anchorQuality = (Number(anchor.plays) || 0) +
        (Number(anchor.raw && anchor.raw.completed) || 0) * 2 +
        (Number(anchor.listenMs) || 0) / 60000;
      list.forEach((song, index) => {
        similarLane.push({
          song,
          reason: '因为你常听《' + anchorLabel + '》',
          tag: '相似推荐',
          score: 128 - anchorIndex * 6 - index * 3 + Math.min(12, anchorQuality) - recommendationNoisePenalty(song, tasteText),
        });
      });
    } catch (_) {}
  }));

  await Promise.allSettled(seeds.artists.slice(0, 3).map(async (artist, artistIndex) => {
    try {
      const found = await searchNcm(artist, 8);
      const normArtist = tasteNormalizeText(artist);
      found.forEach((song, index) => {
        if (!normArtist || !tasteNormalizeText(song.artist).includes(normArtist)) return;
        artistLane.push({
          song,
          reason: '因为你常听 ' + artist,
          tag: '同歌手',
          score: 96 - artistIndex * 5 - index * 3 - recommendationNoisePenalty(song, tasteText),
        });
      });
    } catch (_) {}
  }));

  const derivedArtistCounts = new Map();
  similarLane.forEach(item => {
    String(item.song && item.song.artist || '').split(/\s*\/\s*/).forEach(name => {
      const key = name.trim();
      if (!key || /未知|unknown/i.test(key)) return;
      derivedArtistCounts.set(key, (derivedArtistCounts.get(key) || 0) + 1);
    });
  });
  const seedArtistKeys = new Set(seeds.artists.map(artist => tasteNormalizeText(artist)));
  const derivedArtists = Array.from(derivedArtistCounts.entries())
    .filter(([name]) => !seedArtistKeys.has(tasteNormalizeText(name)))
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0])
    .slice(0, 2);
  await Promise.allSettled(derivedArtists.map(async (artist, artistIndex) => {
    try {
      const found = await searchNcm(artist, 6);
      const normArtist = tasteNormalizeText(artist);
      found.forEach((song, index) => {
        if (!normArtist || !tasteNormalizeText(song.artist).includes(normArtist)) return;
        artistLane.push({
          song,
          reason: '和你常听的歌同风格：' + artist,
          tag: '同风格歌手',
          score: 84 - artistIndex * 4 - index * 3 - recommendationNoisePenalty(song, tasteText),
        });
      });
    } catch (_) {}
  }));

  const anchorSignatures = seeds.anchorSongs.map(recommendationAnchorSignature);
  const seenBiliAnchorCores = new Set();
  const biliAnchorQueries = seeds.anchorSongs
    .filter(anchor => /[\u4e00-\u9fff]/.test(anchor.name || ''))
    .map(anchor => ({ anchor, query: recommendationBiliCore(cleanTasteQuery(anchor.name)) }))
    .filter(item => {
      if (!item.query) return false;
      const coreKey = tasteNormalizeText(item.query);
      if (!coreKey || seenBiliAnchorCores.has(coreKey)) return false;
      seenBiliAnchorCores.add(coreKey);
      return true;
    })
    .slice(0, 3);

  const biliSearch = async (query, label) => {
    if (!biliApi || typeof biliApi.handleBiliSearch !== 'function') return [];
    try {
      const result = await recommendationWithTimeout(
        biliApi.handleBiliSearch(query, 10, biliCookie, 0),
        7000, label || 'BILI_RECOMMEND_TIMEOUT'
      );
      return (result && result.songs) || [];
    } catch (_) {
      return [];
    }
  };

  await Promise.allSettled(biliAnchorQueries.map(async (item, anchorIndex) => {
    const songs = await biliSearch(item.query, 'BILI_ANCHOR_TIMEOUT');
    let taken = 0;
    songs.forEach((song, index) => {
      if (!song || !song.bvid || taken >= 2) return;
      if (!recommendationBiliMusicLike(song)) return;
      if (!recommendationBiliLooksRelevant(song, item.query)) return;
      if (recommendationBiliDuplicatesAnchor(song, anchorSignatures)) return;
      if (song.isCompilation && taken >= 1) return;
      const anchorLabel = cleanTasteQuery(item.anchor.name) || item.anchor.name;
      biliLane.push({
        song,
        reason: '因为你常听《' + anchorLabel + '》，B 站上这些能完整听完',
        tag: song.isCompilation ? 'B 站合集' : 'B 站完整版',
        score: 150 - anchorIndex * 6 - index * 3 - recommendationBiliScorePenalty(song),
      });
      taken += 1;
    });
  }));

  const seenKeywordCores = new Set(Array.from(seenBiliAnchorCores));
  const biliKeywords = seeds.keywords
    .filter(keyword => /[\u4e00-\u9fff]/.test(keyword))
    .map(keyword => ({ keyword, core: recommendationBiliCore(keyword) }))
    .filter(item => {
      const coreKey = tasteNormalizeText(item.core);
      if (!item.core || !coreKey || seenKeywordCores.has(coreKey)) return false;
      seenKeywordCores.add(coreKey);
      return true;
    })
    .slice(0, 2);

  await Promise.allSettled(biliKeywords.map(async (item, keywordIndex) => {
    const songs = await biliSearch(item.core, 'BILI_KEYWORD_TIMEOUT');
    let taken = 0;
    songs.forEach((song, index) => {
      if (!song || !song.bvid || taken >= 2) return;
      if (!recommendationBiliMusicLike(song)) return;
      if (!recommendationBiliLooksRelevant(song, item.core)) return;
      if (song.isCompilation && taken >= 1) return;
      biliLane.push({
        song,
        reason: '你常搜「' + item.keyword + '」，这条 B 站音频能完整听完',
        tag: song.isCompilation ? 'B 站合集' : 'B 站完整版',
        score: 96 - keywordIndex * 5 - index * 3 - recommendationBiliScorePenalty(song),
      });
      taken += 1;
    });
  }));

  let fallbackLoaded = false;
  async function loadFallbackLane() {
    if (fallbackLoaded) return;
    fallbackLoaded = true;
    if (!ncmApi.playlist_track_all) return;
    try {
      const tr = await recommendationWithTimeout(
        ncmApi.playlist_track_all({ id: 19723756, limit: 40, timestamp: Date.now() }),
        6000, 'NCM_TOPLIST_TIMEOUT'
      );
      const body = tr.body || tr || {};
      const raw = body.songs || body.tracks || [];
      raw.map(mapNcmSong).filter(Boolean).forEach((song, index) => {
        fallbackLane.push({
          song,
          reason: '官方飙升榜里能完整听的曲目',
          tag: '热门补充',
          score: 45 - index,
        });
      });
    } catch (_) {}
  }

  const pickedArtistCounts = Object.create(null);
  function takeLane(lane, quota) {
    const out = [];
    (Array.isArray(lane) ? lane : [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach(item => {
        if (out.length >= quota) return;
        const song = item.song;
        if (!song || !song.id) return;
        if (!ncmSongIsFullyPlayable(song, ctx)) return;
        const idKey = String(song.id);
        const titleKey = tasteTitleKey(song);
        if (!titleKey || seenIds.has(idKey) || seenKeys.has(titleKey) || heardKeys.has(titleKey)) return;
        if (trashKeys.has(titleKey) || skipKeys.has(titleKey)) return;
        const artistKey = tasteArtistKey(song);
        if (artistKey && (pickedArtistCounts[artistKey] || 0) >= 2) return;
        if (artistKey) pickedArtistCounts[artistKey] = (pickedArtistCounts[artistKey] || 0) + 1;
        const skipPenalty = artistKey ? Math.min(30, (skipArtists.get(artistKey) || 0) * 6) : 0;
        if (item.score - skipPenalty < 0) return;
        seenIds.add(idKey);
        seenKeys.add(titleKey);
        song.feedReason = item.reason;
        song.reasonTag = item.tag;
        out.push(song);
      });
    return out;
  }

  const similarPicked = takeLane(similarLane, Math.ceil(limit * 0.6));
  const artistPicked = takeLane(artistLane, Math.ceil(limit * 0.22));
  const biliPicked = takeLane(biliLane, Math.max(2, limit - similarPicked.length - artistPicked.length));

  const picked = [];
  let si = 0, ai = 0, bi = 0;
  while (picked.length < limit && (si < similarPicked.length || ai < artistPicked.length || bi < biliPicked.length)) {
    for (let i = 0; i < 2 && si < similarPicked.length && picked.length < limit; i++) picked.push(similarPicked[si++]);
    if (ai < artistPicked.length && picked.length < limit) picked.push(artistPicked[ai++]);
    if (bi < biliPicked.length && picked.length < limit) picked.push(biliPicked[bi++]);
  }
  if (picked.length < limit) {
    await loadFallbackLane();
    picked.push.apply(picked, takeLane(fallbackLane, limit - picked.length));
  }
  if (!picked.length) {
    await loadFallbackLane();
    picked.push.apply(picked, takeLane(fallbackLane, limit));
  }
  return filterNcmFullyPlayableSongs(picked.slice(0, limit), ctx);
}

module.exports = {
  tasteNormalizeText,
  tasteTitleKey,
  cleanTasteQuery,
  normalizeTasteKeywordList,
  modSongProviderKey,
  ncmSongIsFullyPlayable,
  filterNcmFullyPlayableSongs,
  extractTasteSeeds,
  fetchTasteAnchoredNcmRecommendations,
};

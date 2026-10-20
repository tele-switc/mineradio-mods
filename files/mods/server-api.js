// ============================================================
//  mineradio-mods 后端外挂（上游 server.js 里只加了三行指向这里）
//
//  这一层负责：
//   - /api/bilibili/*         搜索、分 P（合集）、取址、歌词、会话
//   - /api/internetarchive/*  archive.org 公开音频：搜索、取址、歌词
//   - /api/radioparadise/*    RP 直播电台：频道、当关键词搜索、取流、正在播放、歌词
//   - 网易云超级增强与双擎日推：
//       /api/feed/super-daily         网易云日推 × 汽水推荐引擎双擎融合
//       /api/personal_fm              私人 FM 漫游推流
//       /api/fm_trash                 私人 FM 垃圾桶（不再推荐）
//       /api/playmode/intelligence/*  心动模式智能推荐曲目
//       /api/song/similar             相似歌曲推荐
//       /api/user/cloud               音乐云盘 / 本地私有仓
//       /api/user/cloud/del           删除云盘歌曲
//       /api/toplist & /detail        官方排行榜
//       /api/user/record              用户听歌排行
//       /api/record/recent/song       最近播放歌曲
//       /api/artist/songs & /albums   歌手单曲与专辑
//   - 音频代理的补丁：B 站直链 Referer，DASH mp4a / IA opus / RP AAC 正确 Content-Type
//
//  会话（cookie）放在 ~/.mineradio/bili-cookie —— 故意不放安装目录：
//  软件更新会把 resources/app 整个换掉，放那儿等于每次更新都要重新登录一次。
//  IA 与 RP 免登录、无会话，所以这两个源不需要任何落盘的东西。
// ============================================================

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARK = '[mods:server]';
const COOKIE_DIR = path.join(os.homedir(), '.mineradio');
const COOKIE_FILE = path.join(COOKIE_DIR, 'bili-cookie');

let bili = null;
function loadBili() {
  if (bili !== null) return bili;
  try { bili = require('../bilibili-api'); } catch (e) { console.warn(MARK, 'bilibili-api.js 没就位：' + e.message); bili = false; }
  return bili;
}

// IA / RP 的适配层文件自己不含任何会话与密钥，require 不到时只让对应那一路由报错，
// 不连累 B 站（三个源共用这一个入口文件）
let archive = null;
function loadArchive() {
  if (archive !== null) return archive;
  try { archive = require('../internetarchive-api'); } catch (e) { console.warn(MARK, 'internetarchive-api.js 没就位：' + e.message); archive = false; }
  return archive;
}

let rp = null;
function loadRp() {
  if (rp !== null) return rp;
  try { rp = require('../radioparadise-api'); } catch (e) { console.warn(MARK, 'radioparadise-api.js 没就位：' + e.message); rp = false; }
  return rp;
}

// 网易云 API 支持
let ncm = null;
function loadNcm() {
  if (ncm !== null) return ncm;
  try { ncm = require('NeteaseCloudMusicApi'); } catch (e) { console.warn(MARK, 'NeteaseCloudMusicApi 没就位：' + e.message); ncm = false; }
  return ncm;
}

function readCookie() {
  try {
    const api = loadBili();
    const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    return api ? api.normalizeBiliCookieInput(raw) : '';
  } catch (_) { return ''; }
}

function writeCookie(raw) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, String(raw || ''), { mode: 0o600 });
  const api = loadBili();
  if (api && api.clearBiliSessionCaches) api.clearBiliSessionCaches();
}

function readNeteaseCookie() {
  try {
    const p1 = path.join(__dirname, '..', '.cookie');
    if (fs.existsSync(p1)) return fs.readFileSync(p1, 'utf8').trim();
    const p2 = path.join(os.homedir(), '.mineradio', 'cookie');
    if (fs.existsSync(p2)) return fs.readFileSync(p2, 'utf8').trim();
  } catch (_) {}
  return '';
}

function mapNcmSong(raw) {
  if (!raw) return null;
  const s = raw.song || raw.simpleSong || raw;
  const id = s.id || raw.id || raw.songId;
  if (!id) return null;
  const ar = s.ar || s.artists || raw.artists;
  const artist = (Array.isArray(ar) && ar.length)
    ? ar.map(a => a && a.name).filter(Boolean).join(' / ')
    : (s.artist || raw.artist || '未知歌手');
  const al = s.al || s.album || raw.album || {};
  const albumName = (typeof al === 'object' && al !== null ? al.name : al) || raw.album || s.album || '未知专辑';
  const cover = (al && al.picUrl) || raw.picUrl || raw.cover || s.cover || '';
  return {
    provider: 'netease',
    id: Number(id),
    name: s.name || raw.name || raw.songName || raw.fileName || '未知曲目',
    artist: artist || '未知歌手',
    album: albumName || '未知专辑',
    cover: cover || '',
    duration: s.dt || s.duration || raw.duration || 0,
    playable: true,
  };
}

function sendJSON(res, body, status) {
  const data = Buffer.from(JSON.stringify(body || {}));
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// 音频代理补丁：命中就返回整套 headers，没命中返回 null 让上游自己处理。
// range 必须一起带上 —— 注入点是在上游那个函数的第一行 return，我们返回就等于
// 跳过了它自己的 `if (range) headers.Range = range`；archive.org 上整张专辑动辄
// 上百 MB，丢了 Range 浏览器就没法拖进度条。
function audioProxyHeaders(audioUrl, range) {
  try {
    const host = new URL(String(audioUrl || '')).hostname.toLowerCase();
    let referer = '';
    if (host.includes('bilivideo.com') || host.includes('bilibili.com') || host.includes('biliapi')) {
      referer = 'https://www.bilibili.com/';
    } else if (host.includes('archive.org')) {
      // 实测带错 Referer 也能取到，仍然按各自站点名设，免得上游哪天开始校验
      referer = 'https://archive.org/';
    } else if (host.includes('radioparadise.com')) {
      referer = 'https://radioparadise.com/';
    }
    if (!referer) return null;
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: referer };
    if (range) headers.Range = String(range);
    return headers;
  } catch (_) { }
  return null;
}

// B 站 DASH 的音频流是 mp4a（容器仍是 mp4），上游按扩展名猜会落到 application/octet-stream
function audioContentType(audioUrl, upstreamType) {
  try {
    const parsed = new URL(String(audioUrl || ''));
    const pathname = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (/\.m4a$|\.mp4a$|mp4a/.test(pathname)) return 'audio/mp4';
    if (/\.m4s$/.test(pathname)) return String(upstreamType || 'audio/mp4');
    // archive.org 的标准档有 ogg/oga/opus：上游那个函数没有 .opus 与 .oga 两条，
    // 会被兜成 audio/mpeg，Opus 塞进 MPEG 壳里 Chromium 解不出来
    if (/\.ogg$|\.oga$|\.opus$/.test(pathname)) return 'audio/ogg';
    if (/\.aac$/.test(pathname)) return 'audio/aac';
    // RP 的流地址是 https://stream-dc1.radioparadise.com/aac-320 —— 没有扩展名，
    // 上游会兜成 audio/mpeg；按 slug 里的字样报对的容器
    if (host.includes('radioparadise.com')) {
      if (/mp3/.test(pathname)) return 'audio/mpeg';
      if (/aac|m4a/.test(pathname)) return 'audio/aac';
    }
  } catch (_) { }
  return '';
}

async function handle(req, res, url, pn) {
  const api = loadBili();
  if (!api) { sendJSON(res, { error: 'BILI_API_MISSING', songs: [] }, 500); return true; }
  const cookie = readCookie();

  if (pn === '/api/bilibili/search') {
    try {
      const result = await api.handleBiliSearch(
        url.searchParams.get('keywords') || url.searchParams.get('q') || '',
        int(url.searchParams.get('limit'), 12), cookie, int(url.searchParams.get('offset'), 0));
      sendJSON(res, { provider: 'bilibili', ...result });
    } catch (e) { sendJSON(res, { provider: 'bilibili', error: String(e && e.message || e), songs: [] }, 500); }
    return true;
  }
  if (pn === '/api/bilibili/parts') {
    try {
      const view = await api.handleBiliView(url.searchParams.get('bvid') || url.searchParams.get('id') || '', cookie);
      sendJSON(res, { provider: 'bilibili', ...view });
    } catch (e) { sendJSON(res, { provider: 'bilibili', parts: [], partCount: 0, error: String(e && e.message || e) }, 500); }
    return true;
  }
  if (pn === '/api/bilibili/song/url') {
    try {
      const info = await api.handleBiliSongUrl({
        bvid: url.searchParams.get('bvid') || url.searchParams.get('id') || '',
        cid: url.searchParams.get('cid') || '',
      }, cookie);
      sendJSON(res, { provider: 'bilibili', ...info });
    } catch (e) { sendJSON(res, { provider: 'bilibili', url: '', playable: false, error: String(e && e.message || e) }, 500); }
    return true;
  }
  if (pn === '/api/bilibili/lyric') {
    // B 站没有官方同步歌词：如实说没有，比伪造一份时间轴好
    sendJSON(res, { provider: 'bilibili', lyric: '', trans: '', reason: 'BILI_NO_SYNCED_LYRICS' });
    return true;
  }
  if (pn === '/api/bilibili/login/status') {
    try { sendJSON(res, await api.getBiliLoginInfo(cookie)); }
    catch (e) { sendJSON(res, { provider: 'bilibili', loggedIn: false, error: String(e && e.message || e) }, 500); }
    return true;
  }
  if (pn === '/api/bilibili/login/cookie') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const raw = (body && body.trim().startsWith('{')) ? (JSON.parse(body).cookie || '') : body;
      const normalized = api.normalizeBiliCookieInput(raw);
      if (!api.biliCookieHasLogin(normalized)) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_BILI_COOKIE', message: '缺少 SESSDATA / bili_jct，无法识别 B 站登录会话' }, 400);
        return true;
      }
      writeCookie(normalized);
      sendJSON(res, { provider: 'bilibili', loggedIn: true, ...(await api.getBiliLoginInfo(normalized)) });
    } catch (e) { sendJSON(res, { provider: 'bilibili', loggedIn: false, error: String(e && e.message || e) }, 500); }
    return true;
  }
  if (pn === '/api/bilibili/logout') {
    try { fs.rmSync(COOKIE_FILE, { force: true }); } catch (_) { }
    const live = loadBili();
    if (live && live.clearBiliSessionCaches) live.clearBiliSessionCaches();
    sendJSON(res, { provider: 'bilibili', loggedIn: false, ok: true });
    return true;
  }
  return false;
}

// ---- Internet Archive：免登录、无需 API key 的公开音频库 ----
// 只做在线播放直链中转，不缓存、不重新分发；挑文件时过 Chromium 可播性白名单（适配层里）。
async function handleArchiveRoute(res, url, pn) {
  const api = loadArchive();
  if (!api) { sendJSON(res, { provider: 'internetarchive', error: 'ARCHIVE_API_MISSING', songs: [] }, 500); return true; }

  if (pn === '/api/internetarchive/search') {
    try {
      const kw = url.searchParams.get('keywords') || url.searchParams.get('q') || '';
      const limit = Math.max(4, Math.min(30, int(url.searchParams.get('limit'), 12)));
      const offset = Math.max(0, int(url.searchParams.get('offset'), 0));
      const result = await api.handleArchiveSearch(kw, limit, offset);
      const songs = result.songs || [];
      sendJSON(res, {
        provider: 'internetarchive',
        songs,
        total: result.total || 0,
        offset,
        limit,
        nextOffset: offset + songs.length,
        hasMore: result.hasMore === true && songs.length > 0,
        message: result.error ? 'archive.org 搜索暂时不可用：' + result.error : '',
      });
    } catch (err) {
      console.error(MARK, '[ArchiveSearch]', err);
      sendJSON(res, { provider: 'internetarchive', error: String((err && err.message) || err), songs: [] }, 500);
    }
    return true;
  }

  if (pn === '/api/internetarchive/song/url') {
    try {
      sendJSON(res, await api.handleArchiveSongUrl({
        archiveId: url.searchParams.get('archiveId') || url.searchParams.get('identifier') || '',
        file: url.searchParams.get('file') || '',
        quality: url.searchParams.get('quality') || '',
      }));
    } catch (err) {
      console.error(MARK, '[ArchiveSongUrl]', err);
      sendJSON(res, { provider: 'internetarchive', url: '', playable: false, error: String((err && err.message) || err) }, 500);
    }
    return true;
  }

  // archive.org 条目基本没有逐字歌词：给确定答复，别拿歌名去网易云捞一份错歌词
  if (pn === '/api/internetarchive/lyric') {
    sendJSON(res, await api.handleArchiveLyric());
    return true;
  }

  return false;
}

// ---- Radio Paradise：免登录的公开 320k AAC 直播 ----
// 直播源没有单曲、没有可拖拽进度、没有同步歌词；只下发适配层里已实测过的频道 slug。
async function handleRpRoute(res, url, pn) {
  const api = loadRp();
  if (!api) { sendJSON(res, { provider: 'radioparadise', error: 'RP_API_MISSING', songs: [] }, 500); return true; }
  const region = url.searchParams.get('region') || '';

  if (pn === '/api/radioparadise/channels') {
    sendJSON(res, { provider: 'radioparadise', live: true, channels: api.handleRpChannels(region) });
    return true;
  }

  if (pn === '/api/radioparadise/search') {
    try {
      const kw = url.searchParams.get('keywords') || url.searchParams.get('q') || '';
      const limit = Math.max(1, Math.min(20, int(url.searchParams.get('limit'), 12)));
      const offset = Math.max(0, int(url.searchParams.get('offset'), 0));
      const all = await api.handleRpSearch(kw, limit + offset, region);
      const songs = all.slice(offset, offset + limit);
      sendJSON(res, {
        provider: 'radioparadise',
        live: true,
        songs,
        offset,
        limit,
        nextOffset: offset + songs.length,
        hasMore: false,
        message: songs.length ? '' : 'Radio Paradise 没有命中该关键词的频道（直播源没有单曲搜索，可试 rock / mellow / global / serenity）',
      });
    } catch (err) {
      console.error(MARK, '[RadioParadiseSearch]', err);
      sendJSON(res, { provider: 'radioparadise', error: String((err && err.message) || err), songs: [] }, 500);
    }
    return true;
  }

  if (pn === '/api/radioparadise/song/url') {
    try {
      // chan 用 != null 而不是真值：Main Mix 的 chan 就是 0。
      // 没有 chan 时**不要**塞一个空字符串进去 —— 适配层判的是 rpChan != null，
      // 空串会把它顶掉，slug 那份兜底就永远走不到。
      const input = { slug: url.searchParams.get('slug') || '', region };
      const chanParam = url.searchParams.get('chan');
      const chanAlt = url.searchParams.get('rpChan');
      if (chanParam != null && chanParam !== '') input.rpChan = chanParam;
      else if (chanAlt != null && chanAlt !== '') input.rpChan = chanAlt;
      sendJSON(res, await api.handleRpSongUrl(input));
    } catch (err) {
      console.error(MARK, '[RadioParadiseSongUrl]', err);
      sendJSON(res, { provider: 'radioparadise', url: '', playable: false, error: String((err && err.message) || err) }, 500);
    }
    return true;
  }

  if (pn === '/api/radioparadise/now-playing') {
    try {
      sendJSON(res, await api.handleRpNowPlaying(url.searchParams.get('chan') || ''));
    } catch (err) {
      console.error(MARK, '[RadioParadiseNowPlaying]', err);
      sendJSON(res, { provider: 'radioparadise', error: String((err && err.message) || err) }, 500);
    }
    return true;
  }

  // 与 B 站同一处理方式：直播没有同步歌词，给确定答复而不是回退到网易云
  if (pn === '/api/radioparadise/lyric') {
    sendJSON(res, { provider: 'radioparadise', lyric: '', trans: '', reason: 'RP_NO_SYNCED_LYRICS' });
    return true;
  }

  return false;
}

// ---- 网易云超级增强与双擎日推漫游 ----
async function handleNeteaseRoute(req, res, url, pn) {
  const ncmApi = loadNcm();
  if (!ncmApi) {
    sendJSON(res, { success: false, error: 'NCM_API_MISSING', tracks: [] }, 500);
    return true;
  }
  const cookie = readNeteaseCookie();

  // 1. 双擎日推与刷视频推荐流（网易云日推 + 汽水音乐推荐引擎）
  if (pn === '/api/feed/super-daily') {
    try {
      const mode = url.searchParams.get('mode') || 'hybrid';
      const tasks = [];

      const neteaseTask = (async () => {
        try {
          if (cookie && ncmApi.recommend_songs) {
            const rec = await ncmApi.recommend_songs({ cookie, timestamp: Date.now() });
            const body = rec.body || rec || {};
            const raw = (body.data && (body.data.dailySongs || body.data.recommend)) || body.recommend || [];
            if (raw.length) {
              return raw.map(mapNcmSong).filter(Boolean).map(s => {
                s.feedReason = '网易云·日推精选';
                s.reasonTag = '日推';
                return s;
              });
            }
          }
        } catch (_) {}
        try {
          if (ncmApi.personalized) {
            const rec = await ncmApi.personalized({ limit: 6, timestamp: Date.now() });
            const plList = (rec.body && (rec.body.result || rec.body.data)) || [];
            if (plList.length && plList[0].id && ncmApi.playlist_track_all) {
              const tr = await ncmApi.playlist_track_all({ id: plList[0].id, limit: 16, timestamp: Date.now() });
              const rawSongs = (tr.body && (tr.body.songs || tr.body.tracks)) || [];
              return rawSongs.map(mapNcmSong).filter(Boolean).map(s => {
                s.feedReason = '网易云·精选推荐';
                s.reasonTag = '精选';
                return s;
              });
            }
          }
        } catch (_) {}
        return [];
      })();
      tasks.push(neteaseTask);

      const qishuiTask = (async () => {
        try {
          let qishui = null;
          try { qishui = require('../qishui-api'); } catch (_) {}
          if (qishui && typeof qishui.handleQishuiFeed === 'function') {
            let qCookie = '';
            try {
              const qPath = path.join(__dirname, '..', '.qishui-cookie');
              if (fs.existsSync(qPath)) qCookie = fs.readFileSync(qPath, 'utf8').trim();
            } catch (_) {}
            const feedRes = await qishui.handleQishuiFeed(14, qCookie);
            const raw = (feedRes && feedRes.songs) || [];
            return raw.map(s => {
              s.feedReason = '汽水算法·精准推流';
              s.reasonTag = '猜你喜欢';
              return s;
            });
          }
        } catch (_) {}
        return [];
      })();
      tasks.push(qishuiTask);

      const [neteaseSongs, qishuiSongs] = await Promise.all(tasks);
      const seen = new Set();
      const combined = [];
      const addSong = (s) => {
        if (!s || !s.id) return;
        const k = (String(s.name || '') + ' ' + String(s.artist || '')).toLowerCase().replace(/\s+/g, '');
        if (seen.has(k)) return;
        seen.add(k);
        combined.push(s);
      };

      if (mode === 'qishui') {
        qishuiSongs.forEach(addSong);
        neteaseSongs.forEach(addSong);
      } else {
        let nIdx = 0, qIdx = 0;
        while (nIdx < neteaseSongs.length || qIdx < qishuiSongs.length) {
          if (nIdx < neteaseSongs.length) addSong(neteaseSongs[nIdx++]);
          if (nIdx < neteaseSongs.length) addSong(neteaseSongs[nIdx++]);
          if (qIdx < qishuiSongs.length) addSong(qishuiSongs[qIdx++]);
        }
      }

      sendJSON(res, {
        success: true,
        mode,
        count: combined.length,
        tracks: combined,
        neteaseCount: neteaseSongs.length,
        qishuiCount: qishuiSongs.length,
        date: new Date().toLocaleDateString('zh-CN'),
      });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 2. 私人 FM
  if (pn === '/api/personal_fm') {
    try {
      if (cookie && ncmApi.personal_fm) {
        const fmRes = await ncmApi.personal_fm({ cookie, timestamp: Date.now() });
        const body = fmRes.body || fmRes || {};
        const raw = body.data || [];
        const tracks = raw.map(mapNcmSong).filter(Boolean);
        sendJSON(res, { success: true, tracks });
        return true;
      }
      const superDailyUrl = new URL(url.toString());
      superDailyUrl.pathname = '/api/feed/super-daily';
      return handleNeteaseRoute(req, res, superDailyUrl, '/api/feed/super-daily');
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
      return true;
    }
  }

  // 3. 私人 FM 垃圾桶
  if (pn === '/api/fm_trash') {
    try {
      const id = url.searchParams.get('id');
      if (cookie && id && ncmApi.fm_trash) {
        const r = await ncmApi.fm_trash({ id, cookie, timestamp: Date.now() });
        sendJSON(res, { success: true, id, body: (r && r.body) || r });
      } else {
        sendJSON(res, { success: true, id, guest: true });
      }
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e) }, 500);
    }
    return true;
  }

  // 4. 心动模式
  if (pn === '/api/playmode/intelligence/list') {
    try {
      const id = url.searchParams.get('id');
      const pid = url.searchParams.get('pid') || 24381616;
      if (!id) { sendJSON(res, { success: false, error: 'Missing song id', tracks: [] }, 400); return true; }
      let rawSongs = [];
      if (ncmApi.playmode_intelligence_list) {
        try {
          const intel = await ncmApi.playmode_intelligence_list({ id, pid, cookie, timestamp: Date.now() });
          const body = intel.body || intel || {};
          const list = body.data || body.result || [];
          rawSongs = list.map(item => item.songInfo || item);
        } catch (_) {}
      }
      const tracks = rawSongs.map(mapNcmSong).filter(Boolean);
      sendJSON(res, { success: true, id, pid, tracks });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 5. 相似歌曲
  if (pn === '/api/song/similar') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { success: false, error: 'Missing song id', tracks: [] }, 400); return true; }
      const fetchSimi = ncmApi['simi_' + 'song'];
      let songs = [];
      if (typeof fetchSimi === 'function') {
        try {
          const simi = await fetchSimi({ id, cookie, timestamp: Date.now() });
          const body = simi.body || simi || {};
          songs = (body.songs || []).map(mapNcmSong).filter(Boolean);
        } catch (_) {}
      }
      sendJSON(res, { success: true, id, tracks: songs });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 6. 音乐云盘
  if (pn === '/api/user/cloud') {
    try {
      if (!cookie || !ncmApi.user_cloud) {
        sendJSON(res, {
          success: true,
          loggedIn: false,
          isGuest: true,
          count: 0,
          tracks: [],
          message: '未登录网易云。登录后可自动同步云盘；未登录时可直接拖入本地音乐到播放器作为本地私有仓。',
        });
        return true;
      }
      const limit = Math.max(1, Math.min(100, int(url.searchParams.get('limit'), 50)));
      const offset = Math.max(0, int(url.searchParams.get('offset'), 0));
      const cloudRes = await ncmApi.user_cloud({ limit, offset, cookie, timestamp: Date.now() });
      const body = cloudRes.body || cloudRes || {};
      const rawList = body.data || [];
      const tracks = rawList.map(item => {
        const s = mapNcmSong(item);
        if (s) {
          s.isCloud = true;
          s.fileSize = item.fileSize || 0;
        }
        return s;
      }).filter(Boolean);
      sendJSON(res, {
        success: true,
        loggedIn: true,
        count: body.count || tracks.length,
        size: body.size || 0,
        maxSize: body.maxSize || 0,
        hasMore: body.hasMore !== false && rawList.length >= limit,
        tracks,
      });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 7. 删除云盘歌曲
  if (pn === '/api/user/cloud/del') {
    try {
      const id = url.searchParams.get('id');
      if (cookie && id && ncmApi.user_cloud_del) {
        const delRes = await ncmApi.user_cloud_del({ id, cookie, timestamp: Date.now() });
        sendJSON(res, { success: true, id, body: (delRes && delRes.body) || delRes });
      } else {
        sendJSON(res, { success: false, error: 'DELETE_FAILED' }, 400);
      }
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e) }, 500);
    }
    return true;
  }

  // 8. 官方排行榜
  if (pn === '/api/toplist' || pn === '/api/toplist/detail') {
    try {
      let list = [];
      if (ncmApi.toplist_detail) {
        const listRes = await ncmApi.toplist_detail({ cookie, timestamp: Date.now() });
        const body = listRes.body || listRes || {};
        const rawList = body.list || [];
        list = rawList.map(item => ({
          id: item.id,
          name: item.name,
          cover: item.coverImgUrl || '',
          updateFrequency: item.updateFrequency || '',
          playCount: item.playCount || 0,
          trackCount: item.trackCount || 0,
          description: item.description || '',
          top3: (item.tracks || []).slice(0, 3).map(t => ({
            first: t.first || '',
            second: t.second || '',
          })),
        })).filter(item => item.id && item.name);
      }
      sendJSON(res, { success: true, total: list.length, list });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), list: [] }, 500);
    }
    return true;
  }

  // 9. 用户听歌排行
  if (pn === '/api/user/record') {
    try {
      if (!cookie || !ncmApi.user_record) {
        sendJSON(res, { success: true, loggedIn: false, isGuest: true, total: 0, tracks: [] });
        return true;
      }
      const type = int(url.searchParams.get('type'), 1);
      const uid = url.searchParams.get('uid') || '';
      const recRes = await ncmApi.user_record({ uid, type, cookie, timestamp: Date.now() });
      const body = recRes.body || recRes || {};
      const rawList = (type === 1 ? body.weekData : body.allData) || [];
      const tracks = rawList.map(item => {
        const s = mapNcmSong(item.song);
        if (s) {
          s.playCount = item.playCount || 0;
          s.score = item.score || 0;
        }
        return s;
      }).filter(Boolean);
      sendJSON(res, { success: true, type, total: tracks.length, tracks });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 10. 最近播放歌曲
  if (pn === '/api/record/recent/song') {
    try {
      if (!cookie || !ncmApi.record_recent_song) {
        sendJSON(res, { success: true, loggedIn: false, isGuest: true, total: 0, tracks: [] });
        return true;
      }
      const limit = Math.max(1, Math.min(100, int(url.searchParams.get('limit'), 50)));
      const recRes = await ncmApi.record_recent_song({ limit, cookie, timestamp: Date.now() });
      const body = recRes.body || recRes || {};
      const rawList = (body.data && body.data.list) || body.list || [];
      const tracks = rawList.map(item => {
        const s = mapNcmSong(item.data || item);
        if (s) s.playTime = item.playTime || 0;
        return s;
      }).filter(Boolean);
      sendJSON(res, { success: true, total: tracks.length, tracks });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), tracks: [] }, 500);
    }
    return true;
  }

  // 11. 歌手热门单曲与全部单曲
  if (pn === '/api/artist/songs') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { success: false, error: 'Missing artist id', songs: [] }, 400); return true; }
      const limit = Math.max(1, Math.min(100, int(url.searchParams.get('limit'), 50)));
      const offset = Math.max(0, int(url.searchParams.get('offset'), 0));
      const order = url.searchParams.get('order') === 'time' ? 'time' : 'hot';
      let songs = [];
      let total = 0;
      if (ncmApi.artist_songs) {
        try {
          const resList = await ncmApi.artist_songs({ id, order, limit, offset, cookie, timestamp: Date.now() });
          const body = resList.body || resList || {};
          total = body.total || 0;
          const raw = (body.songs || (body.data && body.data.songs) || []);
          songs = raw.map(mapNcmSong).filter(Boolean);
        } catch (_) {}
      }
      if (!songs.length && offset === 0 && ncmApi.artist_top_song) {
        try {
          const topRes = await ncmApi.artist_top_song({ id, cookie, timestamp: Date.now() });
          const topBody = topRes.body || topRes || {};
          songs = (topBody.songs || []).map(mapNcmSong).filter(Boolean);
          total = songs.length;
        } catch (_) {}
      }
      sendJSON(res, { success: true, id, order, limit, offset, total, songs });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), songs: [] }, 500);
    }
    return true;
  }

  // 12. 歌手专辑
  if (pn === '/api/artist/albums') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { success: false, error: 'Missing artist id', albums: [] }, 400); return true; }
      const limit = Math.max(1, Math.min(50, int(url.searchParams.get('limit'), 30)));
      const offset = Math.max(0, int(url.searchParams.get('offset'), 0));
      let albums = [];
      let total = 0;
      if (ncmApi.artist_album) {
        try {
          const albRes = await ncmApi.artist_album({ id, limit, offset, cookie, timestamp: Date.now() });
          const body = albRes.body || albRes || {};
          const rawAlbs = body.hotAlbums || body.albums || [];
          albums = rawAlbs.map(a => ({
            id: a.id,
            name: a.name || '',
            cover: a.picUrl || a.coverUrl || '',
            publishTime: a.publishTime || 0,
            size: a.size || 0,
          })).filter(a => a.id && a.name);
          total = body.total || albums.length;
        } catch (_) {}
      }
      sendJSON(res, { success: true, id, total, albums });
    } catch (e) {
      sendJSON(res, { success: false, error: String(e && e.message || e), albums: [] }, 500);
    }
    return true;
  }

  return false;
}

const NETEASE_SUPERCHARGED_RE = /^\/api\/(feed\/super-daily|personal_fm|fm_trash|playmode\/intelligence\/list|song\/similar|user\/cloud(\/del)?|toplist(\/detail)?|user\/record|record\/recent\/song|artist\/(songs|albums))$/;

function tryHandle(req, res, url, pn) {
  // 更新检查：原版会去 GitHub 拉 release，而作者已停更；外挂装在上面之后
  // "有新版本"其实是"更新会把外挂冲掉"。所以这里直接答"没有更新"，
  // 比去改 package.json 的 mineradio.update.provider 抗更新（那个文件一更新就回来了）。
  if (pn === '/api/update/latest') {
    let version = '';
    try { version = require('../package.json').version || ''; } catch (_) { }
    sendJSON(res, {
      configured: false, preview: false, updateAvailable: false,
      currentVersion: version, latestVersion: version,
      release: {}, note: 'mineradio-mods：更新检查由外挂接管（作者已停更，升级会冲掉外挂）',
    });
    return true;
  }
  if (/^\/api\/update\/(download|patch)/.test(pn)) {
    sendJSON(res, { ok: false, error: 'UPDATE_DISABLED_BY_MODS', externalOnly: true }, 400);
    return true;
  }

  // 网易云超级增强路由（双擎日推漫游、私人FM、云盘、榜单、心动模式、相似歌曲等）
  if (NETEASE_SUPERCHARGED_RE.test(pn)) {
    const run = handleNeteaseRoute(req, res, url, pn);
    run.catch((e) => {
      console.warn(MARK, '网易云超级增强路由异常：' + ((e && e.stack) || e));
      try { sendJSON(res, { error: String((e && e.message) || e), success: false }, 500); } catch (_) { }
    });
    return true;
  }

  if (!/^\/api\/(bilibili|internetarchive|radioparadise)\//.test(pn)) return false;
  const run = pn.indexOf('/api/bilibili/') === 0 ? handle(req, res, url, pn)
    : pn.indexOf('/api/internetarchive/') === 0 ? handleArchiveRoute(res, url, pn)
      : handleRpRoute(res, url, pn);
  run.catch((e) => {
    console.warn(MARK, '路由异常：' + ((e && e.stack) || e));
    try { sendJSON(res, { error: String((e && e.message) || e), songs: [] }, 500); } catch (_) { }
  });
  return true;
}

module.exports = { tryHandle, audioProxyHeaders, audioContentType, mapNcmSong, handleNeteaseRoute };

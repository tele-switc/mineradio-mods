// ============================================================
//  mineradio-mods 后端外挂（上游 server.js 里只加了三行指向这里）
//
//  这一层负责：
//   - /api/bilibili/*      搜索、分 P（合集）、取址、歌词、会话
//   - /api/internetarchive/*  archive.org 公开音频：搜索、取址、歌词
//   - /api/radioparadise/*    RP 直播电台：频道、当关键词搜索、取流、正在播放、歌词
//   - 音频代理的两个补丁：B 站直链要带 Referer，DASH 的 mp4a 要报对 Content-Type
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

module.exports = { tryHandle, audioProxyHeaders, audioContentType };

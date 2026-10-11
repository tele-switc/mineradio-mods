// ============================================================
//  mineradio-mods 后端外挂（上游 server.js 里只加了三行指向这里）
//
//  这一层负责：
//   - /api/bilibili/*  搜索、分 P（合集）、取址、歌词、会话
//   - 音频代理的两个补丁：B 站直链要带 Referer，DASH 的 mp4a 要报对 Content-Type
//
//  会话（cookie）放在 ~/.mineradio/bili-cookie —— 故意不放安装目录：
//  软件更新会把 resources/app 整个换掉，放那儿等于每次更新都要重新登录一次。
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

// 音频代理补丁：命中就返回整套 headers，没命中返回 null 让上游自己处理
function audioProxyHeaders(audioUrl) {
  try {
    const host = new URL(String(audioUrl || '')).hostname.toLowerCase();
    if (host.includes('bilivideo.com') || host.includes('bilibili.com') || host.includes('biliapi')) {
      return { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
    }
  } catch (_) { }
  return null;
}

// B 站 DASH 的音频流是 mp4a（容器仍是 mp4），上游按扩展名猜会落到 application/octet-stream
function audioContentType(audioUrl, upstreamType) {
  try {
    const pathname = new URL(String(audioUrl || '')).pathname.toLowerCase();
    if (/\.m4a$|\.mp4a$|mp4a/.test(pathname)) return 'audio/mp4';
    if (/\.m4s$/.test(pathname)) return String(upstreamType || 'audio/mp4');
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
  if (!/^\/api\/bilibili\//.test(pn)) return false;
  handle(req, res, url, pn).catch((e) => {
    console.warn(MARK, '路由异常：' + ((e && e.stack) || e));
    try { sendJSON(res, { error: String((e && e.message) || e), songs: [] }, 500); } catch (_) { }
  });
  return true;
}

module.exports = { tryHandle, audioProxyHeaders, audioContentType };

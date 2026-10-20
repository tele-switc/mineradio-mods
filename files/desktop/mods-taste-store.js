'use strict';

// ============================================================
//  mineradio-mods · 「口味档案」落盘层（desktop/mods-taste-store.js）
//
//  档案里只有两类东西：导入文件读到的曲目/歌手，和从已登录平台拉回来的收藏。
//  本机聆听那一路由渲染层按已有的 mineradio-listen-stats-v1 现算，不在档案里复制一份，
//  省掉走样风险，也让清空聆听统计自动把这部分归零。
//
//  落盘落在 userData 目录（%APPDATA%\Mineradio\mineradio-taste-profile.json），
//  不在 localStorage（几千条数据会爆 5MB 配额），也不在安装目录（更新会没）。
//
//  读不出来分两种：
//   - 文件不存在 → 正常空文档（首次使用状态）
//   - 文件在但损坏/超限 → 返回 error 拒绝覆盖，绝不把用户导入的资产冲掉。
// ============================================================

const fs = require('fs');
const path = require('path');

const TASTE_FILE = 'mineradio-taste-profile.json';
const TASTE_MAX_BYTES = 8 * 1024 * 1024;
const TASTE_MAX_SONGS = 6000;
const TASTE_MAX_ARTISTS = 1200;
const TASTE_MAX_SOURCES = 60;
const TASTE_TEXT_MAX = 120;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clipText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || TASTE_TEXT_MAX);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return isFinite(n) && n > 0 ? n : (fallback || 0);
}

function clampWeight(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(200, Math.round(n * 100) / 100);
}

function normalizeSources(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  Object.keys(value).slice(0, TASTE_MAX_SOURCES).forEach((rawId) => {
    const src = isPlainObject(value[rawId]) ? value[rawId] : {};
    const id = clipText(rawId, 64);
    if (!id) return;
    const kind = src.kind === 'playlist' ? 'playlist' : (src.kind === 'file' ? 'file' : '');
    if (!kind) return;
    out[id] = {
      id,
      kind,
      label: clipText(src.label, 80),
      provider: clipText(src.provider, 24),
      count: Math.max(0, Math.round(positiveNumber(src.count, 0))),
      addedAt: Math.max(0, Math.round(positiveNumber(src.addedAt, 0))),
    };
  });
  return out;
}

function normalizeSong(value) {
  if (!isPlainObject(value)) return null;
  const name = clipText(value.name);
  const artist = clipText(value.artist);
  if (!name && !artist) return null;
  const weight = clampWeight(value.weight);
  if (!weight) return null;
  const sources = {};
  const rawSources = isPlainObject(value.sources) ? value.sources : {};
  Object.keys(rawSources).slice(0, 12).forEach((id) => {
    const count = Math.max(0, Math.round(positiveNumber(rawSources[id], 0)));
    const key = clipText(id, 64);
    if (!key || !count) return;
    sources[key] = Math.min(9999, count);
  });
  return {
    key: clipText(value.key, 160) || (name + '|' + artist),
    name,
    artist,
    weight,
    hits: Math.min(9999, Math.max(0, Math.round(positiveNumber(value.hits, 0)))),
    sources,
    addedAt: Math.max(0, Math.round(positiveNumber(value.addedAt, 0))),
  };
}

function normalizeArtist(value) {
  if (!isPlainObject(value)) return null;
  const name = clipText(value.name);
  if (!name) return null;
  const weight = clampWeight(value.weight);
  if (!weight) return null;
  const sources = {};
  const rawSources = isPlainObject(value.sources) ? value.sources : {};
  Object.keys(rawSources).slice(0, 12).forEach((id) => {
    const count = Math.max(0, Math.round(positiveNumber(rawSources[id], 0)));
    const key = clipText(id, 64);
    if (!key || !count) return;
    sources[key] = Math.min(9999, count);
  });
  return {
    name,
    weight,
    hits: Math.min(9999, Math.max(0, Math.round(positiveNumber(value.hits, 0)))),
    sources,
    addedAt: Math.max(0, Math.round(positiveNumber(value.addedAt, 0))),
  };
}

function trimByWeight(map, limit) {
  const keys = Object.keys(map || {});
  if (keys.length <= limit) return map;
  keys.sort((a, b) => (map[b].weight - map[a].weight) || (map[b].addedAt - map[a].addedAt));
  const out = {};
  keys.slice(0, limit).forEach((key) => { out[key] = map[key]; });
  return out;
}

function normalizeDocument(value) {
  const src = isPlainObject(value) ? value : null;
  if (!src) return null;
  const songs = {};
  const rawSongs = isPlainObject(src.songs) ? src.songs : {};
  Object.keys(rawSongs).forEach((key) => {
    const normalized = normalizeSong(rawSongs[key]);
    if (!normalized) return;
    songs[clipText(key, 160) || normalized.key] = normalized;
  });
  const artists = {};
  const rawArtists = isPlainObject(src.artists) ? src.artists : {};
  Object.keys(rawArtists).forEach((key) => {
    const normalized = normalizeArtist(rawArtists[key]);
    if (!normalized) return;
    artists[clipText(key, 120) || normalized.name] = normalized;
  });
  const strength = ['soft', 'standard', 'strong'].indexOf(String(src.strength)) >= 0
    ? String(src.strength)
    : 'standard';
  return {
    version: 1,
    enabled: src.enabled !== false,
    strength,
    songs: trimByWeight(songs, TASTE_MAX_SONGS),
    artists: trimByWeight(artists, TASTE_MAX_ARTISTS),
    sources: normalizeSources(src.sources),
    createdAt: Math.max(0, Math.round(positiveNumber(src.createdAt, 0))),
    updatedAt: Math.max(0, Math.round(positiveNumber(src.updatedAt, 0))),
  };
}

function emptyDocument() {
  return { version: 1, enabled: true, strength: 'standard', songs: {}, artists: {}, sources: {}, createdAt: 0, updatedAt: 0 };
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

class TasteProfileStore {
  constructor(options) {
    const opts = options || {};
    this.userDataPath = String(opts.userDataPath || '');
    this.maxBytes = Number(opts.maxBytes) || TASTE_MAX_BYTES;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    if (!this.userDataPath) throw new Error('TASTE_NEEDS_USER_DATA_PATH');
  }

  get filePath() {
    return path.join(this.userDataPath, TASTE_FILE);
  }

  read() {
    const file = this.filePath;
    try {
      if (!fs.existsSync(file)) return { ok: true, document: emptyDocument(), missing: true, file };
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { ok: false, error: 'TASTE_NOT_A_FILE', file };
      if (stat.size <= 0) return { ok: true, document: emptyDocument(), missing: true, file };
      if (stat.size > this.maxBytes) return { ok: false, error: 'TASTE_TOO_LARGE', file, size: stat.size };
      const raw = fs.readFileSync(file, 'utf8');
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { ok: false, error: 'TASTE_CORRUPT', file };
      }
      const document = normalizeDocument(parsed);
      if (!document) return { ok: false, error: 'TASTE_CORRUPT', file };
      return { ok: true, document, missing: false, file };
    } catch (e) {
      return { ok: false, error: 'TASTE_READ_FAILED', detail: (e && e.message) || String(e), file };
    }
  }

  write(document) {
    const attempt = (waitMs) => {
      try {
        const normalized = normalizeDocument(document) || emptyDocument();
        const payload = Object.assign({}, normalized, {
          createdAt: normalized.createdAt || this.now(),
          updatedAt: this.now(),
        });
        let text = JSON.stringify(payload);
        let dropped = 0;
        while (byteLength(text) > this.maxBytes && Object.keys(payload.songs).length > 8) {
          const keys = Object.keys(payload.songs);
          let lowest = keys[0];
          keys.forEach((key) => { if (payload.songs[key].weight < payload.songs[lowest].weight) lowest = key; });
          delete payload.songs[lowest];
          dropped += 1;
          text = JSON.stringify(Object.assign({}, payload, { updatedAt: this.now() }));
        }
        if (byteLength(text) > this.maxBytes) {
          return { ok: false, error: 'TASTE_SINGLE_ITEM_TOO_LARGE', bytes: byteLength(text) };
        }
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, this.filePath);
        return { ok: true, document: payload, dropped, file: this.filePath, bytes: byteLength(text) };
      } catch (e) {
        if (waitMs === 0 && (e.code === 'EBUSY' || e.code === 'EPERM')) return attempt(40);
        try { fs.unlinkSync(this.filePath + '.tmp'); } catch (_) { }
        return { ok: false, error: 'TASTE_WRITE_FAILED', detail: (e && e.message) || String(e) };
      }
    };
    return attempt(0);
  }

  save(document) {
    const current = this.read();
    if (!current.ok) return current;
    return this.write(document);
  }

  clear() {
    const current = this.read();
    if (!current.ok) return current;
    return this.write(Object.assign(emptyDocument(), { createdAt: this.now() }));
  }
}

module.exports = {
  TasteProfileStore,
  TASTE_FILE,
  normalizeTasteDocument: normalizeDocument,
};

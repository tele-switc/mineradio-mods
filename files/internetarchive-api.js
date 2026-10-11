'use strict';

// ====================================================================
//  Internet Archive 适配层 —— 免登录、无需 API key 的公开音频库
//
//  端点均于 2026-09-27 本机实测（curl，含实测到的 HTTP 状态与 CT）：
//   - 搜索     GET archive.org/advancedsearch.php?...&output=json
//       → 200 application/json，无需登录与 key
//         实测 q=beethoven AND mediatype:(audio) → response.numFound = 8548
//         响应体：responseHeader.status / response.numFound / response.docs[]
//         docs 每项含 identifier / title / creator / year / licenseurl
//         （title 与 creator 都可能是数组，两种形态都要吃）
//   - 元数据   GET archive.org/metadata/<id>  → 200 application/json
//         顶层：files / files_count / metadata / dir / server / workable_servers
//         files[] 每项含 name / source / format / size / bitrate / length
//         实测样例：format 有 "VBR MP3"、"Opus"、"Apple Lossless Audio"、"PNG"
//                   length 形如 "09:50"
//   - 音频文件 GET archive.org/download/<id>/<file>
//         → 302 → ia*.us.archive.org → 200/206，Accept-Ranges: bytes、有 Content-Length
//         实测带「错误的 Referer」仍回 206 audio/mpeg（Node fetch 自动跟 302）
//   - 封面     GET archive.org/services/img/<id>  → 200/206 image/jpeg
//
//  可播性白名单：Electron(Chromium) 没有 ALAC/CAF、AIFF、Shorten、APE 等解码器，
//  下发了必卡。所以挑文件时先按容器过一遍白名单，宁可退档也不下发 .caf。
//  这是「如实返回实际拿到的档位」，不冒充更高音质。
// ====================================================================

const PROVIDER = 'internetarchive';
const FETCH_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata/';
const DOWNLOAD_URL = 'https://archive.org/download/';
const IMAGE_URL = 'https://archive.org/services/img/';

const SEARCH_LIMIT_MIN = 4;
const SEARCH_LIMIT_MAX = 30;

// Chromium/Electron 无法解码的容器（扩名或 format 命中即整条丢弃）
const UNPLAYABLE_EXT = ['.caf', '.aiff', '.aif', '.shn', '.wv', '.ape', '.dsf', '.tta', '.mpc', '.mid', '.midi'];
const UNPLAYABLE_FORMAT_RE = /apple lossless|\balac\b|aiff|shorten|video/;

// 档位顺序与渲染层音质键对齐：lossless > exhigh > standard
const TIER_RANK = { lossless: 3, exhigh: 2, standard: 1 };
const TIER_ORDER = ['lossless', 'exhigh', 'standard'];

const itemCache = new Map();
const ITEM_CACHE_TTL_MS = 5 * 60 * 1000;
const ITEM_CACHE_MAX = 120;

async function requestJson(target, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: opts.method || 'GET',
      headers: opts.headers || { 'User-Agent': UA },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ARCHIVE_HTTP_${res.status}`);
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) throw new Error('ARCHIVE_RESPONSE_NOT_JSON');
    return JSON.parse(trimmed);
  } finally {
    clearTimeout(timer);
  }
}

function archiveFileNameExt(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot > 0 ? text.slice(dot).toLowerCase() : '';
}

// 返回可播档位：lossless / exhigh / standard，空串表示「Chromium 播不了」
function archiveTierOf(file) {
  const name = String((file && file.name) || '');
  if (!name) return '';
  const ext = archiveFileNameExt(name);
  const format = String((file && file.format) || '').toLowerCase();
  if (UNPLAYABLE_EXT.indexOf(ext) >= 0) return '';
  if (format && UNPLAYABLE_FORMAT_RE.test(format)) return '';
  if (ext === '.flac' || format.indexOf('flac') >= 0) return 'lossless';
  if (ext === '.wav' || format.indexOf('wave') >= 0) return 'lossless';
  if (ext === '.mp3' || format.indexOf('mp3') >= 0) return 'exhigh';
  if (ext === '.m4a' || ext === '.aac' || format.indexOf('aac') >= 0 || format.indexOf('mpeg-4') >= 0) return 'exhigh';
  if (ext === '.ogg' || ext === '.oga' || format.indexOf('vorbis') >= 0) return 'standard';
  if (ext === '.opus' || format.indexOf('opus') >= 0) return 'standard';
  return '';
}

// 同档内：码率高者优先，其次体积大者优先（IA 的 bitrate 是字符串）
function archiveSortedAudioFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => ({
      file,
      tier: archiveTierOf(file),
      bitrate: Number(file && file.bitrate) || 0,
      size: Number(file && file.size) || 0,
    }))
    .filter((entry) => TIER_RANK[entry.tier])
    .sort((a, b) => {
      if (TIER_RANK[b.tier] !== TIER_RANK[a.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
      if (b.bitrate !== a.bitrate) return b.bitrate - a.bitrate;
      if (b.size !== a.size) return b.size - a.size;
      return String(a.file.name || '').localeCompare(String(b.file.name || ''));
    });
}

// 请求档位优先；该档没有资源时取整个条目里最好的一档，
// 并在返回体里如实标注实际拿到的档位，不冒充成用户点的那一档。
function archivePickFile(files, quality) {
  const candidates = archiveSortedAudioFiles(files);
  if (!candidates.length) return null;
  const wanted = TIER_RANK[String(quality || '')] ? String(quality) : 'lossless';
  const exact = candidates.filter((entry) => entry.tier === wanted);
  return exact.length ? exact[0] : candidates[0];
}

function archiveParseLength(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !isFinite(part) || part < 0)) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

// 文件名按段编码并挡住 ../；IA 的 files 通常平铺，但不假定
function archiveJoinText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' / ');
  return value == null ? '' : String(value);
}

function archiveDocToSong(doc) {
  const identifier = String((doc && doc.identifier) || '');
  if (!identifier) return null;
  const title = Array.isArray(doc.title) ? doc.title[0] : doc.title;
  return {
    provider: PROVIDER,
    source: PROVIDER,
    type: PROVIDER,
    id: identifier,
    archiveId: identifier,
    name: String(title || identifier),
    artist: archiveJoinText(doc.creator) || 'Internet Archive',
    album: 'Internet Archive',
    year: doc.year == null ? '' : String(doc.year),
    cover: `${IMAGE_URL}${encodeURIComponent(identifier)}`,
    duration: 0,
    licenseUrl: String(doc.licenseurl || ''),
    itemUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    // 条目级元数据没有时长，时长在取链阶段由 files[].length 给出
    canListen: true,
  };
}

// 音乐过滤。只卡 mediatype:(audio) 会捞进整堆播客与电台节目——2026-10-03 实测
// `Miles Davis AND mediatype:(audio)` 共 8329 条，前三条是政治播客和电台整档录音。
// 收窄到音乐向集合后（同一台机器实测 advancedsearch）：
//   Miles Davis 8329 → 297；beethoven 8549 → 2606；musopen 202 → 34；"Grateful Dead" 9325 → 365
// 集合并列的两个理由：audio_music 是音乐总伞集合（etree/78rpm/taperssection 等子集都带它），
// etree/live-music 是现场录音库（Live Music Archive），musopen 是公版古典录音（它不带 audio_music，
// 漏掉就搜不到），opensourceroad 是电台音乐节目。排除项是"带音乐字样但不是音乐"的电台/播客镜像。
const MUSIC_COLLECTIONS = ['audio_music', 'etree', 'live-music', 'musopen', 'opensourceroad'];
const NON_MUSIC_COLLECTIONS = ['fmradioarchive', 'radioshowarchive', 'radio', 'podcasts_mirror', 'podcasts', 'stream_only'];

// 搜索始终限定 mediatype:(audio) + 音乐集合，并剔掉播客/电台整档录音
function archiveMusicQuery(keywords) {
  const clean = String(keywords || '').trim();
  const include = `collection:(${MUSIC_COLLECTIONS.join(' OR ')})`;
  const exclude = `NOT collection:(${NON_MUSIC_COLLECTIONS.join(' OR ')})`;
  return (clean ? `${clean} AND ` : '') + `mediatype:(audio) AND ${include} AND ${exclude}`;
}

function handleArchiveSearch(keywords, limit, offset) {
  const query = archiveMusicQuery(keywords);
  const max = Math.max(SEARCH_LIMIT_MIN, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 12));
  const start = Math.max(0, Number(offset) || 0);
  const params = new URLSearchParams({
    q: query,
    rows: String(max),
    page: String(Math.floor(start / max) + 1),
    output: 'json',
  });
  ['identifier', 'title', 'creator', 'year', 'licenseurl'].forEach((field) => params.append('fl[]', field));
  return requestJson(`${SEARCH_URL}?${params.toString()}`)
    .then((json) => {
      const response = (json && json.response) || {};
      const docs = Array.isArray(response.docs) ? response.docs : [];
      const songs = docs.map(archiveDocToSong).filter(Boolean);
      const total = Number(response.numFound) || 0;
      return { songs, total, offset: start, hasMore: start + songs.length < total };
    })
    .catch((err) => {
      console.error('[ArchiveSearch]', err);
      return { songs: [], total: 0, offset: start, hasMore: false, error: err.message };
    });
}

function readArchiveItem(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return Promise.resolve(null);
  const cached = itemCache.get(id);
  if (cached && Date.now() - cached.at < ITEM_CACHE_TTL_MS) return Promise.resolve(cached.value);
  return requestJson(`${METADATA_URL}${encodeURIComponent(id)}`).then((json) => {
    const files = (json && Array.isArray(json.files)) ? json.files : [];
    const meta = (json && json.metadata) || {};
    const value = {
      identifier: id,
      files,
      title: archiveJoinText(meta.title) || id,
      creator: archiveJoinText(meta.creator),
      licenseUrl: String(meta.licenseurl || ''),
      dir: String(json && json.dir || ''),
    };
    if (itemCache.size >= ITEM_CACHE_MAX) {
      const oldest = itemCache.keys().next().value;
      if (oldest !== undefined) itemCache.delete(oldest);
    }
    itemCache.set(id, { at: Date.now(), value });
    return value;
  }).catch((err) => {
    console.error('[ArchiveItem]', id, err && err.message);
    return null;
  });
}

// 文件名按段编码并挡住 ../；IA 的 files 通常平铺，但不假定
function archiveDownloadUrl(identifier, fileName) {
  const id = String(identifier || '').trim();
  const raw = String(fileName || '');
  if (!id || !raw) return '';
  if (raw.indexOf('..') >= 0 || raw.charAt(0) === '/') return '';
  const encoded = raw.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (!encoded) return '';
  return `${DOWNLOAD_URL}${encodeURIComponent(id)}/${encoded}`;
}

async function handleArchiveSongUrl(input) {
  const opts = input || {};
  const identifier = String(opts.archiveId || opts.identifier || opts.id || '').trim();
  if (!identifier) {
    return { provider: PROVIDER, url: '', playable: false, error: 'ARCHIVE_MISSING_IDENTIFIER', message: '缺少 archive.org identifier' };
  }
  const item = await readArchiveItem(identifier);
  if (!item || !Array.isArray(item.files) || !item.files.length) {
    return {
      provider: PROVIDER,
      url: '',
      playable: false,
      error: 'ARCHIVE_NO_ITEM',
      message: '该条目没有可读取的文件列表（可能是受限或已下架条目）',
      archiveId: identifier,
    };
  }

  // 显式指定文件时必须通过可播性白名单；不允许绕过
  let picked = null;
  const explicit = String(opts.file || '').trim();
  if (explicit) {
    const match = item.files.filter((file) => String(file.name || '') === explicit)[0];
    if (match && archiveTierOf(match)) picked = { file: match, tier: archiveTierOf(match) };
  } else {
    picked = archivePickFile(item.files, opts.quality);
  }

  if (!picked || !picked.file) {
    return {
      provider: PROVIDER,
      url: '',
      playable: false,
      error: 'ARCHIVE_NO_PLAYABLE_AUDIO',
      message: '该条目只有本机无法解码的音频格式（如 ALAC/CAF/AIFF/Shorten）',
      archiveId: identifier,
      audioFileCount: item.files.length,
    };
  }

  const url = archiveDownloadUrl(identifier, picked.file.name);
  if (!url) {
    return { provider: PROVIDER, url: '', playable: false, error: 'ARCHIVE_BAD_FILE_NAME', archiveId: identifier };
  }
  const durationSeconds = archiveParseLength(picked.file.length);
  return {
    provider: PROVIDER,
    url,
    playable: true,
    quality: picked.tier,
    qualityLabel: picked.tier === 'lossless' ? '无损 (FLAC/WAV)' : (picked.tier === 'exhigh' ? '高音质 (MP3/AAC)' : '标准 (Ogg/Opus)'),
    file: String(picked.file.name || ''),
    format: String(picked.file.format || ''),
    bitrate: Number(picked.file.bitrate) || 0,
    sizeBytes: Number(picked.file.size) || 0,
    durationSeconds,
    archiveId: identifier,
    identifier,
    licenseUrl: item.licenseUrl,
    title: item.title,
    creator: item.creator,
    needsProxy: true,
  };
}

// 与 B 站同一处理方式：给确定答复，不掉进网易云兜底分支
function handleArchiveLyric() {
  return Promise.resolve({
    provider: PROVIDER,
    lyric: '',
    trans: '',
    reason: 'ARCHIVE_NO_SYNCED_LYRICS',
  });
}

function clearArchiveSessionCaches() {
  itemCache.clear();
}

module.exports = {
  PROVIDER,
  SEARCH_URL,
  METADATA_URL,
  DOWNLOAD_URL,
  handleArchiveSearch,
  archiveMusicQuery,
  MUSIC_COLLECTIONS,
  NON_MUSIC_COLLECTIONS,
  handleArchiveSongUrl,
  handleArchiveLyric,
  archiveTierOf,
  archivePickFile,
  archiveSortedAudioFiles,
  archiveDownloadUrl,
  archiveParseLength,
  readArchiveItem,
  clearArchiveSessionCaches,
  _test: { archiveDocToSong, archiveJoinText, archiveFileNameExt },
};



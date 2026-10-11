'use strict';

// ====================================================================
//  Radio Paradise 适配层 —— 只做免登录的公开直播流播放
//
//  这是一个「直播（live）」源，不是点播源：一个频道 = 一条连续 AAC 流，
//  没有单曲、没有可拖拽进度、没有同步歌词。播放器侧按 duration=Infinity
//  自然降级（全工程对 audio.duration 都用 isFinite 守卫）。
//
//  端点与流地址均于 2026-09-27 本机实测（curl，含实测到的 HTTP 状态与 CT）：
//   - now_playing  GET api.radioparadise.com/api/now_playing?chan=N
//       → 200 application/json；chan=0..6 全部返回
//         { time, artist, title, album, year, cover, cover_med, cover_small }
//   - 频道流        GET stream-dc1.radioparadise.com/<slug>  → 200 audio/aac
//       实测 200 的 slug：aac-320 / mellow-320 / rock-320 / global-320 /
//       beyond-320 / serenity（serenity 无 -320 后缀）
//       实测 404 的 slug：serenity-320 / 2050-320 / 2050 / rp2050-320 / pulse-320
//       响应头 icy-br: 320、icy-pub: 1、icy-name: Radio Paradise (320k aac)
//       → 平台自己公开的 320k 直播，无需注册或登录
//   - 流响应没有 Content-Length / Accept-Ranges，并且不返回
//     Access-Control-Allow-Origin，所以渲染层不能直连，必须走 /api/audio 代理。
//   - chan=6（Radio 2050）没有实测到可用的直链 slug，因此不下发，
//     避免写出没验证过的端点。
// ====================================================================

const PROVIDER = 'radioparadise';
const FETCH_TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const NOW_PLAYING_URL = 'https://api.radioparadise.com/api/now_playing';

// 实测可用的两处边缘节点（美国 dc1 / 欧洲 uk1）
const STREAM_HOSTS = {
  us: 'stream-dc1.radioparadise.com',
  eu: 'stream-uk1.radioparadise.com',
};

// 频道表：chan / slug / 名称 / 描述，slug 与 chan 的对应关系来自实测
// （now_playing 的 chan 顺序 + 各 slug 的 200 探测）。
const CHANNELS = [
  { chan: 0, slug: 'aac-320', name: 'Main Mix', desc: '主线综合：摇滚、电子、世界音乐' },
  { chan: 1, slug: 'mellow-320', name: 'Mellow Mix', desc: '舒缓线' },
  { chan: 2, slug: 'rock-320', name: 'Rock Mix', desc: '摇滚线' },
  { chan: 3, slug: 'global-320', name: 'Global Mix', desc: '世界音乐线' },
  { chan: 4, slug: 'beyond-320', name: 'Beyond', desc: 'Beyond 线' },
  { chan: 5, slug: 'serenity', name: 'Serenity', desc: '氛围 / 静心线' },
];

const nowPlayingCache = new Map();
const NOW_PLAYING_CACHE_TTL_MS = 20 * 1000;


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
    if (!res.ok) throw new Error(`RP_HTTP_${res.status}`);
    if (!text.trim().startsWith('{')) throw new Error('RP_RESPONSE_NOT_JSON');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRpRegion(region) {
  return String(region || '').toLowerCase() === 'eu' ? 'eu' : 'us';
}

function rpChannelStreamUrl(channel, region) {
  const host = STREAM_HOSTS[normalizeRpRegion(region)];
  return `https://${host}/${channel.slug}`;
}

function rpChannelByChan(chan) {
  const value = Number(chan);
  if (!isFinite(value)) return null;
  return CHANNELS.filter((item) => item.chan === value)[0] || null;
}

function rpChannelBySlug(slug) {
  const value = String(slug || '').trim().toLowerCase();
  if (!value) return null;
  return CHANNELS.filter((item) => item.slug === value)[0] || null;
}

// 只用已实测的 slug，未知输入一律判空，不构造猜测地址
function rpResolveChannel(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object') {
    const key = ref.rpChan != null ? ref.rpChan : (ref.chan != null ? ref.chan : (ref.rpSlug || ref.slug || ref.id));
    return rpResolveChannel(key);
  }
  const text = String(ref).trim();
  if (!text) return null;
  if (/^rp:\d+$/.test(text)) return rpChannelByChan(Number(text.slice(3)));
  if (/^\d+$/.test(text)) return rpChannelByChan(Number(text));
  return rpChannelBySlug(text);
}

function rpChannelList(region) {
  const edge = normalizeRpRegion(region);
  return CHANNELS.map((channel) => ({
    provider: PROVIDER,
    chan: channel.chan,
    slug: channel.slug,
    name: channel.name,
    desc: channel.desc,
    region: edge,
    streamUrl: rpChannelStreamUrl(channel, edge),
    quality: 'aac320',
    qualityLabel: '320k AAC 直播',
    live: true,
  }));
}

function normalizeRpNowPlaying(json, channel) {
  const data = json || {};
  return {
    provider: PROVIDER,
    chan: channel ? channel.chan : null,
    channel: channel ? channel.name : '',
    time: Number(data.time) || 0,
    artist: String(data.artist || ''),
    title: data.title == null ? '' : String(data.title),
    album: data.album == null ? '' : String(data.album),
    year: data.year == null ? '' : String(data.year),
    cover: String(data.cover || ''),
    coverMedium: String(data.cover_med || ''),
    coverSmall: String(data.cover_small || ''),
  };
}

async function getRpNowPlaying(channel) {
  if (!channel) return normalizeRpNowPlaying({}, null);
  const cached = nowPlayingCache.get(channel.chan);
  if (cached && Date.now() - cached.at < NOW_PLAYING_CACHE_TTL_MS) return cached.value;
  try {
    const json = await requestJson(`${NOW_PLAYING_URL}?chan=${channel.chan}`);
    const value = normalizeRpNowPlaying(json, channel);
    nowPlayingCache.set(channel.chan, { at: Date.now(), value });
    return value;
  } catch (_) {
    // 拿不到「正在播放」不影响直播本身，返回空壳而不是抛错
    return normalizeRpNowPlaying({}, channel);
  }
}

async function handleRpNowPlaying(chan) {
  const channel = rpResolveChannel(chan);
  if (!channel) {
    return { provider: PROVIDER, error: 'RP_UNKNOWN_CHANNEL', message: '未知的 Radio Paradise 频道', chan: null };
  }
  const info = await getRpNowPlaying(channel);
  return Object.assign({}, info, { ok: true });
}

// 直播源没有「搜索」语义：这里把频道当作可播条目下发，
// 关键词只用来排序（命中频道名/描述/在播曲目的排前面），空关键词给全部频道。
async function handleRpSearch(keywords, limit, region) {
  const query = String(keywords || '').trim().toLowerCase();
  const edge = normalizeRpRegion(region);
  const max = Math.max(1, Math.min(20, Number(limit) || 12));
  const nowPlayingList = await Promise.all(CHANNELS.map((channel) => getRpNowPlaying(channel)));

  const rows = CHANNELS.map((channel, index) => {
    const live = nowPlayingList[index] || {};
    const haystack = [channel.name, channel.desc, channel.slug, live.artist, live.title, live.album]
      .join(' ').toLowerCase();
    const matched = query ? haystack.indexOf(query) >= 0 : false;
    const nameMatched = query
      ? (channel.name + ' ' + channel.desc + ' ' + channel.slug).toLowerCase().indexOf(query) >= 0
      : false;
    return { channel, live, matched, nameMatched, index };
  });

  const selected = query ? rows.filter((row) => row.matched) : rows;
  // 频道名命中 > 仅在播曲目命中；同档按频道序号，保证顺序稳定
  selected.sort((a, b) => {
    if (a.nameMatched !== b.nameMatched) return a.nameMatched ? -1 : 1;
    return a.index - b.index;
  });

  return selected.slice(0, max).map((row) => {
    const live = row.live || {};
    const liveBits = [live.artist, live.title].filter(Boolean).join(' - ');
    return {
      provider: PROVIDER,
      source: PROVIDER,
      type: PROVIDER,
      id: `rp:${row.channel.chan}`,
      rpChan: row.channel.chan,
      rpSlug: row.channel.slug,
      rpRegion: edge,
      name: `Radio Paradise · ${row.channel.name}`,
      artist: liveBits || 'Radio Paradise 直播',
      album: `320k AAC 直播 · ${row.channel.desc}`,
      // 直播没有固定封面：用「搜索那一刻正在播放」的封面做快照
      cover: live.cover || '',
      coverSmall: live.coverSmall || '',
      duration: 0,
      live: true,
      noSeek: true,
      canListen: true,
      nowPlaying: liveBits,
      searchKeywordMatched: row.nameMatched,
    };
  });
}

async function handleRpSongUrl(input) {
  const opts = input || {};
  const ref = opts.rpChan != null ? opts.rpChan : (opts.chan != null ? opts.chan : (opts.slug || opts.rpSlug || opts.id));
  const channel = rpResolveChannel(ref);
  if (!channel) {
    return {
      provider: PROVIDER,
      url: '',
      playable: false,
      error: 'RP_UNKNOWN_CHANNEL',
      message: '未知的 Radio Paradise 频道（只支持已实测的频道 slug）',
    };
  }
  const region = normalizeRpRegion(opts.region);
  const live = await getRpNowPlaying(channel);
  return {
    provider: PROVIDER,
    url: rpChannelStreamUrl(channel, region),
    playable: true,
    live: true,
    noSeek: true,
    quality: 'aac320',
    qualityLabel: '320k AAC 直播',
    bandwidth: 320000,
    channel: channel.name,
    rpChan: channel.chan,
    rpSlug: channel.slug,
    region,
    nowPlaying: [live.artist, live.title].filter(Boolean).join(' - '),
    cover: live.cover || '',
    // 直播流无 CORS 头且无 Content-Length，必须经本地 /api/audio 代理
    needsProxy: true,
  };
}

function clearRpSessionCaches() {
  nowPlayingCache.clear();
}

module.exports = {
  PROVIDER,
  CHANNELS,
  STREAM_HOSTS,
  handleRpChannels: (region) => rpChannelList(region),
  handleRpSearch,
  handleRpSongUrl,
  handleRpNowPlaying,
  rpChannelList,
  rpResolveChannel,
  rpChannelStreamUrl,
  normalizeRpRegion,
  clearRpSessionCaches,
};
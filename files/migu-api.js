'use strict';

// ====================================================================
//  咪咕音乐适配层（Mineradio）
//  - 只做在线播放，不落盘、不下载、不解密任何受保护内容
//  - 全部端点于 2026-09-25 在本机实测：搜索 / 取播放地址 / 可播校验 / 歌词
//  - 取址走「高音质→低音质逐级降级」：咪咕对未登录请求返回 cannotCode 440003
//    （文案"登录后免费试听"）而不是 URL，逐档试下去自然落在账号有权的最高档
//  - 明确不做：咪咕 h5 播放地址接口的响应体混淆解码（需要官方前端内嵌密钥），
//    那属于规避技术措施，不在本适配层范围内
// ====================================================================

const PROVIDER = 'migu';
const FETCH_TIMEOUT_MS = 12000;

const MIGU_SEARCH_URL = 'https://c.musicapp.migu.cn/v1.0/content/search_all.do';
const MIGU_LISTEN_URL = 'https://app.c.nf.migu.cn/MIGUM3.0/strategy/pc/listen/v1.0';
const MIGU_CAN_LISTEN_URL = 'https://app.c.nf.migu.cn/strategy/pc/can-listen/v1.0';

// 实测：搜索接口要这组头，缺一即 301 到 H5 页
const MIGU_SEARCH_HEADERS = {
  'ua': 'Android_migu',
  'version': '6.8.8',
  'channel': '1000143',
  'Origin': 'http://h5.nf.migu.cn',
  'Referer': 'http://h5.nf.migu.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// 实测：取址接口用 PC 站 channel，且必须带 birth/signature 两个标记头
const MIGU_LISTEN_HEADERS = {
  'channel': '014X031',
  'subchannel': '014X031',
  'ua': 'Android_migu',
  'version': '6.8.8',
  'activityId': 'MUSIC-WWW',
  'birth': 'h5page',
  'signature': '1',
  'Referer': 'https://music.migu.cn/',
  'User-Agent': MIGU_SEARCH_HEADERS['User-Agent'],
};

// 音质档由高到低。resourceType 取自真实响应实测值（LQ=3 / PQ=2 / HQ=2 / SQ=E / ZQ=2），
// 写错会被回以 444001 资源类型错误，降级链会自动跳过，不会卡死播放。
const TIER_ORDER = ['ZQ', 'SQ', 'HQ', 'PQ', 'LQ'];
const TIER_RESOURCE_TYPE = { LQ: '3', PQ: '2', HQ: '2', SQ: 'E', ZQ: '2' };
const TIER_LABEL = {
  ZQ: '24bit 母带', SQ: '无损 FLAC', HQ: '320kbps', PQ: '128kbps', LQ: '低音质',
};

// 只能向这些主机取回内容，防止渲染层把任意 URL 塞给本地后端代取（SSRF）
const ALLOWED_RESOURCE_HOSTS = /(^|\.)(migu\.cn|musicapp\.migu\.cn|nf\.migu\.cn)$/i;

function isHttpsResource(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_RESOURCE_HOSTS.test(u.hostname);
  } catch (_) {
    return false;
  }
}

async function requestJson(target, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MIGU_HTTP_${res.status}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      // 咪咕在限流/风控时会返回 HTML，这里给出可辨识的错误而不是崩在 JSON.parse
      throw new Error('MIGU_RESPONSE_NOT_JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim();
}

/* ---------------- Cookie ---------------- */

function normalizeMiguCookieInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return input.map(normalizeMiguCookieInput).filter(Boolean).join('; ');
  if (typeof input === 'object') {
    return Object.keys(input)
      .map((k) => `${k}=${input[k]}`)
      .join('; ');
  }
  return String(input);
}

function miguCookieObject(raw) {
  const out = {};
  normalizeMiguCookieInput(raw).split(/;\s*/).forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// 判登录：咪咕 PC 站的会话键。注意这是"存在即视为已登录"的弱判定，
// 真正的权益校验由取址接口的 cannotCode 决定，不靠这里猜。
// 键名以 2026-10-03 从 music.migu.cn 登录会话里实测取到的为准：mg_auth_sid / idmpauth /
// pacmtoken / USessionID / LTToken 才是网页版实际下发的会话键；原先只认 token/userid 那组
// 是早先按 App 端猜的，网页登录成功后一个都不存在，会导致"登录了但软件认为没登录"。
function miguCookieHasLogin(raw) {
  const obj = miguCookieObject(raw);
  return !!(obj.mg_auth_sid || obj.idmpauth || obj.pacmtoken || obj.USessionID || obj.LTToken
    || obj.token || obj.dycnToken || obj.MGUCCKEY || obj.Authorization || obj.userid);
}

function buildMiguRequestCookie(raw) {
  return normalizeMiguCookieInput(raw);
}

function miguHeadersWithCookie(raw) {
  const cookie = buildMiguRequestCookie(raw);
  const headers = Object.assign({}, MIGU_LISTEN_HEADERS);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/* ---------------- 搜索结果映射 ---------------- */

function pickMiguCover(item) {
  const list = Array.isArray(item.imgItems) ? item.imgItems : [];
  if (!list.length) return '';
  // 01 是小图、03 是大图：优先大图，搜索列表用 02 足够
  const byPreference = ['03', '02', '01'];
  for (const size of byPreference) {
    const hit = list.find((x) => String(x.imgSizeType) === size && isHttpsResource(x.img));
    if (hit) return hit.img;
  }
  const any = list.find((x) => isHttpsResource(x.img));
  return any ? any.img : '';
}

function mapMiguArtists(item) {
  const list = Array.isArray(item.singers) ? item.singers : [];
  return list
    .map((s) => ({ id: String(s.id || ''), name: normalizeText(s.name) }))
    .filter((s) => s.name);
}

function collectMiguTiers(item) {
  const tiers = [];
  const push = (t) => {
    if (!t || !t.formatType) return;
    if (!tiers.some((x) => x.formatType === t.formatType)) tiers.push(t);
  };
  (Array.isArray(item.rateFormats) ? item.rateFormats : []).forEach(push);
  (Array.isArray(item.newRateFormats) ? item.newRateFormats : []).forEach(push);
  return tiers;
}

function mapMiguSearchItem(item) {
  item = item || {};
  const artists = mapMiguArtists(item);
  const tiers = collectMiguTiers(item);
  const contentId = String(item.contentId || '').trim();
  const copyrightId = String(item.copyrightId || '').trim();
  // free = 该档 price 为 0，即咪咕自己声明的免费可播档
  const freeTiers = TIER_ORDER.filter((t) => tiers.some((x) => x.formatType === t && String(x.price) === '0'));
  const paidTiers = TIER_ORDER.filter((t) => tiers.some((x) => x.formatType === t && String(x.price) !== '0'));
  const cover = pickMiguCover(item);
  return {
    provider: PROVIDER,
    source: PROVIDER,
    type: PROVIDER,
    id: contentId || String(item.id || ''),
    contentId,
    copyrightId,
    rawId: String(item.id || ''),
    name: normalizeText(item.name),
    artist: artists.map((a) => a.name).join(' / '),
    artists,
    album: normalizeText(item.albums && item.albums[0] && item.albums[0].name),
    albumId: String((item.albums && item.albums[0] && item.albums[0].id) || ''),
    cover,
    picUrl: cover,
    duration: 0,
    // 咪咕搜索响应不含时长（实测无 duration 字段），交给播放器加载后回填
    lyricUrl: isHttpsResource(item.lyricUrl) ? item.lyricUrl : '',
    mrcUrl: isHttpsResource(item.mrcurl) ? item.mrcurl : '',
    tiers,
    freeTiers,
    paidTiers,
    quality: freeTiers[0] || paidTiers[paidTiers.length - 1] || '',
    maxQuality: TIER_ORDER.find((t) => tiers.some((x) => x.formatType === t)) || '',
    // chargeAuditions=0 且 copyright=1：咪咕声明该曲可正常试听
    chargeAuditions: String(item.chargeAuditions || '0'),
    copyrighted: String(item.copyright || '') === '1',
    trialFlag: false,
  };
}

async function handleMiguSearch(keywords, limit, cookie, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const size = Math.max(4, Math.min(30, Number(limit) || 12));
  const start = Math.max(0, Number(offset) || 0);
  const pageNo = Math.floor(start / size) + 1;
  const query = new URLSearchParams({
    text: kw,
    pageNo: String(pageNo),
    pageSize: String(size),
    isCopyright: '1',
    // 实测：带上空值 sort= 会被咪咕回以 code 199999，必须整个省略
    searchSwitch: JSON.stringify({ song: 1, album: 0, songCount: 0, albumCount: 0 }),
  });
  const headers = Object.assign({}, MIGU_SEARCH_HEADERS);
  const cookieText = buildMiguRequestCookie(cookie);
  if (cookieText) headers.Cookie = cookieText;
  const json = await requestJson(`${MIGU_SEARCH_URL}?${query.toString()}`, { headers });
  if (String(json.code || '') !== '000000') throw new Error(`MIGU_SEARCH_${json.code || 'UNKNOWN'}`);
  const rows = (json.songResultData && json.songResultData.result) || [];
  const skip = start - (pageNo - 1) * size;
  return rows.map(mapMiguSearchItem).filter((s) => s.contentId).slice(skip, skip + size);
}

/* ---------------- 播放地址 ---------------- */

// 搜索结果里的档位表缓存在内存里，取址时按 contentId 复用；
// 没有缓存就用实测默认 resourceType 映射，错了会被降级链跳过。
const tierCache = new Map();
const TIER_CACHE_LIMIT = 300;

function rememberMiguTiers(song) {
  if (!song || !song.contentId) return;
  if (tierCache.size >= TIER_CACHE_LIMIT) {
    const oldest = tierCache.keys().next().value;
    tierCache.delete(oldest);
  }
  tierCache.set(song.contentId, { tiers: song.tiers || [], copyrightId: song.copyrightId || '' });
}

function cachedMiguTiers(contentId) {
  return tierCache.get(String(contentId || '')) || null;
}

function clearMiguSessionCaches() {
  tierCache.clear();
}

function requestedTierOrder(quality) {
  const q = String(quality || '').toUpperCase();
  if (TIER_ORDER.includes(q)) {
    const i = TIER_ORDER.indexOf(q);
    return TIER_ORDER.slice(i).concat(TIER_ORDER.slice(0, i));
  }
  return TIER_ORDER.slice();
}

async function fetchMiguListenUrl({ contentId, copyrightId, resourceType, toneFlag }, cookie) {
  const query = new URLSearchParams({
    contentId,
    copyrightId,
    resourceType: String(resourceType),
    toneFlag,
    scene: '',
    netType: '01',
  });
  const json = await requestJson(`${MIGU_LISTEN_URL}?${query.toString()}`, { headers: miguHeadersWithCookie(cookie) });
  const data = json.data || {};
  if (String(json.code || '') !== '000000') {
    return { ok: false, error: `MIGU_LISTEN_${json.code || 'UNKNOWN'}` };
  }
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (url) {
    if (!isHttpsResource(url)) return { ok: false, error: 'MIGU_UNSAFE_AUDIO_HOST' };
    return { ok: true, url, toneFlag };
  }
  return {
    ok: false,
    cannotCode: String(data.cannotCode || ''),
    message: (data.dialogInfo && normalizeText(data.dialogInfo.text)) || '',
  };
}

async function handleMiguSongUrl(params, cookie) {
  const p = params || {};
  const contentId = String(p.contentId || p.id || '').trim();
  if (!contentId) {
    return { provider: PROVIDER, url: '', playable: false, error: 'MISSING_CONTENT_ID', message: '缺少咪咕 contentId' };
  }
  const cached = cachedMiguTiers(contentId);
  const copyrightId = String(p.copyrightId || (cached && cached.copyrightId) || '').trim();
  if (!copyrightId) {
    return { provider: PROVIDER, url: '', playable: false, error: 'MISSING_COPYRIGHT_ID', message: '缺少咪咕 copyrightId' };
  }
  const knownTiers = cached && cached.tiers && cached.tiers.length ? cached.tiers : null;
  const refused = [];
  const order = requestedTierOrder(p.quality);

  for (const toneFlag of order) {
    const tier = knownTiers ? knownTiers.find((t) => t.formatType === toneFlag) : null;
    if (knownTiers && !tier) {
      refused.push({ toneFlag, reason: 'NOT_OFFERED' });
      continue;
    }
    const resourceType = (tier && tier.resourceType) || TIER_RESOURCE_TYPE[toneFlag] || '2';
    const result = await fetchMiguListenUrl({ contentId, copyrightId, resourceType, toneFlag }, cookie);
    if (result.ok) {
      return {
        provider: PROVIDER,
        url: result.url,
        playable: true,
        quality: toneFlag,
        qualityLabel: TIER_LABEL[toneFlag] || toneFlag,
        resourceType,
        // 咪咕响应不含码率数值（只有 format 代号与文件字节数），这里不臆造，交给 UI 用 sizeBytes 估算
        bitrate: 0,
        sizeBytes: Number((tier && (tier.size || tier.androidSize)) || 0) || 0,
        refusedTiers: refused,
        contentId,
        copyrightId,
        loggedIn: miguCookieHasLogin(cookie),
      };
    }
    refused.push({
      toneFlag,
      reason: result.cannotCode || result.error || 'NO_URL',
      message: result.message || '',
    });
    // 逐档降级的全部意义就是继续往下试：任何一档失败都不中断整条链，
    // 只有连最低档都拿不到地址才最终判为不可播。
  }

  // 实测到的咪咕拒绝码：440003 登录后免费试听 / 440022 会员专属音质请先登录 /
  // 440013 版权方要求开通白金会员后播放 / 440018 该音质暂不支持播放 / 444001 资源类型错误
  const LOGIN_CODES = new Set(['440003', '440022']);
  const MEMBER_CODES = new Set(['440013']);
  const needsLogin = refused.some((r) => LOGIN_CODES.has(String(r.reason)));
  const needsMembership = refused.some((r) => MEMBER_CODES.has(String(r.reason)));
  return {
    provider: PROVIDER,
    url: '',
    playable: false,
    error: needsLogin ? 'MIGU_LOGIN_REQUIRED' : (needsMembership ? 'MIGU_MEMBERSHIP_REQUIRED' : 'MIGU_NO_PLAYABLE_TIER'),
    requiresLogin: needsLogin,
    requiresMembership: needsMembership,
    refusedTiers: refused,
    message: needsLogin
      ? '咪咕要求先登录你自己的账号才能取到该音质。'
      : (needsMembership
        ? '版权方要求该曲需会员权益才能播放，Mineradio 不做任何绕过。'
        : '咪咕未返回可播地址（可能无版权或已下架）。'),
    contentId,
    copyrightId,
  };
}

/* ---------------- 可播校验 ---------------- */

// 实测（24 样本）：can-listen 对"匿名能否真取到可播地址"预测准确率 100%，
// 且 limitLength=true 精确对应"需登录/需会员"，limitLength=false 对应"该版本无版权"。
// 用它做搜索阶段标注，用户就不必逐条点了才知道不能播。
async function annotateMiguSearchPlayability(songs, cookie) {
  const list = Array.isArray(songs) ? songs.filter((s) => s && s.contentId) : [];
  if (!list.length) return list;
  let map = {};
  try {
    const checked = await handleMiguCanListen(list.map((s) => s.contentId).join(','), cookie);
    (checked.items || []).forEach((i) => { map[i.contentId] = i; });
  } catch (_) {
    // 校验接口失败时不猜：什么都不标，播放时仍会拿到真实的拒绝原因
    return list;
  }
  list.forEach((song) => {
    const hit = map[song.contentId];
    if (!hit) return;
    song.canListen = !!hit.canListen;
    song.trialLimited = !!hit.limitLength;
    if (song.canListen) return;
    // 复用渲染层既有的 VIP 标记判定（读 reason/category/message 里的 vip_required 等字样）
    song.reason = hit.limitLength ? 'vip_required' : 'copyright_unavailable';
    song.category = song.reason;
    song.message = hit.limitLength
      ? '咪咕该曲目需登录你自己的会员账号才能播放，免登录状态不可播。'
      : '咪咕该版本（Live / 综艺等）没有可播资源，换一条同名版本试试。';
  });
  return list;
}

async function handleMiguCanListen(contentIds, cookie) {
  const ids = String(contentIds || '').trim();
  if (!ids) return { provider: PROVIDER, items: [] };
  const json = await requestJson(MIGU_CAN_LISTEN_URL, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, miguHeadersWithCookie(cookie)),
    body: JSON.stringify({ contentIds: ids }),
  });
  const list = (json.data && json.data.canListenRespItemList) || [];
  return {
    provider: PROVIDER,
    items: list.map((x) => ({ contentId: String(x.contentId || ''), canListen: !!x.canListen, limitLength: !!x.limitLength })),
  };
}

/* ---------------- 歌词 ---------------- */

function stripMrcTags(text) {
  // MRC 是逐字卡拉OK时间戳；本播放器按行同步用，退化成普通 LRC 更稳
  return String(text || '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\d{2}:\d{2}\.\d{2,3}\]\{\{[^}]*\}\}/g, (m) => m.replace(/\{\{[^}]*\}\}/g, ''));
}

async function fetchMiguLyricText(target) {
  if (!isHttpsResource(target)) throw new Error('MIGU_UNSAFE_LYRIC_HOST');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { headers: { 'User-Agent': MIGU_SEARCH_HEADERS['User-Agent'] }, signal: controller.signal });
    if (!res.ok) throw new Error(`MIGU_LYRIC_HTTP_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function handleMiguLyric(params) {
  const p = params || {};
  const lyricUrl = String(p.lyricUrl || '').trim();
  const mrcUrl = String(p.mrcUrl || p.mrcurl || '').trim();
  const target = isHttpsResource(lyricUrl) ? lyricUrl : (isHttpsResource(mrcUrl) ? mrcUrl : '');
  if (!target) {
    return { provider: PROVIDER, lyric: '', trans: '', error: 'MISSING_LYRIC_URL', message: '该曲目未返回歌词地址' };
  }
  const raw = await fetchMiguLyricText(target);
  const isMrc = target === mrcUrl && /\{\{/.test(raw);
  return {
    provider: PROVIDER,
    lyric: isMrc ? stripMrcTags(raw) : raw,
    trans: '',
    source: isMrc ? 'mrc' : 'lrc',
  };
}

/* ---------------- 登录态 ---------------- */

async function getMiguLoginInfo(cookie) {
  const hasLogin = miguCookieHasLogin(cookie);
  return {
    provider: PROVIDER,
    // 字段名与其它源保持一致（前端读 loggedIn）
    loggedIn: hasLogin,
    // 未接咪咕用户信息接口：不伪造昵称/头像/VIP 等级，UI 据 verified=false 显示"已保存会话"
    nickname: hasLogin ? '咪咕会话' : '',
    avatar: '',
    userId: '',
    vipType: '',
    verified: false,
    source: hasLogin ? 'cookie' : 'none',
  };
}

module.exports = {
  PROVIDER,
  TIER_ORDER,
  handleMiguSearch,
  handleMiguSongUrl,
  handleMiguCanListen,
  annotateMiguSearchPlayability,
  handleMiguLyric,
  getMiguLoginInfo,
  mapMiguSearchItem,
  rememberMiguTiers,
  cachedMiguTiers,
  clearMiguSessionCaches,
  normalizeMiguCookieInput,
  miguCookieObject,
  miguCookieHasLogin,
  buildMiguRequestCookie,
  isHttpsResource,
  stripMrcTags,
};

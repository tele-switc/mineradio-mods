'use strict';

// ====================================================================
//  B 站（bilibili）适配层 —— 只做在线播放，不下载、不解密、不绕过会员限制
//
//  端点均于 2026-09-25 本机实测：
//   - 搜索  GET api.bilibili.com/x/web-interface/wbi/search/type   → code 0
//   - 详情  GET api.bilibili.com/x/web-interface/view              → code 0，拿 cid/时长
//   - 取流  GET api.bilibili.com/x/player/playurl (无 wbi 变体)     → code 0，DASH 音频流
//     注意：/x/player/wbi/playurl 在本机匿名请求下被 WAF 拦为 HTTP 412，
//     因此取流走未签名变体；需要更高档位时由用户自己的 SESSDATA 决定（登录后可带 cookie）。
//   - 音频流可 Range 分段（实测 206），但多数 CDN 节点校验 Referer，
//     故统一由 /api/audio 代理转发（见 server.js audioProxyHeadersFor 的 bilibili 分支）
//
//  2026-10-07 复探"能不能让 B 站只回音乐"，结论是不能，只能在本地过滤：
//   - `search_type=audio` 游客被拒 code=-1200「被降级过滤的请求」
//   - `tid` / `zone_id` 参数被完全忽略（带与不带返回体一模一样）
//   - `page_size` 认（30→30 行、50→50 行、页首接得上上一页页尾）→ 分页游标按原始条目走
//  过滤规则见下面 classifyBiliSearchResult 那一段。
// ====================================================================

const crypto = require('crypto');

const PROVIDER = 'bilibili';
const FETCH_TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl';

// WBI 下标置换表（B 站官方前端公开使用）
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let wbiKeyCache = { key: '', at: 0 };
const WBI_KEY_TTL_MS = 10 * 60 * 1000;

async function requestJson(target, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`BILI_HTTP_${res.status}`);
    if (!text.trim().startsWith('{')) throw new Error('BILI_RESPONSE_NOT_JSON');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function biliHeaders(cookie, referer) {
  const headers = { 'User-Agent': UA, Referer: referer || 'https://www.bilibili.com/' };
  const text = normalizeBiliCookieInput(cookie);
  if (text) headers.Cookie = text;
  return headers;
}

function normalizeBiliCookieInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return input.map(normalizeBiliCookieInput).filter(Boolean).join('; ');
  if (typeof input === 'object') return Object.keys(input).map((k) => `${k}=${input[k]}`).join('; ');
  return String(input);
}

function biliCookieObject(raw) {
  const out = {};
  normalizeBiliCookieInput(raw).split(/;\s*/).forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

// SESSDATA 是 B 站登录会话标志；大会员状态由 nav 接口的 vipLabel/vipType 反映
function biliCookieHasLogin(raw) {
  const obj = biliCookieObject(raw);
  return !!(obj.SESSDATA && obj.bili_jct);
}

function mixinKey(imgKey, subKey) {
  const combined = String(imgKey || '') + String(subKey || '');
  return MIXIN_TAB.map((i) => combined[i]).join('').slice(0, 32);
}

async function getWbiKey(cookie) {
  if (wbiKeyCache.key && Date.now() - wbiKeyCache.at < WBI_KEY_TTL_MS) return wbiKeyCache.key;
  const json = await requestJson(NAV_URL, { headers: biliHeaders(cookie) });
  const wbi = (json.data && json.data.wbi_img) || {};
  // 实测：B 站已把 sub_img_url 改名为 sub_url，两个都要认
  const imgKey = String(wbi.img_url || '').split('/').pop().split('.')[0];
  const subKey = String(wbi.sub_img_url || wbi.sub_url || '').split('/').pop().split('.')[0];
  const key = imgKey && subKey ? mixinKey(imgKey, subKey) : '';
  if (key) wbiKeyCache = { key, at: Date.now() };
  return key;
}

function signParams(params, key) {
  const clean = {};
  Object.keys(params).forEach((k) => {
    if (params[k] === undefined || params[k] === null || params[k] === '') return;
    clean[k] = String(params[k]).replace(/[!'()*]/g, '');
  });
  clean.wts = String(Math.floor(Date.now() / 1000));
  const sorted = Object.keys(clean).sort().map((k) => `${k}=${encodeURIComponent(clean[k])}`).join('&');
  clean.w_rid = crypto.createHash('md5').update(sorted + key).digest('hex');
  return Object.keys(clean).map((k) => `${k}=${encodeURIComponent(clean[k])}`).join('&');
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').trim();
}

function durationToSeconds(value) {
  // B 站搜索结果里 duration 是 "5:17" 或 "358:49"，view 接口是秒数
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text) || 0;
  return text.split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

function normalizeBiliUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // B 站 pic 常是协议相对地址 //i0.hdslb.com/...，直接判 startsWith('http') 会把它丢掉
  if (text.startsWith('//')) return 'https:' + text;
  return text.replace(/^http:\/\//i, 'https://');
}

// B 站分区判据（2026-10-03 实测：wbi/search/type 每条结果自带 typeid / typename，无需额外请求）：
//   音乐区子分区的名字都带"音乐/MV/翻唱/演奏/现场/歌曲/纯享/ALPHA/古风"这类字样，
//   非音乐分区是"影视综合/游戏/生活/二次元…"; 返回体里 tname 是空串，只有 typename 可用。
// 翻唱五唱单独认出来当二创处理——它确实是"别人唱的歌"，不能冒充原曲自动换源。
const BILI_MUSIC_CATEGORY_RE = /音乐|MV|翻唱|演奏|现场|歌曲|纯享|ALPHA|古风|国风|作曲|编曲|歌唱/;
const BILI_COVER_CATEGORY_RE = /翻唱|五唱|Cover/i;
function biliCategoryIsMusic(song) {
  const name = String((song && (song.categoryName || song.typename)) || '');
  return BILI_MUSIC_CATEGORY_RE.test(name);
}
function biliCategoryIsCover(song) {
  const name = String((song && (song.categoryName || song.typename)) || '');
  return BILI_COVER_CATEGORY_RE.test(name);
}
// 实测：搜索结果里的 `tag` 是**逗号分隔的字符串**（"高音质,晴天,耳机,HIFI,周杰伦"），
// `tags` 是空串；view/其他接口才给 [{tag_name}] 结构。三种形态都要吃，别只认一种。
function biliTagNames(item) {
  const raw = item && (item.tag != null ? item.tag : item.tags);
  if (raw == null) return [];
  if (typeof raw === 'string') return raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (entry == null) return '';
      if (typeof entry === 'string') return entry.trim();
      return String(entry.tag_name || entry.name || '').trim();
    }).filter(Boolean);
  }
  return [];
}

// ====================================================================
//  这条结果该不该出现在音乐结果里（2026-10-07 实测定口径）
//
//  为什么必须在本地过滤——B 站自己不给可用的"只看音乐"开关，本机实测：
//    - `search_type=audio` 游客身份被拒：code=-1200「被降级过滤的请求」，0 行
//    - `tid` / `zone_id` 参数被完全忽略：带与不带返回体一模一样（同 12 行同分区）
//    - `page_size` 是认的（30→30 行、50→50 行，页首能对上上一页页尾），
//      所以过滤后的分页游标可以按"原始条目"走，不会跳页也不会重复
//  污染量级（10 个常见查询 / 118 行）：43 行（36%）挂在非音乐分区，
//  另外搜"久石让"这类不带具体歌名的词时，前 4 行全是 1～4 小时的电台/演奏合集。
//
//  人工定的处理口径：硬噪声**剔除**；二创与长合集**保留但沉底并标注**（2026-10-07 确认）。
//  注意这里只管"是不是一段能听的这首歌"，不改 10-03 定好的自动换源采纳口径
//  （`biliAdoptDecision` 那套「只要是这首歌的某种声音就收」仍然照旧）。
// ====================================================================

// 剔除·分区：这些分区不可能"正在放这首歌"
const BILI_DROP_CATEGORY_RE = /乐评|盘点|音乐教程|舞蹈|宅舞|MMD|动画综合|特摄|影视杂谈|杂谈|解说|预告|资讯|数码|计算机|校园|课堂|说课|社科|法律|心理|健康|美食|手工|绘画|时尚|美妆|汽车|电子竞技|手机游戏|网络游戏|单机游戏|桌游|棋牌|小剧场|音游|体育|赛事/;
// 剔除·文本：无论挂在哪个分区，主体都是说话或照着谱学，不是放这首歌
const BILI_DROP_TEXT_RE = /教学(?!书)|教程|讲解|解析|乐评|盘点|赏析|鉴赏|测评|评测|开箱|采访|访谈|播客|连麦|反应视频|reaction|react视频|鼓谱|吉他谱|六线谱|简谱|琴谱|谱面|指法|买断谱|自制谱|课件|作业|百科|档案|资料卡/;
// 剔除·文本（仅在非音乐分区生效）：这些字样可能是歌名的一部分，不能一票否决
// 末尾那个孤零零的「舞」是有意的：挂在音乐区之外还写着"舞"的行，实测全是随舞/直拍/比赛切片
//（真实样本：「这是什么舞」「抖舞随舞」「近期最帅之舞！！」），而音乐区的《霓裳舞》不受影响。
const BILI_DROP_TEXT_IN_NONMUSIC_RE = /随舞|翻跳|编舞|燃脂舞|直拍|vlog|探店|实况|游戏解说|直播切片|osu|钢琴块|滚动的天空|全连|竞速|打歌|舞/;
// 合集/串烧：15 分钟以上不可能是一首歌；5 分钟以上再带"合集"字样也算
const BILI_LONG_MIX_SECONDS = 900;
const BILI_MIX_HINT_MIN_SECONDS = 300;
const BILI_MIX_HINT_RE = /合集|串烧|精选|纯享|曲单|歌单|循环|medley|\d+\s*首/;
// 是这首歌的"别的版本"——保留、沉底、标注（词表与前端 BILI_NOTED_RE 同一套口径）
const BILI_VERSION_TEXT_RE = /翻唱|翻自|五唱|cover|伴奏|纯音乐|instrumental|karaoke|k歌|无伴奏|指弹|尤克里里|古筝|二胡|琵琶|中阮|钢琴|小提琴|大提琴|笛子|口哨|口琴|改编|变奏|加速|放慢|sped|slowed|remix|混音|dj|铃声|彩铃|清唱|哼唱|影视|剪辑|混剪|bgm|ost|配乐|原声|主题曲|插曲|片头|片尾|现场|演唱会|\blive\b/;
// 大小写敏感：只认大写 AI，免得把 "rain" 之类的歌名卷进来
const BILI_AI_RE = /\bAI\b|VOCALOID|UTAU|声库|合成/;

// 相关性门槛（2026-10-07 实测补上）：分区与说话词都挡不住"B 站把完全不相干的行塞进结果里"——
// 搜「莫妮卡」给出「增加心跳声」「又可以大饱眼福了～」「寄生美女67《生化-危机》」，
// 搜「obi 舞」给出「农村脱衣舞表演泛滥」（还挂在 MV 分区）。
// 这些行连"是这首歌"都谈不上，只能直接问一句：你搜的词有没有出现在这条结果里。
// 中文按 2 字窗口比对有两个原因：繁简/写法差异（实测样本里有「坂本龍一」而查询是「坂本龙一」），
// 以及标题不写歌名而把信息放在标签里（实测「【Hi-Res】晴天 故事的小黄花 完整版」）。
// 整串相等会把这两种好结果一起杀掉，所以长中文串额外切窗口，任一窗口命中即算相关。
function biliQueryTokens(keyword) {
  const text = String(keyword || '').toLowerCase();
  const runs = text.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || [];
  const strong = [];
  const weak = [];
  runs.forEach((run) => {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) strong.push(run);
      return;
    }
    if (run.length >= 2) {
      strong.push(run);
      // 2 字窗口：兜繁简差异（实测样本里查询是「坂本龙一」，标题写「坂本龍一」）
      for (let i = 0; i + 2 <= run.length; i++) strong.push(run.slice(i, i + 2));
    } else {
      weak.push(run);
    }
  });
  return { strong, weak };
}

function biliQueryIsRelevant(keyword, song) {
  const { strong, weak } = biliQueryTokens(keyword);
  if (!strong.length && !weak.length) return true;   // 判不出来就不装作能判
  const hay = [
    song && song.name,
    song && song.artist,
    song && song.album,
    song && Array.isArray(song.tags) ? song.tags.join(' ') : '',
  ].join(' ').toLowerCase();
  if (!hay.trim()) return true;
  // 单词查询（"obi 舞"）里那个单字是弱信号：实测「农村脱衣舞表演泛滥」「眼势舞」就是靠一个"舞"字
  // 混进来的。所以有强 token 时只认强 token，一个强 token 都没有才退到单字。
  const tokens = strong.length ? strong : weak;
  return tokens.some((token) => hay.indexOf(token) >= 0);
}

// 返回 { drop, reason, tier, compilation }；tier 0=正常单曲，1=别的版本，2=合集/串烧
function classifyBiliSearchResult(song, keyword) {
  const out = { drop: false, reason: '', tier: 0, compilation: false };
  if (!song) return out;
  if (keyword && !biliQueryIsRelevant(keyword, song)) {
    out.drop = true; out.reason = 'off_query'; return out;
  }
  const category = String(song.categoryName || '');
  const rawText = [song.name || '', song.artist || '', song.album || '',
    Array.isArray(song.tags) ? song.tags.join(' ') : ''].join(' ');
  const low = rawText.toLowerCase();
  const nonMusic = song.musicCategory === false;
  if (BILI_DROP_CATEGORY_RE.test(category)) {
    out.drop = true; out.reason = 'drop_category:' + category; return out;
  }
  if (BILI_DROP_TEXT_RE.test(low) || BILI_DROP_TEXT_RE.test(category)) {
    out.drop = true; out.reason = 'drop_speech'; return out;
  }
  if (nonMusic && BILI_DROP_TEXT_IN_NONMUSIC_RE.test(low)) {
    out.drop = true; out.reason = 'drop_nonmusic'; return out;
  }
  const duration = Number(song.duration) || 0;
  const looksLikeMix = BILI_MIX_HINT_RE.test(low);
  if (duration >= BILI_LONG_MIX_SECONDS || (duration >= BILI_MIX_HINT_MIN_SECONDS && looksLikeMix)) {
    out.compilation = true;
    out.tier = 2;
    out.reason = 'long_mix';
    return out;
  }
  if (song.coverCategory || nonMusic || BILI_VERSION_TEXT_RE.test(low) || BILI_AI_RE.test(rawText)) {
    out.tier = 1;
    out.reason = nonMusic ? 'non_music_category' : 'derivative_version';
  }
  return out;
}

function mapBiliSearchItem(item) {
  item = item || {};
  const bvid = String(item.bvid || '').trim();
  const pic = normalizeBiliUrl(item.pic);
  const typename = String(item.typename || '').trim();
  const song = {
    provider: PROVIDER,
    source: PROVIDER,
    type: PROVIDER,
    id: bvid,
    bvid,
    aid: String(item.id || ''),
    cid: '',
    name: stripHtml(item.title),
    artist: stripHtml(item.author),
    artists: [{ id: String(item.mid || ''), name: stripHtml(item.author) }],
    cover: pic.startsWith('http') ? pic : '',
    // 搜索响应里的 duration 是字符串秒数形式；view 接口会回填精确秒数
    duration: durationToSeconds(item.duration),
    playCount: Number(item.play) || 0,
    // B 站没有官方同步歌词，这里如实标注而不是伪造
    hasLyric: false,
    isCollection: !!item.is_collection_display,
    // 分类与标签：分区名是"这是不是音乐"最可靠的现成字段，标签是"是不是这首"的第二证据
    typeid: String(item.typeid || ''),
    categoryName: typename,
    musicCategory: typename ? BILI_MUSIC_CATEGORY_RE.test(typename) : null,
    coverCategory: typename ? BILI_COVER_CATEGORY_RE.test(typename) : false,
    tags: biliTagNames(item),
    isPay: !!item.is_pay,
    likeCount: Number(item.like) || 0,
  };
  // 分类结果作为**中性字段**带出去（`versionTier` / `isCompilation`），
  // 前端排序只读这两个布尔/数值，不在通用评分里写平台分支——
  // tests/search-frontend-pagination.test.js 明确禁止 `scoreSongSearchResult` 里出现 provider 判断。
  const verdict = classifyBiliSearchResult(song);
  song.versionTier = verdict.tier;
  song.isCompilation = verdict.compilation;
  song.versionReason = verdict.reason;
  return song;
}

async function biliSearchPageRows(keyword, page, pageSize, cookie) {
  const baseParams = { search_type: 'video', keyword, page: String(page), page_size: String(pageSize) };
  let json = null;
  try {
    const key = await getWbiKey(cookie);
    const qs = key ? signParams(baseParams, key) : new URLSearchParams(baseParams).toString();
    json = await requestJson(`${SEARCH_URL}?${qs}`, { headers: biliHeaders(cookie, 'https://search.bilibili.com/') });
  } catch (_) {
    // WBI 不可用时退回未签名查询：实测该接口在无 w_rid 时同样返回 code 0
    json = await requestJson(`${SEARCH_URL}?${new URLSearchParams(baseParams).toString()}`, {
      headers: biliHeaders(cookie, 'https://search.bilibili.com/'),
    });
  }
  if (Number(json.code) !== 0) throw new Error(`BILI_SEARCH_${json.code}`);
  return ((json.data && json.data.result) || []);
}

// 过滤会吃掉行数，所以游标必须走在**原始条目**上，不能走在"过滤后第几条"上：
// 原先用 page_size=limit 再 slice，一旦本地过滤掉几条，nextOffset 就会短于真实消耗量，
// 下一页会把已经看过的条目重新端上来（重复）或者直接漏掉几条（跳页）。
// 现在：固定向 B 站取 RAW_PAGE_SIZE 条一页（实测认这个参数），按原始序号推进 cursor，
// 不够 size 就继续翻页，直到凑满或者上游没有更多。返回体带上 nextOffset/hasMore 给路由直接用。
const BILI_SEARCH_RAW_PAGE_SIZE = 30;
const BILI_SEARCH_MAX_RAW_PAGES = 6;

async function handleBiliSearch(keywords, limit, cookie, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return { songs: [], offset: 0, limit: 0, nextOffset: 0, hasMore: false, filteredCount: 0, scannedCount: 0 };
  const size = Math.max(1, Math.min(30, Number(limit) || 12));
  const start = Math.max(0, Number(offset) || 0);
  const raw = BILI_SEARCH_RAW_PAGE_SIZE;
  let cursor = start;
  const kept = [];
  let filteredCount = 0;
  let scannedCount = 0;
  let lastPageEnd = start;
  let lastPageFull = false;
  let upstreamDone = false;
  for (let guard = 0; guard < BILI_SEARCH_MAX_RAW_PAGES && kept.length < size && !upstreamDone; guard++) {
    const page = Math.floor(cursor / raw) + 1;
    let rows;
    try {
      rows = await biliSearchPageRows(kw, page, raw, cookie);
    } catch (err) {
      // 第一页就失败要照旧抛出（调用方靠这个错误码提示"这家用不了"）；
      // 已经凑到东西了才失败，就把手上的结果如实交付，并把 hasMore 关成 false
      if (!kept.length) throw err;
      upstreamDone = true;
      break;
    }
    if (!rows.length) { upstreamDone = true; break; }
    lastPageEnd = (page - 1) * raw + rows.length;
    lastPageFull = rows.length >= raw;
    for (let i = cursor - (page - 1) * raw; i < rows.length && kept.length < size; i++, cursor++) {
      scannedCount++;
      const song = mapBiliSearchItem(rows[i]);
      if (!song.bvid) continue;
      // 带关键词再判一次：分区/说话词判不出的"跟这首歌无关"要靠相关性门槛
      const verdict = classifyBiliSearchResult(song, kw);
      if (verdict.drop) { filteredCount++; continue; }
      kept.push(song);
    }
    if (!lastPageFull) upstreamDone = true;
  }
  const hasMore = upstreamDone ? false : (cursor < lastPageEnd || lastPageFull);
  return {
    songs: kept,
    offset: start,
    limit: size,
    nextOffset: cursor,
    hasMore,
    filteredCount,
    scannedCount,
  };
}

async function handleBiliView(bvid, cookie) {
  const id = String(bvid || '').trim();
  if (!id) throw new Error('MISSING_BVID');
  const json = await requestJson(`${VIEW_URL}?bvid=${encodeURIComponent(id)}`, { headers: biliHeaders(cookie) });
  if (Number(json.code) !== 0) throw new Error(`BILI_VIEW_${json.code}`);
  const d = json.data || {};
  // 分 P 合集：pages[] 每一段都有自己的 cid 与分标题（实测 view 接口不需要 WBI 签名）。
  // 一段就是一条可播条目，必须带着自己的 cid 往下传，否则所有分段都会播成第一 P。
  const parts = (Array.isArray(d.pages) ? d.pages : []).map((page, index) => ({
    cid: String(page.cid || ''),
    part: stripHtml(page.part || '') || `P${index + 1}`,
    duration: Number(page.duration) || 0,
    index: Number(page.page) || index + 1,
  })).filter((page) => page.cid);
  const season = d.ugc_season && Array.isArray(d.ugc_season.sections)
    ? d.ugc_season.sections.reduce((acc, section) => acc.concat(Array.isArray(section.episodes) ? section.episodes : []), [])
    : [];
  // 合集（ugc_season）是"另一个列表"：每集自带 bvid，不能当成当前视频的分段来播，
  // 所以要单独给出各自的 bvid；cid 留空由取址接口按 bvid 自己解析。
  const seasonEpisodes = season.map((ep, index) => ({
    bvid: String((ep && ep.bvid) || ''),
    aid: String((ep && ep.aid) || ''),
    cid: '',
    part: stripHtml((ep && (ep.arc_scene && ep.arc_scene.title ? ep.arc_scene.title : ep.title)) || '') || `第 ${index + 1} 集`,
    duration: Number(ep && ep.duration && typeof ep.duration === 'object' ? ep.duration.length_seconds : ep && ep.duration) || 0,
    index: index + 1,
  })).filter((ep) => ep.bvid);
  return {
    bvid: d.bvid || id,
    aid: String(d.aid || ''),
    cid: String(d.cid || ''),
    name: stripHtml(d.title),
    artist: stripHtml((d.owner && d.owner.name) || ''),
    duration: Number(d.duration) || 0,
    cover: normalizeBiliUrl(d.pic),
    partCount: parts.length || (Array.isArray(d.pages) ? d.pages.length : 1),
    parts,
    seasonCount: seasonEpisodes.length,
    seasonTitle: seasonEpisodes.length ? stripHtml((d.ugc_season && d.ugc_season.title) || '') : '',
    seasonEpisodes,
  };
}

// 音频流按 bandwidth 从高到低取，档位语义不臆造：标签只用实测可得的码率
function pickBestAudio(dash) {
  const list = []
    .concat(dash.dolby && dash.dolby.audio ? [dash.dolby.audio] : [])
    .concat(dash.flac && dash.flac.audio ? [dash.flac.audio] : [])
    .concat(Array.isArray(dash.audio) ? dash.audio : []);
  if (!list.length) return null;
  return list.slice().sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
}

function audioQualityLabel(stream) {
  const kbps = Math.round((Number(stream.bandwidth) || 0) / 1000);
  return `音频流 ${stream.id} · ${kbps}kbps`;
}

async function handleBiliSongUrl(params, cookie) {
  const p = params || {};
  let bvid = String(p.bvid || p.id || '').trim();
  let cid = String(p.cid || '').trim();
  if (!bvid) {
    return { provider: PROVIDER, url: '', playable: false, error: 'MISSING_BVID', message: '缺少 B 站 bvid' };
  }
  if (!cid) {
    try {
      const info = await handleBiliView(bvid, cookie);
      cid = info.cid;
    } catch (err) {
      return { provider: PROVIDER, url: '', playable: false, error: 'BILI_CID_FAILED', message: err.message };
    }
  }
  if (!cid) {
    return { provider: PROVIDER, url: '', playable: false, error: 'MISSING_CID', message: '该视频没有可用分P' };
  }
  // 实测：未签名的 /x/player/playurl 返回 code 0；wbi 变体在本机匿名下被 WAF 拦 412
  const query = new URLSearchParams({ bvid, cid, fnval: '4048', fnver: '0', fourk: '1' });
  const json = await requestJson(`${PLAYURL_URL}?${query.toString()}`, {
    headers: biliHeaders(cookie, `https://www.bilibili.com/video/${bvid}/`),
  });
  if (Number(json.code) !== 0) {
    return { provider: PROVIDER, url: '', playable: false, error: `BILI_PLAYURL_${json.code}`, message: json.message || '' };
  }
  const data = json.data || {};
  const dash = data.dash;
  if (dash) {
    const audio = pickBestAudio(dash);
    const url = audio ? (audio.baseUrl || audio.base_url || '') : '';
    if (url) {
      return {
        provider: PROVIDER,
        url,
        playable: true,
        quality: String(audio.id),
        qualityLabel: audioQualityLabel(audio),
        bandwidth: Number(audio.bandwidth) || 0,
        codecs: String(audio.codecs || ''),
        bvid,
        cid,
        // B 站音频直链多数节点校验 Referer，需经本地 /api/audio 代理转发
        needsReferer: true,
      };
    }
  }
  const durl = Array.isArray(data.durl) ? data.durl : [];
  if (durl.length && durl[0].url) {
    return {
      provider: PROVIDER,
      url: durl[0].url,
      playable: true,
      quality: 'mp4',
      qualityLabel: '合并流（无独立音频）',
      sizeBytes: Number(durl[0].size) || 0,
      bvid,
      cid,
      needsReferer: true,
    };
  }
  return {
    provider: PROVIDER,
    url: '',
    playable: false,
    error: 'BILI_NO_STREAM',
    requiresLogin: !biliCookieHasLogin(cookie),
    message: 'B 站未返回可播流（可能是会员专享或区域限制）。',
    bvid,
    cid,
  };
}

async function getBiliLoginInfo(cookie) {
  const hasLogin = biliCookieHasLogin(cookie);
  if (!hasLogin) {
    return { provider: PROVIDER, loggedIn: false, nickname: '', avatar: '', vipType: '', verified: false, source: 'none' };
  }
  try {
    const json = await requestJson(NAV_URL, { headers: biliHeaders(cookie) });
    const d = json.data || {};
    return {
      provider: PROVIDER,
      loggedIn: !!d.isLogin,
      nickname: String(d.uname || ''),
      avatar: String(d.face || ''),
      userId: String(d.mid || ''),
      vipType: String((d.vip && d.vip.vipDesc) || (d.vip_label && d.vip_label.name) || ''),
      // nav 直接给出会员状态，这里标记为已核验
      verified: !!d.isLogin,
      source: 'nav',
    };
  } catch (_) {
    return { provider: PROVIDER, loggedIn: true, nickname: '', avatar: '', vipType: '', verified: false, source: 'cookie' };
  }
}

function clearBiliSessionCaches() {
  wbiKeyCache = { key: '', at: 0 };
}

module.exports = {
  PROVIDER,
  handleBiliSearch,
  handleBiliView,
  handleBiliSongUrl,
  getBiliLoginInfo,
  mapBiliSearchItem,
  biliCategoryIsMusic,
  biliCategoryIsCover,
  classifyBiliSearchResult,
  biliQueryIsRelevant,
  biliQueryTokens,
  durationToSeconds,
  pickBestAudio,
  normalizeBiliCookieInput,
  biliCookieObject,
  biliCookieHasLogin,
  clearBiliSessionCaches,
  _test: { mixinKey, signParams },
};

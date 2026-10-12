// ============================================================
//  自动换源（播放取不到地址时，自己去找同一首歌的另一个源）—— mineradio-mods 外挂版
//
//  这是开发仓库 `public/js/modules/05-playback/11-provider-fallback.js` 的那一份，
//  以**外挂模块**的形式重新声明同名全局函数来生效（外挂模块在所有上游模块之后执行，
//  同一个 script 里的顶层 function/var 就是 window 上的那份）。
//  不去整份替换上游那个文件：安装器对"投放到上游路径"只会删文件、不会还原，
//  换掉上游文件等于把 uninstall 的"逐字节回到原版"毁掉。
//
//  代价说清楚：这一族是**整模块接管**，上游哪天改了这条链，我们这份会安静地赢过它。
//  `--verify` 看不出来（锚点与投放文件都对），看得出来的方式只有真跑（tools/live-check.mjs
//  最后那几条换源断言）。
//
//  与开发版的差别只有一处：**咪咕不在包里**（它要会话），所以
//   - 免登录池子里去掉 migu，只剩 netease + bilibili；
//   - 搜索端点表里也去掉 migu（留着就是指向一个不存在的路由）。
//  "有咪咕会话就把它提到链首"那两段逻辑保留但永远不触发，等咪咕那一族搬进来就接上。
//
//  internetarchive / radioparadise **不参与自动换源**（开发版同一口径）：这两个没有
//  "同名同歌手同一录音"的可靠判据（archive.org 靠人工元数据、RP 是直播流），
//  自动接管会播错内容，比不播更糟；它们只保留手动搜索入口。
//
//  下面这几条 B 站采纳口径是从开发仓库 `00-api-quality-output.js` 搬来的，
//  一起搬的原因：换源与音质档位用的是同一套判据，两份实现迟早漂移。
// ============================================================

// 游客（不登录、不下载、不解密、不绕过会员专享）就能拿到播放地址的源。
// 顺序按"命中的是不是原曲"排：网易云走严格同名同歌手判据，命中就是原曲（实测只有 128kbps）；
// B 站走放宽判据，实测 171–319kbps 更高，但命中的是搬运/重制。
var PLAYBACK_GUEST_ACCESSIBLE_PROVIDERS = ['netease', 'bilibili'];
// 搜索结果的 artist 字段是上传者、歌名与歌手都写在装饰标题里的源（目前只有 B 站）。
var PLAYBACK_DECORATED_TITLE_PROVIDERS = ['bilibili'];
// B 站采纳口径（2026-10-03 人工两轮放宽后的定版）：只要是这首歌的某种声音就收 ——
// 影视剪辑 BGM/OST、翻唱、器乐改编、伴奏/纯音乐/karaoke、变速/DJ/remix、铃声彩铃片段、清唱，
// 收了就在提示里写明是哪一种。唯一仍然硬拒的是"主体是说话不是放这首歌"：教学/教程/讲解/反应视频/测评。
var BILI_HARD_REJECT_RE = /教学|教程|讲解|反应视频|reaction|react视频|测评|开箱|赏析|盘点|集锦介绍/;
var BILI_NOTED_RE = /翻唱|翻自|cover|伴奏|纯音乐|instrumental|karaoke|k歌|无伴奏|指弹|尤克里里|古筝|二胡|琵琶|中阮|钢琴|小提琴|大提琴|笛子|口哨|口琴|改编|变奏|现场|live|影视|剪辑|混剪|bgm|ost|配乐|原声|主题曲|插曲|片头|片尾|加速|放慢|sped|slowed|remix|混音|dj|铃声|彩铃|清唱|哼唱/;
var BILI_NOTE_LABELS = [
  [/教学|教程|讲解/, ''],
  [/翻唱|翻自|cover|五唱/i, '翻唱版本'],
  [/伴奏|纯音乐|instrumental|karaoke|k歌|无伴奏/, '伴奏/纯音乐版'],
  [/指弹|尤克里里|古筝|二胡|琵琶|中阮|钢琴|小提琴|大提琴|笛子|口哨|口琴|改编|变奏/, '器乐改编'],
  [/加速|放慢|sped|slowed/i, '变速版'],
  [/dj|remix|混音/i, '混音/DJ 版'],
  [/铃声|彩铃/, '片段版本'],
  [/清唱|哼唱/, '清唱版本'],
  [/影视|剪辑|混剪|bgm|ost|配乐|原声|主题曲|插曲|片头|片尾/i, '影视配乐版本'],
  [/现场|live/i, '现场版本'],
];
// '' = 就按原唱那条路走；'noted' = 收，但要写明是哪一种；'reject' = 主体是说话，不是放歌
function biliAdoptDecision(candidate) {
  if (!candidate) return '';
  var text = String([
    candidate.name || candidate.title || '',
    candidate.artist || '',
    candidate.album || '',
    candidate.categoryName || '',
    Array.isArray(candidate.tags) ? candidate.tags.join(' ') : ''
  ].join(' ').toLowerCase());
  if (BILI_HARD_REJECT_RE.test(text)) return 'reject';
  if (candidate.coverCategory) return 'noted';
  if (candidate.musicCategory === false) {
    // 非音乐分区不是一票否决：调用方已经要求"标题含歌名 + 歌手证据 + 时长像样"，
    // 能过那三关的日常生活区视频基本就是在放这首歌（实测"晴天高潮部分"挂在日常区）
    return 'noted';
  }
  if (BILI_NOTED_RE.test(text)) return 'noted';
  return '';
}
function biliAdoptNoteText(candidate) {
  var decision = biliAdoptDecision(candidate);
  if (decision !== 'noted') return '';
  var text = String([
    candidate && (candidate.name || candidate.title),
    Array.isArray(candidate && candidate.tags) ? candidate.tags.join(' ') : '',
    candidate && candidate.artist,
    candidate && candidate.categoryName
  ].join(' ').toLowerCase());
  for (var i = 0; i < BILI_NOTE_LABELS.length; i++) {
    if (BILI_NOTE_LABELS[i][0].test(text)) return BILI_NOTE_LABELS[i][1];
  }
  return String((candidate && candidate.categoryName) || '').trim() || '非原唱版本';
}

// firstPlayDone 由上游那份声明（外挂这边再 `var = false` 一次是多余的重置），这里不写。
function playbackProviderLabel(song) {
  var provider = songProviderKey(song);
  if (provider === 'qq') return 'QQ 音乐';
  if (provider === 'kugou') return '酷狗音乐';
  if (provider === 'qishui') return '汽水音乐';
  if (provider === 'migu') return '咪咕音乐';
  if (provider === 'bilibili') return 'B 站';
  if (provider === 'internetarchive') return 'Internet Archive';
  if (provider === 'radioparadise') return 'Radio Paradise';
  if (provider === 'spotify') return 'Spotify';
  return '网易云';
}
function playbackLoginProvider(song) {
  return normalizePlaybackProvider(songProviderKey(song));
}
function playbackRestrictionRawCategory(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  return data.reason || data.category || data.errorCategory || restriction.category || restriction.reason || '';
}
function playbackRestrictionLooksVipLocked(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  if (typeof songRequiresVip === 'function' && songRequiresVip(Object.assign({}, song || {}, data || {}))) return true;
  if (data.trial || data.needVip || data.need_vip || data.vipRequired || data.onlyVipPlayable || data.only_vip_playable) return true;
  var text = [
    data.error,
    data.message,
    data.reason,
    data.category,
    restriction.category,
    restriction.reason,
    restriction.message,
    data.rawMessage,
    restriction.rawMessage
  ].map(function (value) { return String(value || '').toLowerCase(); }).join(' ');
  return /vip_required|paid_required|trial_only|need_vip|only_vip|member|vip|会员|付费|购买|数字专辑|专辑/.test(text);
}
function playbackRestrictionMissingPlaybackKey(data) {
  data = data || {};
  var restriction = data.restriction || {};
  return !!(data.missingPlaybackKey || restriction.missingPlaybackKey);
}
function playbackRestrictionCategory(song, data) {
  var category = playbackRestrictionRawCategory(song, data);
  var provider = playbackLoginProvider(song);
  var status = platformStatus(provider) || {};
  var mergedStatus = Object.assign({}, status, data || {}, data && data.restriction || {});
  var loggedIn = !!(status.loggedIn || data && data.loggedIn);
  var vipLevel = typeof providerVipLevel === 'function' ? providerVipLevel(provider, mergedStatus) : 'none';
  var membershipUnknown = !!(
    provider === 'qq'
    && loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  );
  var vipLocked = playbackRestrictionLooksVipLocked(song, data);
  if (vipLocked && !playbackRestrictionMissingPlaybackKey(data)) {
    if (category === 'login_required' && loggedIn && vipLevel === 'none' && !membershipUnknown) return 'vip_required';
    if (!category || category === 'url_unavailable' || category === 'copyright_unavailable') {
      if (loggedIn && vipLevel === 'none' && !membershipUnknown) return 'vip_required';
    }
  }
  if (!category && data && data.error && /401|403|login_required|auth|cookie|credential|unauthorized|forbidden/i.test(String(data.error))) return loggedIn && vipLocked ? 'vip_required' : 'login_required';
  if (!category && data && data.error && /vip|member|paid|trial|会员|付费|购买/i.test(String(data.error))) return loggedIn ? 'vip_required' : 'login_required';
  return category || 'url_unavailable';
}
function playbackProviderMembershipText(provider, data) {
  var status = platformStatus(provider) || {};
  var mergedStatus = Object.assign({}, status, data || {}, data && data.restriction || {});
  var level = typeof providerVipLevel === 'function' ? providerVipLevel(provider, mergedStatus) : 'none';
  if (level === 'svip') return 'SVIP';
  if (level === 'vip') return provider === 'spotify' ? 'Premium' : 'VIP';
  if (
    provider === 'qq'
    && status.loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  ) return '会员待同步';
  return '普通账号';
}
function playbackRestrictionNotice(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  var category = playbackRestrictionCategory(song, data);
  var provider = playbackProviderLabel(song);
  var providerKey = playbackLoginProvider(song);
  var status = platformStatus(providerKey) || {};
  var loggedIn = !!(status.loggedIn || data.loggedIn);
  var membershipPending = !!(
    providerKey === 'qq'
    && loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  );
  var membership = playbackProviderMembershipText(providerKey, data);
  var message = data.message || restriction.message || '';
  if (category === 'vip_required' || category === 'paid_required' || category === 'trial_only') {
    var needText = category === 'paid_required' ? '购买、数字专辑或更高权限' : (category === 'trial_only' ? '完整播放权限' : '会员权限');
    var title = membershipPending ? 'QQ 会员状态待同步' : (loggedIn ? '当前平台没有会员状态' : '当前平台未登录会员');
    var body = message || (provider + ' 已识别为会员/付费曲目，当前状态是 ' + membership + '，缺少' + needText + '。');
    if (loggedIn && body.indexOf('当前状态') < 0) body += ' 当前状态是 ' + membership + '。';
    return { category: category, title: title, body: body + ' 可以登录会员账号、降低音质或切换到其它音源。', action: 'upgrade', toast: title };
  }
  if (category === 'login_required') {
    if (loggedIn && playbackRestrictionMissingPlaybackKey(data)) {
      return {
        category: category,
        title: '平台播放授权未完成',
        body: message || (provider + ' 已登录，但还缺少播放授权，请重新打开官方登录窗口完成授权。'),
        action: 'login',
        toast: '播放授权未完成'
      };
    }
    return {
      category: category,
      title: '当前平台未登录',
      body: (message || (provider + ' 需要登录后才能获取播放地址。')) + ' 正在打开对应登录入口。',
      action: 'login',
      toast: '当前平台未登录'
    };
  }
  if (category === 'provider_limited') {
    return {
      category: category,
      title: '平台仅作为匹配源',
      body: message || (provider + ' 当前只提供搜索/匹配信息，播放会自动寻找其它可播版本。'),
      action: 'switch_source',
      toast: '正在自动换源'
    };
  }
  if (category === 'copyright_unavailable') {
    return {
      category: category,
      title: '当前平台版权不可播',
      body: (message || (provider + ' 当前版权暂不可播。')) + ' 可以换一个平台版本。',
      action: 'switch_source',
      toast: '版权不可播'
    };
  }
  return {
    category: category,
    title: '当前平台没有可用音源',
    body: (message || (provider + ' 没有返回可播放地址。')) + ' 可能是版权、地区、会员或网络限制，可以换源或稍后重试。',
    action: 'switch_source',
    toast: '当前平台没有可用音源'
  };
}
function playbackRestrictionMessage(song, data) {
  var notice = playbackRestrictionNotice(song, data);
  return notice.body || notice.title;
  data = data || {};
  var restriction = data.restriction || {};
  var category = data.reason || restriction.category || '';
  var provider = playbackProviderLabel(song);
  var message = data.message || restriction.message || '';
  if (!message) {
    if (category === 'login_required') message = provider + '需要登录后再尝试播放';
    else if (category === 'vip_required') message = provider + '歌曲需要会员权限';
    else if (category === 'paid_required') message = provider + '歌曲需要购买或更高权限';
    else if (category === 'trial_only') message = provider + '仅返回试听片段';
    else if (category === 'copyright_unavailable') message = provider + '版权暂不可播';
    else if (category === 'provider_limited') message = provider + '当前只作为匹配源，正在寻找其它可播版本';
    else message = provider + '没有返回可播放地址';
  }
  if (category === 'login_required') return message + ' · 正在打开登录';
  if (category === 'provider_limited') return message + ' · 可以自动换源';
  if (category === 'copyright_unavailable' || category === 'url_unavailable') return message + ' · 可以试试另一个平台版本';
  return message;
}
function qqPlaybackRetryQualities(requestedQuality, resolvedLevel) {
  requestedQuality = normalizePlaybackQualityForProvider(requestedQuality || getProviderPlaybackQuality('qq'), 'qq');
  resolvedLevel = String(resolvedLevel || '').toLowerCase();
  var pool = [];
  if (requestedQuality === 'jymaster' || requestedQuality === 'hires' || requestedQuality === 'lossless' || resolvedLevel === 'hires' || resolvedLevel === 'lossless') {
    pool = ['exhigh', 'standard'];
  } else if (requestedQuality === 'exhigh' || resolvedLevel === 'exhigh') {
    pool = ['standard'];
  }
  return pool.filter(function (q) { return q !== requestedQuality; });
}
async function retryQQPlaybackWithCompatibleQuality(song, idx, token, opts, data, requestedQuality) {
  opts = opts || {};
  if (playbackRestrictionCategory(song, data) === 'login_required' || playbackRestrictionMissingPlaybackKey(data)) return false;
  var tried = Array.isArray(opts.qqQualityTried) ? opts.qqQualityTried.slice() : [];
  [requestedQuality, data && data.level].forEach(function (q) {
    q = normalizePlaybackQuality(q || '');
    if (q && tried.indexOf(q) < 0) tried.push(q);
  });
  var candidates = qqPlaybackRetryQualities(requestedQuality, data && data.level).filter(function (q) { return tried.indexOf(q) < 0; });
  if (!candidates.length || token !== trackSwitchToken) return false;
  var nextQuality = candidates[0];
  var resolvedQuality = normalizePlaybackQuality(data && data.level);
  markPlaybackQualityRuntimeCap(song, 'qq', nextQuality, 'qq-url-unavailable');
  if (!opts.startupAutoplay) showSourceFallbackNotice('QQ 音质自动兼容', '当前音质启动失败，正在切到 ' + playbackQualityLabel(nextQuality, 'qq') + '。');
  var retryResumeAt = opts.resumeAt;
  if (retryResumeAt == null && opts.startupAutoplay && pendingPlaybackResumeAt > 0) retryResumeAt = pendingPlaybackResumeAt;
  var retryStarted = await playQueueAt(idx, Object.assign({}, opts, {
    qualityOverride: nextQuality,
    qqQualityTried: tried,
    resumeAt: retryResumeAt,
  }));
  return retryStarted === true;
}
var sourceFallbackNoticeTimer = null;
function closeSourceFallbackNotice() {
  var notice = document.getElementById('source-fallback-notice');
  if (sourceFallbackNoticeTimer) { clearTimeout(sourceFallbackNoticeTimer); sourceFallbackNoticeTimer = null; }
  if (notice) notice.classList.remove('show');
  var stack = document.getElementById('source-fallback-stack');
  if (stack) Array.prototype.slice.call(stack.children || []).forEach(removeSourceFallbackCard);
}
function ensureSourceFallbackStack() {
  var stack = document.getElementById('source-fallback-stack');
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = 'source-fallback-stack';
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}
function removeSourceFallbackCard(card) {
  if (!card) return;
  card.classList.add('leaving');
  setTimeout(function () {
    if (card.parentNode) card.parentNode.removeChild(card);
  }, 260);
}
function showSourceFallbackNotice(title, body) {
  var stack = ensureSourceFallbackStack();
  if (stack) {
    var card = document.createElement('div');
    card.className = 'source-fallback-card';
    var head = document.createElement('div');
    head.className = 'source-fallback-head';
    var titleElNew = document.createElement('div');
    titleElNew.className = 'source-fallback-title';
    titleElNew.textContent = title || '自动换源';
    var close = document.createElement('button');
    close.className = 'source-fallback-close';
    close.type = 'button';
    close.textContent = '×';
    close.onclick = function () { removeSourceFallbackCard(card); };
    var bodyElNew = document.createElement('div');
    bodyElNew.className = 'source-fallback-body';
    bodyElNew.textContent = body || '';
    head.appendChild(titleElNew);
    head.appendChild(close);
    card.appendChild(head);
    card.appendChild(bodyElNew);
    stack.insertBefore(card, stack.firstChild || null);
    while (stack.children.length > 4) removeSourceFallbackCard(stack.lastElementChild);
    requestAnimationFrame(function () { card.classList.add('show'); });
    setTimeout(function () { removeSourceFallbackCard(card); }, 5600);
    return;
  }
  var notice = document.getElementById('source-fallback-notice');
  var titleEl = document.getElementById('source-fallback-title');
  var bodyEl = document.getElementById('source-fallback-body');
  if (!notice || !titleEl || !bodyEl) return;
  titleEl.textContent = title || '自动换源';
  bodyEl.textContent = body || '';
  notice.classList.add('show');
  if (sourceFallbackNoticeTimer) clearTimeout(sourceFallbackNoticeTimer);
  sourceFallbackNoticeTimer = setTimeout(closeSourceFallbackNotice, 5000);
}
function normalizeMatchText(text) {
  return String(text || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|]+/g, '');
}
function artistNameParts(song) {
  var parts = [];
  if (song && Array.isArray(song.artists)) {
    song.artists.forEach(function (a) { if (a && a.name) parts.push(a.name); });
  }
  if (song && song.artist) {
    String(song.artist).split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i).forEach(function (name) {
      if (name && name.trim()) parts.push(name.trim());
    });
  }
  return parts.map(normalizeMatchText).filter(Boolean);
}
function isSameTitleArtist(source, candidate) {
  if (!source || !candidate) return false;
  if (normalizeMatchText(source.name || source.title) !== normalizeMatchText(candidate.name || candidate.title)) return false;
  var a = artistNameParts(source);
  var b = artistNameParts(candidate);
  if (!a.length || !b.length) return false;
  return a.some(function (name) { return b.indexOf(name) >= 0; });
}
var SOURCE_FALLBACK_SEARCH_TIMEOUT_MS = 6500;
var SOURCE_FALLBACK_DIRECT_PROVIDERS = ['netease', 'qq', 'kugou'];
// 账号源：只有登录并且后端确认拿到播放密钥才允许接管播放。
// QQ/酷狗对游客身份根本不下发 vkey（实测返回 `purl === ''`），未登录时把它们放进链条里只会白跑一趟。
var SOURCE_FALLBACK_ACCOUNT_PROVIDERS = ['qq', 'kugou', 'qishui'];
// 免登录公共源：只使用各平台官方网页接口对游客开放的部分，与 Listen 1 的思路一致——
// 不下载、不解密、不绕过会员专享，取不到就如实失败。
// 名单与排序理由见文件开头那份 PLAYBACK_GUEST_ACCESSIBLE_PROVIDERS 的注释。
var SOURCE_FALLBACK_PUBLIC_PROVIDERS = typeof PLAYBACK_GUEST_ACCESSIBLE_PROVIDERS !== 'undefined'
  ? PLAYBACK_GUEST_ACCESSIBLE_PROVIDERS
  : ['netease', 'bilibili'];
// 开发版这里还有一句"本机有咪咕会话就把咪咕提到最前"（咪咕同一首能给 SQ 无损）。
// 包里暂时没搬咪咕，所以这段先不接：留着它会去问 `platformStatus('migu')`，
// 而上游那个函数对不认识的源会**回落到网易云的状态对象** —— 查了就等于
// 把"网易云已登录"当成"咪咕已授权"。咪咕搬进来时连同那两段一起接回。
function sourceFallbackPublicProviders() {
  return (SOURCE_FALLBACK_PUBLIC_PROVIDERS || []).slice();
}
// 不参与自动换源：这两个没有"同名同歌手同一录音"的可靠判据（archive.org 靠人工元数据、RP 是直播流），
// 自动接管会播错内容，比不播更糟；它们只保留手动搜索入口。
var SOURCE_FALLBACK_AUTO_EXCLUDED_PROVIDERS = ['internetarchive', 'radioparadise', 'spotify'];
var SOURCE_FALLBACK_SEARCH_ENDPOINTS = {
  netease: '/api/search',
  qq: '/api/qq/search',
  kugou: '/api/kugou/search',
  qishui: '/api/qishui/search',
  bilibili: '/api/bilibili/search'
};
var SOURCE_FALLBACK_SEARCH_LIMITS = { netease: 12, qq: 8, kugou: 8, qishui: 8, bilibili: 12 };
// B 站搜索结果的 artist 字段是上传者而不是歌手，歌名与歌手都写在装饰过的标题里，
// 严格等值匹配永远命不中，只能给它单独一档判据（名单同样在 00-api-quality-output.js）。
var SOURCE_FALLBACK_DECORATED_TITLE_PROVIDERS = typeof PLAYBACK_DECORATED_TITLE_PROVIDERS !== 'undefined'
  ? PLAYBACK_DECORATED_TITLE_PROVIDERS
  : ['bilibili'];
var SOURCE_FALLBACK_DURATION_TOLERANCE_MS = 15000;
// 放宽档不要求"接近原曲"，只卡两头（2026-10-03 人工定：铃声彩铃也算能听的素材）：
// 上限 = 原曲 + 15s，超了就是串烧/整碟；下限 10s，再短的是口播、预告、半个音符的梗。
// 实测样例：19s《晴天》前奏铃声收；62s "晴天高潮部分"收；40 分钟的串烧不收。
var SOURCE_FALLBACK_MIN_CLIP_MS = 10000;
var SOURCE_FALLBACK_RECOVERY_TIMEOUT_MS = 20000;
var SOURCE_FALLBACK_MAX_QUEUE_ADVANCES = 2;
var SOURCE_FALLBACK_MAX_PROVIDER_ATTEMPTS = 4;
// 20s / 4 次这两个上限是被 quick-check 钉住的既有约束，实测够用：
// 完整走一遍免登录道（B 站搜索 2.6s + 取址 3.9s，咪咕搜索 4.1s + 取址 1.6s）约 12s，
// 加上网易云（搜索 1.7s + 取址 ~2s）仍在预算内，所以扩池不需要放宽预算。
var sourceFallbackRecoverySerial = 0;
var activeSourceFallbackRecovery = null;
var sourceFallbackBudgetTimeoutResult = {};

function sourceFallbackRecoveryContentKey(song) {
  if (!song) return '';
  var title = normalizeMatchText(song.name || song.title || '');
  var artists = artistNameParts(song).sort().join(',');
  if (title && artists) return title + '|' + artists;
  return sourceFallbackSongKey(song);
}
function sourceFallbackRecoveryFromOptions(opts) {
  if (!opts) return null;
  return opts.sourceFallbackRecovery
    || (opts.playbackOpts && opts.playbackOpts.sourceFallbackRecovery)
    || null;
}
function sourceFallbackRecoveryIdentityActive(recovery) {
  return !!(
    recovery
    && activeSourceFallbackRecovery === recovery
    && !recovery.terminal
    && !recovery.cancelled
    && !recovery.completed
  );
}
function sourceFallbackRecoveryRemainingMs(recovery) {
  if (!sourceFallbackRecoveryIdentityActive(recovery)) return 0;
  return Math.max(0, Number(recovery.deadlineAt) - Date.now());
}
function sourceFallbackRecoveryCanContinue(recovery) {
  return sourceFallbackRecoveryRemainingMs(recovery) > 0;
}
function cancelSourceFallbackRecovery(reason) {
  var recovery = activeSourceFallbackRecovery;
  if (!recovery || recovery.terminal || recovery.completed) return false;
  recovery.cancelled = true;
  recovery.cancelReason = String(reason || 'superseded');
  activeSourceFallbackRecovery = null;
  return true;
}
function completeSourceFallbackRecovery(recovery) {
  if (!recovery || recovery.terminal || recovery.cancelled) return false;
  recovery.completed = true;
  if (activeSourceFallbackRecovery === recovery) activeSourceFallbackRecovery = null;
  return true;
}
function beginSourceFallbackPlaybackInvocation(opts) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!recovery) {
    cancelSourceFallbackRecovery('new-root-playback');
    return true;
  }
  return sourceFallbackRecoveryCanContinue(recovery);
}
function ensureSourceFallbackRecovery(opts, song, idx, token) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (recovery) return sourceFallbackRecoveryIdentityActive(recovery) ? recovery : null;
  cancelSourceFallbackRecovery('new-recovery');
  recovery = {
    id: 'source-fallback-' + Date.now() + '-' + (++sourceFallbackRecoverySerial),
    startedAt: Date.now(),
    deadlineAt: Date.now() + SOURCE_FALLBACK_RECOVERY_TIMEOUT_MS,
    rootIndex: idx,
    rootToken: token,
    queueAdvances: 0,
    providerAttempts: 0,
    silent: !!(opts && opts.startupAutoplay),
    visitedSongKeys: Object.create(null),
    attemptedProviderKeys: Object.create(null),
    terminal: false,
    cancelled: false,
    completed: false
  };
  var songKey = sourceFallbackRecoveryContentKey(song);
  if (songKey) recovery.visitedSongKeys[songKey] = true;
  activeSourceFallbackRecovery = recovery;
  return recovery;
}
function sourceFallbackQueuePlaybackOptions(opts, recovery) {
  var next = Object.assign({}, opts || {});
  delete next.fallbackOriginalSong;
  delete next.fallbackCandidateSong;
  delete next.preResolvedPlaybackData;
  delete next.preloadedAudio;
  delete next.preloadedData;
  delete next.preloadedProxyAudioUrl;
  next.fallbackDepth = 0;
  next.sourceFallbackRecovery = recovery;
  return next;
}
function sourceFallbackRecoveryFailureOptions(opts) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!recovery) return null;
  return {
    silent: !!recovery.silent,
    playbackOpts: sourceFallbackQueuePlaybackOptions(opts, recovery),
    sourceFallbackRecovery: recovery
  };
}
function settleExpiredSourceFallbackPlayback(idx, token, opts, message) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!sourceFallbackRecoveryIdentityActive(recovery)) return false;
  if (opts && opts.fallbackOriginalSong && opts.fallbackCandidateSong) {
    restoreSourceFallbackQueueItem(idx, opts.fallbackOriginalSong, opts.fallbackCandidateSong, token);
  }
  return settleSourceFallbackTerminal(
    currentIdx,
    trackSwitchToken,
    message || '自动恢复已达到时间上限，请稍后手动重试。',
    sourceFallbackRecoveryFailureOptions(opts) || { sourceFallbackRecovery: recovery }
  );
}
function sourceFallbackProviderAttemptKey(recovery, song, provider) {
  return (sourceFallbackRecoveryContentKey(song) || sourceFallbackSongKey(song)) + '|' + normalizePlaybackProvider(provider);
}
function beginSourceFallbackProviderAttempt(recovery, song, provider) {
  if (!sourceFallbackRecoveryCanContinue(recovery)) return false;
  var key = sourceFallbackProviderAttemptKey(recovery, song, provider);
  if (recovery.attemptedProviderKeys[key]) return false;
  if (recovery.providerAttempts >= SOURCE_FALLBACK_MAX_PROVIDER_ATTEMPTS) return false;
  recovery.attemptedProviderKeys[key] = true;
  recovery.providerAttempts++;
  return true;
}
function awaitSourceFallbackBudget(promise, recovery) {
  if (!recovery) return Promise.resolve(promise);
  var remaining = sourceFallbackRecoveryRemainingMs(recovery);
  if (remaining <= 0) return Promise.resolve(sourceFallbackBudgetTimeoutResult);
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(sourceFallbackBudgetTimeoutResult);
    }, remaining);
    Promise.resolve(promise).then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sourceFallbackProviderTitle(provider) {
  provider = normalizePlaybackProvider(provider);
  if (provider === 'qq') return 'QQ 音乐';
  if (provider === 'kugou') return '酷狗音乐';
  if (provider === 'qishui') return '汽水音乐';
  if (provider === 'migu') return '咪咕音乐';
  if (provider === 'bilibili') return 'B 站';
  return '网易云';
}
function sourceFallbackProviderReady(provider) {
  provider = normalizePlaybackProvider(provider);
  if (SOURCE_FALLBACK_AUTO_EXCLUDED_PROVIDERS.indexOf(provider) >= 0) return false;
  // 免登录公共源不查 platformStatus：登录体系里没有咪咕/B 站的登记，
  // `platformStatus('migu')` 会回落到网易云的状态对象，查了就等于把"网易云已登录"当成咪咕已授权。
  if (SOURCE_FALLBACK_PUBLIC_PROVIDERS.indexOf(provider) >= 0) return true;
  if (SOURCE_FALLBACK_ACCOUNT_PROVIDERS.indexOf(provider) < 0) return false;
  var status = typeof platformStatus === 'function' ? platformStatus(provider) : null;
  if (!status || !status.loggedIn) return false;
  if (provider === 'qq' || provider === 'kugou') return status.playbackKeyReady === true;
  return true;
}
function alternatePlaybackProviders(song) {
  var currentProvider = normalizePlaybackProvider(songProviderKey(song));
  var ordered = typeof accountProviderOrder === 'function'
    ? accountProviderOrder()
    : SOURCE_FALLBACK_DIRECT_PROVIDERS.slice();
  var seen = {};
  var providers = [];
  // 三条道依次过一遍：用户自己排的账号顺序 → 未排进来的账号源 → 免登录公共源。
  [ordered, SOURCE_FALLBACK_ACCOUNT_PROVIDERS, sourceFallbackPublicProviders()].forEach(function (pool) {
    (pool && typeof pool.length === 'number' ? pool : []).forEach(function (provider) {
      provider = normalizePlaybackProvider(provider);
      if (seen[provider] || provider === currentProvider || !sourceFallbackProviderReady(provider)) return;
      seen[provider] = true;
      providers.push(provider);
    });
  });
  // 开发版这里还有一段"有咪咕会话就把咪咕提到整条链最前"（同一首它能给 SQ 无损）。
  // 包里没搬咪咕，那段连同 miguSessionReadyForPriority 一起留在开发版里，见文件开头。
  return providers;
}
function alternatePlaybackProvider(song) {
  return alternatePlaybackProviders(song)[0] || '';
}
function sourceFallbackSongDurationMs(song) {
  var duration = Number(song && song.duration) || 0;
  if (!duration) return 0;
  // 网易云/QQ 给毫秒，咪咕/B 站/汽水给秒；咪咕搜索阶段没有时长字段（回 0，判据自动跳过）
  return duration > 10000 ? duration : duration * 1000;
}
function sourceFallbackCandidateBlockedByRights(candidate) {
  // 咪咕在搜索阶段就逐曲标了 canListen（24 样本对"匿名能否真取到地址"预测零误报），
  // 标了不可播的直接不试，省下整条取址的预算。
  return !!(candidate && candidate.canListen === false);
}
// 采纳口径统一走 biliAdoptDecision（00-api-quality-output.js）：这首歌的任何声音形式都收
// （翻唱、影视 BGM、器乐改编、伴奏/纯音乐、变速/DJ/remix、片段、清唱），收到就在提示里写明是哪一种；
// 只有"主体是说话不是放歌"的才拒：教学、教程、讲解、反应视频、测评。
function sourceFallbackAdoptDecision(candidate) {
  if (typeof biliAdoptDecision === 'function') {
    try { return biliAdoptDecision(candidate) || ''; } catch (e) { }
  }
  // 无头自检单独 vm 装载本文件时没有音质层，用同一套判据的子集兜底
  var raw = String([
    candidate && (candidate.name || candidate.title),
    candidate && candidate.artist,
    candidate && candidate.categoryName,
    (candidate && Array.isArray(candidate.tags)) ? candidate.tags.join(' ') : ''
  ].join(' ').toLowerCase());
  if (/教学|教程|讲解|反应视频|reaction|测评|开箱/.test(raw)) return 'reject';
  if (candidate && (candidate.coverCategory || candidate.musicCategory === false)) return 'noted';
  if (/翻唱|cover|伴奏|纯音乐|instrumental|karaoke|指弹|尤克里里|钢琴|古筝|二胡|琵琶|笛子|口哨|改编|变奏|现场|live|影视|剪辑|bgm|ost|配乐|原声|插曲|主题曲|加速|放慢|sped|slowed|remix|混音|dj|铃声|彩铃|清唱|哼唱/.test(raw)) return 'noted';
  return '';
}
function sourceFallbackLooksDerivative(candidate) {
  return sourceFallbackAdoptDecision(candidate) === 'reject';
}
function decoratedTitleLooksSameRecording(source, candidate) {
  if (!source || !candidate) return false;
  // 采纳口径见 sourceFallbackAdoptDecision：翻唱/影视 BGM/器乐改编都收（收了这个版本会在提示里写明），
  // 只有伴奏、加速版、教学这类"不是在唱这首"的内容才拒。
  if (sourceFallbackAdoptDecision(candidate) === 'reject') return false;
  var title = normalizeMatchText(source.name || source.title || '');
  var candidateText = normalizeMatchText([
    candidate.name || candidate.title || '',
    candidate.artist || '',
    candidate.album || ''
  ].join(''));
  if (!title || !candidateText) return false;
  if (candidateText.indexOf(title) < 0) return false;
  // 歌手证据：artist 字段（B 站那是上传者名）、标题文本，或上传者打的标签里出现歌手名。
  var sourceArtists = artistNameParts(source);
  var candidateArtists = artistNameParts(candidate);
  var tagText = normalizeMatchText(Array.isArray(candidate.tags) ? candidate.tags.join('') : '');
  var artistEvidence = sourceArtists.some(function (name) {
    if (!name) return false;
    return candidateArtists.indexOf(name) >= 0 || candidateText.indexOf(name) >= 0 || (tagText && tagText.indexOf(name) >= 0);
  });
  if (!artistEvidence) return false;
  // 时长不再要求"接近原曲"（2026-10-03 人工定：片段/铃声也要能收），只卡两头。
  // 上限保留：比原曲长 15s 以上的一定是串烧或整碟搬运，播起来是几十分钟而不是这首歌；
  // 下限 20s：再短的多是口播、预告、十几秒的梗，不是"在放这段歌"。
  var sourceMs = sourceFallbackSongDurationMs(source);
  var candidateMs = sourceFallbackSongDurationMs(candidate);
  if (sourceMs && candidateMs) {
    if (candidateMs - sourceMs > SOURCE_FALLBACK_DURATION_TOLERANCE_MS) return false;
    if (candidateMs < SOURCE_FALLBACK_MIN_CLIP_MS) return false;
  }
  return true;
}
// 明显比原曲短的（铃声、高潮片段）仍然收，但要标注出来：它响完就没了
function decoratedIsShortClip(source, candidate) {
  var sourceMs = sourceFallbackSongDurationMs(source);
  var candidateMs = sourceFallbackSongDurationMs(candidate);
  if (!sourceMs || !candidateMs) return false;
  return sourceMs - candidateMs > SOURCE_FALLBACK_DURATION_TOLERANCE_MS;
}
function decoratedClipNote(candidate) {
  var noted = (typeof biliAdoptNoteText === 'function') ? biliAdoptNoteText(candidate) : '';
  return noted || '片段版本';
}
function sourceFallbackSearchUrl(provider, song) {
  var endpoint = SOURCE_FALLBACK_SEARCH_ENDPOINTS[provider] || SOURCE_FALLBACK_SEARCH_ENDPOINTS.netease;
  var limit = SOURCE_FALLBACK_SEARCH_LIMITS[provider] || 8;
  var artist = artistNameParts(song)[0] || '';
  var query = [song.name || song.title || '', song.artist || artist].filter(Boolean).join(' ').trim();
  if (!query) return '';
  return endpoint + '?keywords=' + encodeURIComponent(query) + '&limit=' + limit;
}
async function searchAlternatePlatformSong(song, requestedTarget, recovery) {
  var target = requestedTarget || alternatePlaybackProvider(song);
  if (!target || !sourceFallbackProviderReady(target)) return null;
  if (recovery && !sourceFallbackRecoveryCanContinue(recovery)) return null;
  var url = sourceFallbackSearchUrl(normalizePlaybackProvider(target), song);
  if (!url) return null;
  var decorated = SOURCE_FALLBACK_DECORATED_TITLE_PROVIDERS.indexOf(normalizePlaybackProvider(target)) >= 0;
  var data = await awaitSourceFallbackBudget(
    apiJson(url, { timeoutMs: SOURCE_FALLBACK_SEARCH_TIMEOUT_MS }),
    recovery
  );
  if (data === sourceFallbackBudgetTimeoutResult || (recovery && !sourceFallbackRecoveryCanContinue(recovery))) return null;
  var list = data && (data.songs || data.result || []);
  var strictPick = null;
  var decoratedPick = null;
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || sourceFallbackCandidateBlockedByRights(list[i])) continue;
    if (typeof sourceCandidateRejectReason === 'function' && sourceCandidateRejectReason(song, list[i], target)) continue;
    if (isSameTitleArtist(song, list[i])) {
      strictPick = list[i];
      break;
    }
  }
  if (!strictPick && decorated) {
    for (var j = 0; j < list.length; j++) {
      if (sourceFallbackCandidateBlockedByRights(list[j])) continue;
      if (decoratedTitleLooksSameRecording(song, list[j])) {
        decoratedPick = list[j];
        break;
      }
    }
  }
  var picked = strictPick || decoratedPick;
  if (!picked) return null;
  var clone = cloneSong(picked);
  clone.autoFallbackMatch = strictPick ? 'same-title-artist' : 'decorated-title';
  // 非原唱版本（翻唱 / 影视 BGM / 器乐改编 / 伴奏 / 变速…）与明显短于原曲的片段，都标出来
  var adoptNote = (typeof biliAdoptNoteText === 'function' && sourceFallbackAdoptDecision(picked) === 'noted')
    ? biliAdoptNoteText(picked) : '';
  if (decoratedIsShortClip(song, picked)) {
    adoptNote = adoptNote ? (adoptNote + '·片段') : '片段版本';
  }
  clone.autoFallbackNote = adoptNote;
  return clone;
}
function sourceFallbackSongKey(song) {
  if (!song) return '';
  if (typeof queueItemKey === 'function') return queueItemKey(song);
  return [songProviderKey(song), song.id || song.mid || song.hash || '', song.name || song.title || '', song.artist || ''].join(':');
}
function restoreSourceFallbackQueueItem(idx, originalSong, candidateSong, expectedToken) {
  if (!originalSong || idx < 0 || idx >= playQueue.length) return false;
  if (expectedToken != null && expectedToken !== trackSwitchToken) return false;
  if (currentIdx !== idx || sourceFallbackSongKey(playQueue[idx]) !== sourceFallbackSongKey(candidateSong)) return false;
  playQueue[idx] = hydrateCustomCover(originalSong);
  if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(playQueue[idx]);
  var title = document.getElementById('thumb-title');
  var artist = document.getElementById('thumb-artist');
  if (title) title.textContent = playQueue[idx].name || playQueue[idx].title || '';
  if (artist) artist.textContent = playQueue[idx].artist || '';
  safeRenderQueuePanel('source-fallback-rollback', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('source-fallback-rollback');
  return true;
}
function settleSourceFallbackTerminal(idx, token, message, opts) {
  opts = opts || {};
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (token !== trackSwitchToken || currentIdx !== idx) return false;
  if (recovery) {
    if (!sourceFallbackRecoveryIdentityActive(recovery)) return false;
    recovery.terminal = true;
    recovery.terminalAt = Date.now();
    if (activeSourceFallbackRecovery === recovery) activeSourceFallbackRecovery = null;
  }
  hideLoading();
  forcePlaybackControlsInteractive();
  playToggleBusy = false;
  markQueueItemPlaybackFailed(idx, recovery);
  if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('source-fallback-terminal');
  if (typeof resetCuefieldAutoMix === 'function') resetCuefieldAutoMix('source-fallback-terminal');
  if (typeof clearPlaybackResumeWatchdogs === 'function') clearPlaybackResumeWatchdogs();
  if (typeof playbackResumeRecovery !== 'undefined' && playbackResumeRecovery) {
    playbackResumeRecovery.serial = (Number(playbackResumeRecovery.serial) || 0) + 1;
    playbackResumeRecovery.pending = false;
  }
  if (audio) {
    try {
      audioFadeSerial++;
      clearAudioFadeTimers();
      audio.onended = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.__mineradioQueueItemKey = '';
      audio.__mineradioTrackSwitchToken = 0;
      audio.load();
    } catch (e) { }
  }
  playing = false;
  setPlayIcon(false);
  if (typeof syncPlaybackStateFromAudioEvent === 'function') syncPlaybackStateFromAudioEvent('source-fallback-terminal');
  if (!opts.silent) showSourceFallbackNotice('当前没有可用音源', message || '当前歌曲不可播放，其它音源也没有找到同名同歌手的可播版本。');
  return false;
}
function markQueueItemPlaybackFailed(idx, recovery) {
  if (!playQueue[idx]) return;
  playQueue[idx]._lastPlaybackFailAt = Date.now();
  playQueue[idx]._lastPlaybackFailRecoveryId = recovery && recovery.id ? recovery.id : '';
}
var MAX_RECENT_AUTO_QUEUE_FAILURES = 12;
function recentQueuePlaybackFailureCount(recovery) {
  var now = Date.now();
  var count = 0;
  for (var index = 0; index < playQueue.length; index++) {
    var failedAt = Number(playQueue[index] && playQueue[index]._lastPlaybackFailAt) || 0;
    if (recovery && playQueue[index] && playQueue[index]._lastPlaybackFailRecoveryId !== recovery.id) continue;
    if (failedAt && now - failedAt <= 18000) {
      count++;
      if (count >= MAX_RECENT_AUTO_QUEUE_FAILURES) break;
    }
  }
  return count;
}
function nextUnblockedQueueIndex(idx, recovery) {
  var now = Date.now();
  for (var step = 1; step < playQueue.length; step++) {
    var nextIdx = (idx + step) % playQueue.length;
    var failedAt = Number(playQueue[nextIdx] && playQueue[nextIdx]._lastPlaybackFailAt) || 0;
    var recoveryKey = sourceFallbackRecoveryContentKey(playQueue[nextIdx]);
    if (recovery && recoveryKey && recovery.visitedSongKeys[recoveryKey]) continue;
    var failedInRecovery = !recovery
      || (playQueue[nextIdx] && playQueue[nextIdx]._lastPlaybackFailRecoveryId === recovery.id);
    if (!failedInRecovery || !failedAt || now - failedAt > 18000) return nextIdx;
  }
  return -1;
}
function isQueueItemRecentlyPlaybackFailed(idx) {
  var failedAt = Number(playQueue[idx] && playQueue[idx]._lastPlaybackFailAt) || 0;
  return !!(failedAt && Date.now() - failedAt <= 18000);
}
async function skipFailedQueueItem(idx, token, message, opts) {
  opts = opts || {};
  if (token !== trackSwitchToken) return false;
  var recovery = ensureSourceFallbackRecovery(opts, playQueue[idx], idx, token);
  if (!recovery) return false;
  var terminalOpts = Object.assign({}, opts, { sourceFallbackRecovery: recovery });
  if (!sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', terminalOpts);
  }
  hideLoading();
  markQueueItemPlaybackFailed(idx, recovery);
  var currentRecoveryKey = sourceFallbackRecoveryContentKey(playQueue[idx]);
  if (currentRecoveryKey) recovery.visitedSongKeys[currentRecoveryKey] = true;
  if (playQueue.length <= 1) {
    return settleSourceFallbackTerminal(idx, token, message || '当前歌曲不可播放，队列里没有其他歌曲。', terminalOpts);
  }
  if (recentQueuePlaybackFailureCount(recovery) >= Math.min(MAX_RECENT_AUTO_QUEUE_FAILURES, playQueue.length)) {
    return settleSourceFallbackTerminal(idx, token, '', terminalOpts);
  }
  if (recovery.queueAdvances >= SOURCE_FALLBACK_MAX_QUEUE_ADVANCES) {
    return settleSourceFallbackTerminal(idx, token, '已停止自动切换，避免无可用音源时反复扫描整条队列。', terminalOpts);
  }
  var nextIdx = nextUnblockedQueueIndex(idx, recovery);
  if (nextIdx < 0) {
    return settleSourceFallbackTerminal(idx, token, '已尝试绕开受限歌曲，当前队列没有新的可播放项。', terminalOpts);
  }
  if (!opts.silent) showSourceFallbackNotice('已跳过受限歌曲', message || '未找到同名同歌手的另一个平台版本，正在播放下一首。');
  recovery.queueAdvances++;
  var nextRecoveryKey = sourceFallbackRecoveryContentKey(playQueue[nextIdx]);
  if (nextRecoveryKey) recovery.visitedSongKeys[nextRecoveryKey] = true;
  var nextPlaybackOpts = Object.assign(
    {},
    sourceFallbackQueuePlaybackOptions(opts.playbackOpts || {}, recovery),
    { skipShuffleOrder: true }
  );
  var nextStarted = await playQueueAt(nextIdx, nextPlaybackOpts);
  if (nextStarted === true) completeSourceFallbackRecovery(recovery);
  else if (sourceFallbackRecoveryIdentityActive(recovery) && !sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(currentIdx, trackSwitchToken, '自动恢复已达到时间上限，请稍后手动重试。', terminalOpts);
  }
  return nextStarted === true;
}
async function tryAutoPlaybackFallback(song, data, idx, token, opts) {
  opts = opts || {};
  if (opts.fallbackDepth > 0) {
    if (opts.fallbackOriginalSong && opts.fallbackCandidateSong) {
      restoreSourceFallbackQueueItem(idx, opts.fallbackOriginalSong, opts.fallbackCandidateSong, token);
    }
    return false;
  }
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return null;
  var category = playbackRestrictionCategory(song, data);
  var fromLabel = playbackProviderLabel(song);
  var alternateProviders = alternatePlaybackProviders(song);
  if (!alternateProviders.length && category === 'login_required') return null;
  var recovery = ensureSourceFallbackRecovery(opts, song, idx, token);
  if (!recovery) return false;
  opts = Object.assign({}, opts, { sourceFallbackRecovery: recovery });
  var skipPlaybackOpts = sourceFallbackQueuePlaybackOptions(opts, recovery);
  skipPlaybackOpts.startupAutoplay = true;
  if (opts.resumeAt != null) skipPlaybackOpts.resumeAt = opts.resumeAt;
  var skipOpts = {
    silent: !!recovery.silent,
    playbackOpts: skipPlaybackOpts,
    sourceFallbackRecovery: recovery
  };
  if (!sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
  }
  if (!alternateProviders.length) {
    return await skipFailedQueueItem(idx, token, '当前歌曲不可播放，其它音源也没有同名同歌手的可播版本。', skipOpts);
  }
  if (!opts.startupAutoplay) {
    showSourceFallbackNotice('正在自动换源', fromLabel + ' 当前不可播，正在检查 ' + alternateProviders.map(sourceFallbackProviderTitle).join('、') + ' 的同名同歌手版本。');
  }
  for (var providerIndex = 0; providerIndex < alternateProviders.length; providerIndex++) {
    var alternateProvider = alternateProviders[providerIndex];
    if (!beginSourceFallbackProviderAttempt(recovery, song, alternateProvider)) {
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
      }
      continue;
    }
    var targetLabel = sourceFallbackProviderTitle(alternateProvider);
    try {
      var alternate = await searchAlternatePlatformSong(song, alternateProvider, recovery);
      if (token !== trackSwitchToken) return false;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
      }
      if (!alternate) continue;
      var alternateData = typeof resolveAlbumGaplessPlaybackData === 'function'
        ? await awaitSourceFallbackBudget(resolveAlbumGaplessPlaybackData(alternate), recovery)
        : null;
      if (token !== trackSwitchToken) return false;
      if (alternateData === sourceFallbackBudgetTimeoutResult || !sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
      }
      if (!alternateData || !alternateData.url) continue;
      var originalSong = playQueue[idx];
      alternate.autoFallbackFrom = songProviderKey(song);
      var committedCandidate = hydrateCustomCover(alternate);
      playQueue[idx] = committedCandidate;
      safeRenderQueuePanel('source-fallback-provisional', { scrollCurrent: miniQueueOpen });
      safeShelfRebuild('source-fallback-provisional');
      var fallbackPlaybackOpts = {
        fallbackDepth: 1,
        startupAutoplay: !!opts.startupAutoplay,
        preserveHomeState: !!opts.preserveHomeState,
        suppressPlayFailureNotice: true,
        preResolvedPlaybackData: alternateData,
        fallbackOriginalSong: originalSong,
        fallbackCandidateSong: committedCandidate,
        sourceFallbackRecovery: recovery,
        qqQualityTried: ['hires', 'lossless', 'exhigh', 'standard']
      };
      if (opts.resumeAt != null) fallbackPlaybackOpts.resumeAt = opts.resumeAt;
      var fallbackPromise = playQueueAt(idx, fallbackPlaybackOpts);
      var fallbackToken = trackSwitchToken;
      var fallbackStarted = await fallbackPromise;
      if (fallbackToken !== trackSwitchToken) return false;
      var resolvedBitrate = Number(alternateData && (alternateData.br || alternateData.bandwidth)) || 0;
      var resolvedQualityLabel = String((alternateData && (alternateData.qualityLabel || alternateData.quality)) || '').trim();
      // 网易云返回的 level/quality 是"请求的档位"而不是"给到的档位"（实测匿名要 hires 也回 level:hires 但 br:128008），
      // 所以只要上游给了真实码率就一律带出来，避免提示里写"高清臻音"却播 128k。
      if (resolvedBitrate && !/kbps|mbps/i.test(resolvedQualityLabel)) resolvedQualityLabel = (resolvedQualityLabel ? resolvedQualityLabel + ' · ' : '') + Math.round(resolvedBitrate / 1000) + 'kbps';
      var variantNote = alternate.autoFallbackNote ? (' · ' + alternate.autoFallbackNote + '（非原唱）')
        : (alternate.autoFallbackMatch === 'decorated-title' ? ' · 按标题与时长匹配的版本' : '');
      var switchNoticeBody = (song.name || '当前歌曲') + ' 已从 ' + fromLabel + ' 切到 ' + targetLabel
        + (resolvedQualityLabel ? '（' + resolvedQualityLabel + '）' : '') + variantNote + '。';
      if (fallbackStarted === true) {
        completeSourceFallbackRecovery(recovery);
        if (!opts.startupAutoplay) showSourceFallbackNotice('已自动切换音源', switchNoticeBody);
        return true;
      }
      restoreSourceFallbackQueueItem(idx, originalSong, committedCandidate, fallbackToken);
      token = fallbackToken;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
      }
    } catch (e) {
      if (token !== trackSwitchToken) return false;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, '自动恢复已达到时间上限，请稍后手动重试。', skipOpts);
      }
      console.warn('[SourceFallback]', alternateProvider, e && (e.message || e));
    }
  }
  return await skipFailedQueueItem(idx, token, '没有找到可播放的其它音源版本，正在播放下一首。', skipOpts);
}
function handlePlaybackUnavailable(song, data) {
  hideLoading();
  forcePlaybackControlsInteractive();
  var provider = playbackLoginProvider(song);
  var notice = playbackRestrictionNotice(song, data);
  var category = notice.category;
  showToast(notice.toast || notice.title || playbackRestrictionMessage(song, data));
  showSourceFallbackNotice(notice.title, notice.body);
  if (category === 'login_required') {
    setTimeout(function () {
      var modal = document.getElementById('login-modal');
      if (!modal || modal.classList.contains('show')) return;
      openProviderLogin(provider);
    }, 520);
  }
}

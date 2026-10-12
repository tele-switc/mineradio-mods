'use strict';

// 贴边播放小组件的纯逻辑：吸附几何、收起形态、状态规范化。
// 刻意不依赖 Electron，便于用 node:test 直接验证。

const SIZE = {
  // 宽度按"底部横跨全宽的进度条"来定：太窄会让进度条和文案挤作一团
  width: 400,
  height: 104,
  // 收起后贴在屏边的厚度。进度轨接管屏边之后这个形态基本不再露脸，留着是为了
  // 组件窗口自己缩放时仍有兜底版式。Windows 对无边框窗口有最小宽度，实测设 12 会被夹到 32。
  sliver: 32,
  // 展开时必须贴住吸附边，不能留白：进度轨靠"指针落在屏边窄带里"把组件唤回来，
  // 若组件展开后离屏边还有 10px，光标停在最外沿就收不到组件自己的 hover，
  // 2.2s 后自动收起 → 进度轨回来 → 又立刻唤回组件，来回抖。
  gap: 0,
};

const EDGES = ['left', 'right', 'bottom'];

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeRect(rect) {
  const r = rect || {};
  return {
    x: Number(r.x) || 0,
    y: Number(r.y) || 0,
    width: Math.max(1, Number(r.width) || 0),
    height: Math.max(1, Number(r.height) || 0),
  };
}

// 离哪条屏边最近就吸到哪条边；上下留白对称，因此只比左右与底。
function resolveEdge(bounds, workArea) {
  const b = normalizeRect(bounds);
  const wa = normalizeRect(workArea);
  const distLeft = b.x - wa.x;
  const distRight = (wa.x + wa.width) - (b.x + b.width);
  const distBottom = (wa.y + wa.height) - (b.y + b.height);
  const min = Math.min(distLeft, distRight, distBottom);
  if (min === distRight) return 'right';
  if (min === distLeft) return 'left';
  return 'bottom';
}

// 展开与收起两套几何。收起形态保持沿吸附边的一条窄条，点击即可再展开。
function dockGeometry(edge, workArea, size) {
  const wa = normalizeRect(workArea);
  const s = { ...SIZE, ...(size || {}) };
  const target = EDGES.includes(edge) ? edge : 'right';
  const expandedTop = wa.y + Math.round((wa.height - s.height) / 2);
  const expandedLeft = wa.x + Math.round((wa.width - s.width) / 2);

  if (target === 'left') {
    return {
      edge: target,
      expanded: { x: wa.x + s.gap, y: expandedTop, width: s.width, height: s.height },
      collapsed: { x: wa.x, y: expandedTop, width: s.sliver, height: s.height },
    };
  }
  if (target === 'bottom') {
    return {
      edge: target,
      expanded: { x: expandedLeft, y: wa.y + wa.height - s.height - s.gap, width: s.width, height: s.height },
      collapsed: { x: expandedLeft, y: wa.y + wa.height - s.sliver, width: s.width, height: s.sliver },
    };
  }
  return {
    edge: target,
    expanded: { x: wa.x + wa.width - s.width - s.gap, y: expandedTop, width: s.width, height: s.height },
    collapsed: { x: wa.x + wa.width - s.sliver, y: expandedTop, width: s.sliver, height: s.height },
  };
}

// 展开/收起切换时给窗口用的目标矩形。
function frameFor(dock, collapsed) {
  return collapsed ? { ...dock.collapsed } : { ...dock.expanded };
}

// 只允许播放控制类命令穿透到主窗口；收起/固定/关闭属于视图意图，走独立通道。
const ACTIONS = ['toggle', 'next', 'prev', 'seek', 'volume', 'focus-main'];

function normalizeCommand(payload) {
  const p = payload || {};
  const action = String(p.action || '').trim();
  if (!ACTIONS.includes(action)) return null;
  return {
    action,
    value: Number.isFinite(Number(p.value)) ? Number(p.value) : null,
  };
}

// 音域方块配色跟随：这些值最终会写进组件与边缘轨的 CSS 变量，
// 所以只认十六进制颜色，其余一律丢掉——不能让状态串成样式注入。
const ACCENT_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ACCENT_FALLBACK = {
  base: '#05070c',
  cool: '#33e6ff',
  warm: '#ffd070',
  accent: '#7fd8ff',
};

function normalizeAccentColor(value, fallback) {
  const s = String(value == null ? '' : value).trim();
  return ACCENT_HEX.test(s) ? s : fallback;
}

function normalizeAccent(payload) {
  const p = payload || {};
  const src = p.accent && typeof p.accent === 'object' ? p.accent : {};
  return {
    base: normalizeAccentColor(src.base, ACCENT_FALLBACK.base),
    cool: normalizeAccentColor(src.cool, ACCENT_FALLBACK.cool),
    warm: normalizeAccentColor(src.warm, ACCENT_FALLBACK.warm),
    accent: normalizeAccentColor(src.accent, ACCENT_FALLBACK.accent),
  };
}

function normalizeState(payload) {
  const p = payload || {};
  const duration = clampNumber(p.durationSec, 0, 24 * 3600, 0);
  const position = clampNumber(p.positionSec, 0, duration || 24 * 3600, 0);
  const edge = EDGES.includes(String(p.edge)) ? String(p.edge) : 'right';
  return {
    enabled: !!p.enabled,
    collapsed: !!p.collapsed,
    pinned: !!p.pinned,
    edge,
    title: String(p.title || '').slice(0, 160),
    artist: String(p.artist || '').slice(0, 120),
    cover: /^https?:/.test(String(p.cover || '')) ? String(p.cover).slice(0, 512) : '',
    playing: !!p.playing,
    positionSec: position,
    durationSec: duration,
    // 进度一律以 0..1 下发，避免渲染侧和组件侧各算一份出现漂移
    progress: duration > 0 ? clampNumber(position / duration, 0, 1, 0) : 0,
    volume: clampNumber(p.volume, 0, 1, 0),
    provider: String(p.provider || '').slice(0, 24),
    accent: normalizeAccent(p),
    updatedAt: Number(p.updatedAt) || Date.now(),
  };
}

// ====================================================================
//  屏幕边缘进度轨：整条屏边就是进度条
//  几何一律基于 workArea（避开任务栏），方向决定填充起点：
//  竖轨自上而下、横轨自左而右；点击/拖拽按同一轴向换算进度。
// ====================================================================
const RAIL = {
  // 视觉厚度：真正画出来的那条线有多粗
  thickness: 6,
  minThickness: 3,
  maxThickness: 40,
  // Windows 对顶层窗口有最小尺寸，实测竖轨窗口宽度设 16 会被夹到 34、横轨高度夹到 38。
  // 所以窗口按系统最小值开，只在贴外沿画 visualThickness 那么粗，外面保持透明。
  osMinCross: 34,
  // 窗口往屏幕外多推这么多 DIP：DIP↔物理像素在 150% 缩放下会取整，
  // 只按"内容边 == 屏幕边"摆，实测会在屏幕最外沿留下 1 物理像素的桌面缝。
  // 推出去之后条子靠 CSS 的 --bleed 内缩回屏幕边界，缝就不存在了。
  bleed: 2,
  maxBleed: 12,
};
const RAIL_EDGES = ['left', 'right', 'top', 'bottom'];

function isVerticalRail(edge) {
  return edge === 'left' || edge === 'right';
}

function railGeometry(edge, workArea, thickness, opts) {
  const wa = normalizeRect(workArea);
  const o = opts || {};
  const visual = Math.round(clampNumber(thickness, RAIL.minThickness, RAIL.maxThickness, RAIL.thickness));
  const bleed = Math.round(clampNumber(o.bleed, 0, RAIL.maxBleed, RAIL.bleed));
  // 窗口横截面取"视觉厚度、系统最小值、真实横截面"的较大者。
  // actualCross 来自主进程 setBounds 之后回读的 getContentBounds()：
  // Windows 只会把窗口夹大、不会跟着挪位置，实测底轨请求 34 高拿到 38，
  // 于是整条窗口往屏幕外溢出 4 DIP，用真实值重算一次才对得上屏幕边界。
  const cross = Math.max(visual, Math.round(Number(o.actualCross) || 0), RAIL.osMinCross);
  const target = RAIL_EDGES.includes(edge) ? edge : 'right';
  const base = { edge: target, visualThickness: visual, thickness: cross, bleed };
  if (target === 'left') return { ...base, vertical: true, x: wa.x - bleed, y: wa.y, width: cross, height: wa.height };
  if (target === 'top') return { ...base, vertical: false, x: wa.x, y: wa.y - bleed, width: wa.width, height: cross };
  if (target === 'bottom') return { ...base, vertical: false, x: wa.x, y: wa.y + wa.height - cross + bleed, width: wa.width, height: cross };
  return { ...base, vertical: true, x: wa.x + wa.width - cross + bleed, y: wa.y, width: cross, height: wa.height };
}

// 指针位置 → 进度比例。竖轨从上往下、横轨从左往右。
function railProgressFromPoint(geo, clientX, clientY) {
  if (!geo) return 0;
  const span = geo.vertical ? geo.height : geo.width;
  if (!span) return 0;
  const origin = geo.vertical ? geo.y : geo.x;
  const point = geo.vertical ? Number(clientY) : Number(clientX);
  return clampNumber((point - origin) / span, 0, 1, 0);
}

// 命中判定：只有贴着屏幕最外沿的那一小条算"可点"，其余鼠标穿透。
// 放在这里作为唯一真相，页面只上报指针、由主进程判定并接管，避免两处规则漂移。
const RAIL_BAND_PAD = 3;

function railBandHit(state, geo, point) {
  const s = normalizeRailState(state);
  const g = geo || railGeometry(s.edge, { x: 0, y: 0, width: 0, height: 0 }, s.thickness);
  const p = point || {};
  const limit = s.thickness + RAIL_BAND_PAD;
  // 窗口往屏幕外推了 bleed，那几 DIP 鼠标永远够不到，命中带要按"看得见的宽度"算
  const winW = (Number(g.width) || 0) - (Number(g.bleed) || 0);
  const winH = (Number(g.height) || 0) - (Number(g.bleed) || 0);
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  switch (s.edge) {
    case 'left': return x <= limit - (Number(g.bleed) || 0);
    case 'top': return y <= limit - (Number(g.bleed) || 0);
    case 'bottom': return y >= winH - limit;
    default: return x >= winW - limit;
  }
}

const RAIL_ACTIONS = ['seek'];

function normalizeRailCommand(payload) {
  const p = payload || {};
  if (String(p.action || '') !== 'seek') return null;
  return { action: 'seek', value: clampNumber(p.value, 0, 1, -1) };
}

function normalizeRailState(payload) {
  const p = payload || {};
  const duration = clampNumber(p.durationSec, 0, 24 * 3600, 0);
  const position = clampNumber(p.positionSec, 0, duration || 24 * 3600, 0);
  return {
    enabled: !!p.enabled,
    edge: RAIL_EDGES.includes(String(p.edge)) ? String(p.edge) : 'right',
    // 这里始终是"视觉厚度"；窗口真实横截面由 railGeometry 按系统最小值放大
    thickness: Math.round(clampNumber(p.thickness, RAIL.minThickness, RAIL.maxThickness, RAIL.thickness)),
    progress: duration > 0 ? clampNumber(position / duration, 0, 1, 0) : 0,
    playing: !!p.playing,
    hasMedia: !!p.hasMedia,
    positionSec: position,
    durationSec: duration,
    title: String(p.title || '').slice(0, 160),
    accent: normalizeAccent(p),
    // 几何回传：页面要用真实横截面和 bleed 把条子内缩回屏幕边界
    geo: p.geo && typeof p.geo === 'object' ? p.geo : null,
    updatedAt: Number(p.updatedAt) || Date.now(),
  };
}

module.exports = {
  SIZE,
  EDGES,
  ACTIONS,
  RAIL,
  RAIL_EDGES,
  RAIL_ACTIONS,
  clampNumber,
  normalizeRect,
  resolveEdge,
  dockGeometry,
  frameFor,
  normalizeCommand,
  normalizeState,
  railGeometry,
  railBandHit,
  RAIL_BAND_PAD,
  railProgressFromPoint,
  normalizeRailCommand,
  normalizeRailState,
  isVerticalRail,
  normalizeAccent,
  normalizeAccentColor,
  ACCENT_FALLBACK,
};

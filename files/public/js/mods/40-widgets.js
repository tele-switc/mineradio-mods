'use strict';

// Mineradio 贴边播放小组件的主窗口侧：把播放状态推给组件，并把组件按钮的命令落回播放器。
// 依赖加载顺序在前的全局：audio / playQueue / currentIdx / togglePlay / nextTrack / prevTrack / setVolume。
//
// mineradio-mods 外挂版与开发版的三处差别（逻辑没动）：
//  1. 入口那颗「贴边」按钮在开发版写在 index.html 里，而那个文件更新会被换掉 →
//     这里运行时注入到同一排 `.desktop-mode-btn` 里（DIY 那颗之前），类名与属性完全照抄，
//     样式跟着上游那条走，不另立配色。
//  2. 那两个窗口自己的桥接方法是外挂的 `desktopMods` 提供的（上游 desktopWindow 里没有，
//     contextBridge 暴露的对象又冻结了），下面 getMiniPlayerApi() 两个都认。
//  3. 组件窗口与边缘轨窗口由 desktop/mods-widget-host.js 自建。
// ============================================================

var miniPlayerEnabled = false;
var miniPlayerPushTimer = null;
var miniPlayerCommandUnsub = null;
var miniPlayerEnabledUnsub = null;
var edgeRailStateUnsub = null;

function getMiniPlayerApi() {
  // desktopMods = 外挂那段桥接；desktopWindow = 开发仓库那份（上游桥接里本来就有这些方法）
  var candidates = [window.desktopMods, window.desktopWindow];
  for (var i = 0; i < candidates.length; i++) {
    var api = candidates[i];
    if (api && typeof api.setMiniPlayerEnabled === 'function') return api;
  }
  return null;
}

// ---------- 入口按钮：上游 index.html 里没有这颗，运行时插进同一排按钮里 ----------

var MINI_PLAYER_BUTTON_HTML = ''
  + '<button id="mini-player-btn" class="desktop-mode-btn" type="button" onclick="toggleMiniPlayer()"'
  + ' oncontextmenu="cycleMiniPlayerEdge(); return false;"'
  + ' title="贴边播放小组件（右键换吸附边；闲置时自动收成贴边进度条，指针回到那条边就展开）"'
  + ' aria-label="贴边播放小组件" aria-pressed="false">贴边</button>';

function ensureMiniPlayerButton() {
  try {
    if (document.getElementById('mini-player-btn')) return true;
    var holder = document.createElement('div');
    holder.innerHTML = MINI_PLAYER_BUTTON_HTML;
    var btn = holder.firstElementChild;
    if (!btn) return false;
    // 首选 DIY 那颗之前（与开发版里它的位置一致）；上游哪天改了这排按钮就退到
    // 任意一颗 .desktop-mode-btn 前面，再退到控制条末尾——总得有个能点的地方
    var anchor = document.getElementById('diy-mode-btn') || document.querySelector('.desktop-mode-btn');
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('beforebegin', btn);
    else if (document.getElementById('bottom-bar')) document.getElementById('bottom-bar').appendChild(btn);
    else return false;
    return true;
  } catch (e) {
    console.warn('[mods] 贴边组件的入口按钮没插上：' + ((e && e.message) || e));
    return false;
  }
}

function miniPlayerCurrentSong() {
  if (typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0 && currentIdx < playQueue.length) {
    return playQueue[currentIdx] || null;
  }
  return null;
}

// 音域方块（浮空方块）当前实际用的那组颜色：自定义模式取 fx 里的四个色，
// 否则取封面调色板算出来的预览色——和 FX 面板显示的完全是同一个来源，
// 所以组件/边缘轨的颜色就是舞台上方块的颜色。
function miniPlayerAccentColors() {
  var fallback = { base: '#05070c', cool: '#33e6ff', warm: '#ffd070', accent: '#7fd8ff' };
  if (typeof fx === 'undefined' || !fx) return fallback;
  var custom = fx.sonicGroundColorMode === 'custom';
  var src = fallback;
  try {
    if (custom) {
      src = {
        base: fx.sonicGroundBaseColor,
        cool: fx.sonicGroundCoolColor,
        warm: fx.sonicGroundWarmColor,
        accent: fx.sonicGroundAccentColor,
      };
    } else if (typeof sonicGroundCoverPreviewColors === 'function') {
      var preview = sonicGroundCoverPreviewColors() || {};
      src = {
        base: preview.sonicGroundBaseColor,
        cool: preview.sonicGroundCoolColor,
        warm: preview.sonicGroundWarmColor,
        accent: preview.sonicGroundAccentColor,
      };
    }
  } catch (e) {
    return fallback;
  }
  var hex = typeof normalizeHexColor === 'function' ? normalizeHexColor : null;
  var out = {};
  Object.keys(fallback).forEach(function (key) {
    var raw = src[key] || fallback[key];
    out[key] = hex ? hex(raw, fallback[key]) : raw;
  });
  return out;
}

function miniPlayerPayload() {
  var song = miniPlayerCurrentSong();
  var duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
  var position = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  var artist = '';
  if (song && typeof currentArtistNames === 'function') {
    artist = currentArtistNames(song).join(' / ');
  }
  if (!artist && song) artist = String(song.artist || '');
  var cover = '';
  if (song && typeof songCoverSrc === 'function') {
    try { cover = songCoverSrc(song, 240) || ''; } catch (e) { cover = ''; }
  }
  return {
    title: song ? String(song.name || song.title || '') : '',
    artist: artist,
    cover: cover,
    playing: !!audio && !!audio.src && !audio.paused && !audio.ended,
    positionSec: position,
    durationSec: duration,
    volume: typeof targetVolume === 'number' ? targetVolume : (audio ? audio.volume : 0),
    provider: song ? String(song.source || song.provider || '') : '',
    accent: miniPlayerAccentColors(),
  };
}

function miniPlayerPush() {
  var api = getMiniPlayerApi();
  if (!api) return;
  var payload = miniPlayerPayload();
  if (miniPlayerEnabled && typeof api.updateMiniPlayer === 'function') {
    Promise.resolve(api.updateMiniPlayer(payload)).then(function (ack) {
      // 组件窗口可能已被关闭（例如其自身的关闭按钮），据此收回本地开关状态
      if (ack && ack.ok === false && ack.enabled === false) miniPlayerSetEnabled(false);
    }).catch(function () {
      miniPlayerSetEnabled(false);
    });
  }
  // 贴边进度条复用同一帧状态，避免两条链路各算一份进度而漂移；
  // 它只在组件收起成贴边态时存在，主进程没在显示就直接回 enabled:false
  if (miniPlayerEnabled && typeof api.updateEdgeRail === 'function') {
    var railPayload = {
      title: payload.title,
      playing: payload.playing,
      positionSec: payload.positionSec,
      durationSec: payload.durationSec,
      hasMedia: !!(payload.title || payload.durationSec),
      accent: payload.accent,
    };
    Promise.resolve(api.updateEdgeRail(railPayload)).catch(function () {});
  }
}

function miniPlayerEnsureTimer() {
  var wantTimer = miniPlayerEnabled;
  if (wantTimer && !miniPlayerPushTimer) {
    // 500ms 上报一次，两个覆盖层各自用本地时钟补齐中间帧，主窗口这里不必更密
    miniPlayerPushTimer = setInterval(miniPlayerPush, 500);
    miniPlayerPush();
  } else if (!wantTimer && miniPlayerPushTimer) {
    clearInterval(miniPlayerPushTimer);
    miniPlayerPushTimer = null;
  }
}

function miniPlayerSetEnabled(next) {
  miniPlayerEnabled = !!next;
  miniPlayerEnsureTimer();
}

function miniPlayerApplySeek(ratio) {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  var target = Math.min(Math.max(Number(ratio) || 0, 0), 1) * audio.duration;
  try {
    audio.currentTime = target;
  } catch (e) {
    return;
  }
  if (typeof updateLyricsHighlight === 'function') updateLyricsHighlight();
  if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  miniPlayerPush();
}

function miniPlayerRunCommand(command) {
  var action = command && command.action;
  if (!action) return;
  try {
    if (action === 'toggle') {
      if (typeof togglePlay === 'function') togglePlay();
    } else if (action === 'next') {
      if (typeof nextTrack === 'function') nextTrack(true);
    } else if (action === 'prev') {
      if (typeof prevTrack === 'function') prevTrack(true);
    } else if (action === 'seek') {
      miniPlayerApplySeek(command.value);
    } else if (action === 'volume') {
      if (typeof setVolume === 'function') setVolume(command.value, true);
    }
  } catch (e) {
    console.warn('[MiniPlayer] command failed:', action, e);
  }
  miniPlayerPush();
}

function miniPlayerMarkButton(enabled) {
  var btn = document.getElementById('mini-player-btn');
  if (!btn) return;
  btn.classList.toggle('on', !!enabled);
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

function toggleMiniPlayer() {
  var api = getMiniPlayerApi();
  if (!api || typeof api.setMiniPlayerEnabled !== 'function') {
    if (typeof showToast === 'function') showToast('小组件需要桌面端运行');
    return;
  }
  var next = !miniPlayerEnabled;
  Promise.resolve(api.setMiniPlayerEnabled(next)).then(function (ack) {
    miniPlayerSetEnabled(next && !(ack && ack.ok === false));
    miniPlayerMarkButton(miniPlayerEnabled);
    if (ack && ack.ok === false && typeof showToast === 'function') showToast('小组件开启失败');
  }).catch(function () {
    miniPlayerSetEnabled(false);
    miniPlayerMarkButton(false);
  });
}

// 贴边进度条不是独立开关：它就是小组件收到屏边时的那个形态（主进程按 collapsed 派生）。
// 这里只保留"吸附到哪条边"的意图，边以主进程重算出来的 dock 为准。
var miniPlayerEdge = 'right';
// 右键换边按顺时针走：右 → 下 → 左 → 右（组件只支持这三条边）
var MINI_DOCK_EDGES = ['right', 'bottom', 'left'];
var MINI_DOCK_EDGE_NAMES = { left: '左', right: '右', bottom: '下' };

function miniPlayerApplyEdge(edge) {
  if (MINI_DOCK_EDGES.indexOf(edge) < 0) return;
  miniPlayerEdge = edge;
  if (typeof showToast === 'function') {
    showToast('贴边吸附到屏幕' + (MINI_DOCK_EDGE_NAMES[edge] || edge) + '边 · 收起后整条边就是进度条');
  }
}

function cycleMiniPlayerEdge() {
  var api = getMiniPlayerApi();
  if (!api || typeof api.setMiniPlayerView !== 'function') {
    if (typeof showToast === 'function') showToast('换边需要桌面端运行');
    return;
  }
  if (!miniPlayerEnabled) {
    if (typeof showToast === 'function') showToast('先点「贴边」打开小组件，再右键换边');
    return;
  }
  var next = MINI_DOCK_EDGES[(MINI_DOCK_EDGES.indexOf(miniPlayerEdge) + 1) % MINI_DOCK_EDGES.length];
  Promise.resolve(api.setMiniPlayerView({ collapsed: false, edge: next })).then(function (ack) {
    // 主进程会按真实工作区重算，回读它的结果而不是本地猜
    miniPlayerApplyEdge((ack && ack.edge) || next);
  }).catch(function () {});
}

// 兼容旧调用名：以前「边缘轨」是独立开关，现在它没有自己的开关
function cycleEdgeRailEdge() {
  cycleMiniPlayerEdge();
}

function bindMiniPlayerBridge() {
  var api = getMiniPlayerApi();
  if (!api) return;
  if (api.onMiniPlayerCommand && !miniPlayerCommandUnsub) {
    miniPlayerCommandUnsub = api.onMiniPlayerCommand(miniPlayerRunCommand);
  }
  if (api.onMiniPlayerEnabledState && !miniPlayerEnabledUnsub) {
    // 开关以主进程回推为准：任何非按钮入口（快捷键/托盘/命令行）打开组件时，这里也要跟着开始上报
    miniPlayerEnabledUnsub = api.onMiniPlayerEnabledState(function (state) {
      var enabled = !!(state && state.enabled);
      miniPlayerSetEnabled(enabled);
      miniPlayerMarkButton(enabled);
    });
  }
  if (api.onEdgeRailEnabledState && !edgeRailStateUnsub) {
    // 进度条出现/消失由主进程按组件贴边态决定，这里只同步它当前吸附在哪条边
    edgeRailStateUnsub = api.onEdgeRailEnabledState(function (state) {
      if (state && MINI_DOCK_EDGES.indexOf(state.edge) >= 0) miniPlayerEdge = state.edge;
    });
  }
}

function initMiniPlayerBridge() {
  ensureMiniPlayerButton();
  bindMiniPlayerBridge();
  miniPlayerMarkButton(miniPlayerEnabled);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMiniPlayerBridge, { once: true });
} else {
  initMiniPlayerBridge();
}

// 注入的那颗按钮用的是内联 onclick，走的是全局查找；这里显式挂一次，
// 免得哪天这个模块被改成 IIFE 包起来就点不动了
window.toggleMiniPlayer = toggleMiniPlayer;
window.cycleMiniPlayerEdge = cycleMiniPlayerEdge;
window.cycleEdgeRailEdge = cycleEdgeRailEdge;

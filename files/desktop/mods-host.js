// ============================================================
//  mineradio-mods 主进程宿主（上游 desktop/main.js 末尾只加了一行 require 到这里）
//
//  这里能拿到什么：`app` / `BrowserWindow` / `ipcMain` / `screen` / `globalShortcut`
//  都是同一份单例，所以外挂可以自己建窗口、自己注册通道，不需要上游让路。
//
//  拿不到什么（都是踩过才知道的）：
//   - mainWindow 这个变量是上游模块私有的 → 只能自己认："第一个加载
//     http://127.0.0.1:<后端端口>/ 且不带页面路径的 webContents 就是主窗口"。
//     外挂自己的窗口加载的是 /quick-search.html，路径不同，不会认错。
//   - 后端端口也不能直接读（mainServerPort 是私有的）→ 从主窗口的 URL 反解 origin。
//   - 上游"关主窗口=收进后台"那段判定里没有外挂窗口。所以这里改成：主窗口一关，
//     外挂窗口先收起来，免得一个看不见的浮窗把进程留在后台退不掉（这个坑我们真踩过）。
// ============================================================

'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');

const MARK = '[mods]';
const QUICK_SEARCH_PAGE = 'quick-search.html';
const QUICK_SEARCH_SIZE = { width: 502, height: 470 };
const CH = {
  open: 'mineradio-quick-search-open',
  setEnabled: 'mineradio-quick-search-set-enabled',
  query: 'mineradio-quick-search-query',
  results: 'mineradio-quick-search-results',
  command: 'mineradio-quick-search-command',
  close: 'mineradio-quick-search-close',
};

let overlay = null;
let overlayShownAt = 0;
let mainWindowContents = null;
let hotkey = process.env.MINERADIO_MODS_HOTKEY || 'CommandOrControl+Space';

function log(...args) { console.log(MARK, ...args); }
function warn(...args) { console.warn(MARK, ...args); }

function isOverlaySender(event) {
  try {
    return !!(event && event.sender && overlay && !overlay.isDestroyed() && event.sender === overlay.webContents);
  } catch (_) { return false; }
}

function isMainSender(event) {
  try {
    return !!(event && event.sender && mainWindowContents && !mainWindowContents.isDestroyed()
      && event.sender === mainWindowContents);
  } catch (_) { return false; }
}

// 后端端口与页面地址：从主窗口 URL 反解，不猜
function overlayUrl(page) {
  if (!mainWindowContents || mainWindowContents.isDestroyed()) return '';
  try {
    const url = new URL(mainWindowContents.getURL());
    if (!/^https?:$/.test(url.protocol)) return '';
    return `${url.origin}/${page}`;
  } catch (_) { return ''; }
}

function overlayBounds() {
  let display = null;
  if (overlay && !overlay.isDestroyed()) {
    try { display = screen.getDisplayMatching(overlay.getBounds()); } catch (_) { display = null; }
  }
  if (!display) { try { display = screen.getPrimaryDisplay(); } catch (_) { display = null; } }
  const area = (display && display.workAreaSize) || { width: 1280, height: 720 };
  const originX = (display && display.bounds && display.bounds.x) || 0;
  const originY = (display && display.bounds && display.bounds.y) || 0;
  return {
    width: QUICK_SEARCH_SIZE.width,
    height: QUICK_SEARCH_SIZE.height,
    x: Math.round(originX + (area.width - QUICK_SEARCH_SIZE.width) / 2),
    y: Math.round(originY + Math.max(48, area.height * 0.18)),
  };
}

function createOverlay() {
  const target = overlayUrl(QUICK_SEARCH_PAGE);
  if (!target) { warn('主窗口还没起来，浮窗暂时开不了'); return null; }
  overlay = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Quick Search',
    webPreferences: {
      preload: path.join(__dirname, 'mods-quick-search-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) { warn('置顶设置失败：' + e.message); }
  overlay.once('ready-to-show', () => {
    if (!overlay || overlay.isDestroyed()) return;
    overlayShownAt = Date.now();
    overlay.show();
    overlay.focus();
    overlay.webContents.send('mineradio-quick-search-state', { reset: true, shownAt: overlayShownAt });
  });
  // 透明窗口一失焦就收起来：这是"叫出来—用完就走"的浮窗，不是常驻面板
  overlay.on('blur', () => {
    if (!overlay || overlay.isDestroyed()) return;
    if (Date.now() - overlayShownAt < 400) return;
    hideOverlay('blur');
  });
  overlay.on('closed', () => { overlay = null; overlayShownAt = 0; });
  overlay.loadURL(target).catch((e) => warn('浮窗页面加载失败：' + (e && e.message)));
  return overlay;
}

function showOverlay() {
  if (overlay && !overlay.isDestroyed()) {
    if (!overlay.isVisible()) overlay.show();
    overlayShownAt = Date.now();
    overlay.focus();
    overlay.webContents.send('mineradio-quick-search-state', { reset: true, shownAt: overlayShownAt });
    return { ok: true, shown: false };
  }
  const created = createOverlay();
  return { ok: !!created, shown: !!created, creating: !!created };
}

function hideOverlay(reason) {
  if (!overlay || overlay.isDestroyed()) return { ok: true, alreadyHidden: true, reason };
  overlay.hide();
  return { ok: true, reason };
}

function toggleOverlay() {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) return hideOverlay('toggle');
  return showOverlay();
}

function forwardToMain(channel, payload) {
  if (!mainWindowContents || mainWindowContents.isDestroyed()) return false;
  mainWindowContents.send(channel, payload);
  return true;
}

function bindIpc() {
  // 主窗口渲染层 → 开关浮窗
  ipcMain.handle(CH.open, async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    return toggleOverlay();
  });
  // 浮窗自己（Esc / 选完一首）与主窗口都能开关它；来源仍然只认这两个 webContents
  ipcMain.handle(CH.setEnabled, async (event, enabled) => {
    if (!isOverlaySender(event) && !isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    return enabled === true ? showOverlay() : hideOverlay('ipc');
  });
  ipcMain.handle(CH.close, async (event) => {
    if (!isOverlaySender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    return hideOverlay('overlay');
  });
  // 浮窗打的字 + 选的平台 + 下钻的 bvid → 交给主窗口去搜（合并搜索与起播都在渲染层）
  ipcMain.handle(CH.query, async (event, payload) => {
    if (!isOverlaySender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const action = String((payload && payload.action) || 'search');
    const query = String((payload && payload.query) || '').trim().slice(0, 120);
    const radioId = String((payload && payload.radioId) || '').trim().slice(0, 96);
    const bvid = String((payload && payload.bvid) || '').trim().slice(0, 24);
    const mode = String((payload && payload.mode) || 'song').trim().slice(0, 24);
    const allowed = ['search', 'podcastPrograms', 'biliParts', 'more'];
    if (allowed.indexOf(action) < 0) return { ok: false, error: 'BAD_ACTION' };
    if (action === 'search' && !query) return { ok: false, error: 'EMPTY_QUERY' };
    if (action === 'podcastPrograms' && !radioId) return { ok: false, error: 'NO_RADIO_ID' };
    if (action === 'biliParts' && !bvid) return { ok: false, error: 'NO_BVID' };
    const delivered = forwardToMain(CH.query, {
      requestId: Number(payload && payload.requestId) || 0, action, query, radioId, bvid, mode,
    });
    return { ok: delivered, delivered };
  });
  // 主窗口搜完把结果原路送回浮窗
  ipcMain.handle(CH.results, async (event, payload) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    if (!overlay || overlay.isDestroyed()) return { ok: false, error: 'NO_OVERLAY' };
    overlay.webContents.send(CH.results, payload || {});
    return { ok: true };
  });
  // 歌曲对象原样透传：各源起播要看的字段不一样，白名单裁剪会把歌裁没
  ipcMain.handle(CH.command, async (event, payload) => {
    if (!isOverlaySender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const action = String((payload && payload.action) || '');
    if (action === 'setMode' || action === 'hello') {
      return { ok: forwardToMain(CH.command, { action, mode: String((payload && payload.mode) || '').slice(0, 24) }) };
    }
    const song = payload && payload.song;
    if (action !== 'play' || !song || typeof song !== 'object' || Array.isArray(song)) {
      return { ok: false, error: 'QUICK_SEARCH_COMMAND_REJECTED' };
    }
    return { ok: forwardToMain(CH.command, { action, song }) };
  });
}

function bindWindowTracking() {
  app.on('web-contents-created', (_event, contents) => {
    // 第一个"根地址"的页面就是主窗口：外挂自己的窗口带 /quick-search.html 路径，不会混
    if (mainWindowContents && !mainWindowContents.isDestroyed()) return;
    contents.on('did-navigate', (_e, url) => {
      if (mainWindowContents && !mainWindowContents.isDestroyed()) return;
      if (/^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(url)) {
        mainWindowContents = contents;
        bindIpc();
        registerHotkey();
      }
    });
  });
  // 主窗口关掉时浮窗先收起来：不然一个看不见的浮窗会让进程留在后台退不掉
  const onMainWindowClose = () => hideOverlay('main-window-closing');
  app.on('browser-window-blur', () => { });
  app.on('before-quit', () => {
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    try { globalShortcut.unregisterAll(); } catch (_) { }
  });
  app.on('browser-window-created', (event, win) => {
    win.on('close', () => { if (mainWindowContents && win.webContents === mainWindowContents) onMainWindowClose(); });
  });
}

function registerHotkey() {
  if (process.env.MINERADIO_MODS_HOTKEY === 'off') { log('全局热键按环境变量关掉了'); return; }
  try {
    if (globalShortcut.isRegistered(hotkey)) {
      warn(hotkey + ' 已经被占用（可能是软件自己的热键），外挂不再抢');
      return;
    }
    const ok = globalShortcut.register(hotkey, () => toggleOverlay());
    if (!ok) warn('全局热键 ' + hotkey + ' 注册失败');
    else log('已注册全局热键 ' + hotkey);
  } catch (e) { warn('全局热键注册异常：' + (e && e.message)); }
}

try {
  bindWindowTracking();
  if (app.isReady && app.isReady()) { /* 已经 ready：等 did-navigate 绑定即可 */ }
} catch (e) {
  warn('外挂宿主装载失败：' + ((e && e.message) || e));
}

module.exports = { overlayUrl, showOverlay, hideOverlay, toggleOverlay };

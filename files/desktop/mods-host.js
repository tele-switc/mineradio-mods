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

// Ctrl+H「历史记录与存档」的通道。前四个名字与开发仓库一致（渲染层那一份模块不用改），
// setLabel 是 2026-10-12 外挂版先加的：存档要能改名，而改名不能靠 remove + append，
// 那样会把这条挤到列表最前面、时间线就乱了。
const DA_CH = {
  read: 'mineradio-danger-archive-read',
  append: 'mineradio-danger-archive-append',
  remove: 'mineradio-danger-archive-remove',
  clear: 'mineradio-danger-archive-clear',
  setLabel: 'mineradio-danger-archive-set-label',
};

// 口味档案（个人数据 → 搜索个性化）的通道
const TASTE_CH = {
  read: 'mineradio-taste-profile-read',
  save: 'mineradio-taste-profile-save',
  clear: 'mineradio-taste-profile-clear',
};

let overlay = null;
let overlayShownAt = 0;
let mainWindowContents = null;
let hotkey = process.env.MINERADIO_MODS_HOTKEY || 'CommandOrControl+Space';
let dangerStore = null;
let tasteStore = null;
let widgets = null;

// 贴边组件与边缘进度轨的宿主（第四个、第五个外挂窗口）。拿不到上游的 mainWindow 变量，
// 所以把"主窗口是谁"与"页面地址怎么拼"这两件事作为上下文递过去。
function widgetHost() {
  if (widgets !== null) return widgets;
  try {
    const create = require('./mods-widget-host.js');
    widgets = create({
      getMainContents: () => (mainWindowContents && !mainWindowContents.isDestroyed() ? mainWindowContents : null),
      overlayUrl,
      isMainSender,
      log,
      warn,
    });
    widgets.bind();
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') log('没投放贴边组件那一族，跳过（mods-widget-host.js 不在）');
    else warn('贴边组件宿主装载失败：' + ((e && e.message) || e));
    widgets = false;
  }
  return widgets;
}

function log(...args) { console.log(MARK, ...args); }
function warn(...args) { console.warn(MARK, ...args); }

// 存档必须活在 localStorage 之外：它备份的正是 localStorage 里那三条记录，
// 放在同一个地方等于把钥匙和锁放同一个抽屉。路径用 userData（不是安装目录），
// 软件更新把 resources/app 整份换掉也动不到它。
function dangerArchiveStore() {
  if (dangerStore !== null) return dangerStore;
  try {
    const { DangerArchiveStore } = require('./mods-danger-archive-store.js');
    dangerStore = new DangerArchiveStore({ userDataPath: app.getPath('userData') });
  } catch (e) {
    warn('存档落盘层没就位，Ctrl+H 那一族会退回浏览器兜底存储：' + ((e && e.message) || e));
    dangerStore = false;
  }
  return dangerStore;
}

function tasteProfileStore() {
  if (tasteStore !== null) return tasteStore;
  try {
    const { TasteProfileStore } = require('./mods-taste-store.js');
    tasteStore = new TasteProfileStore({ userDataPath: app.getPath('userData') });
  } catch (e) {
    warn('口味档案落盘层没就位：' + ((e && e.message) || e));
    tasteStore = false;
  }
  return tasteStore;
}

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
  bindDangerArchiveIpc();
  bindTasteProfileIpc();
}

function bindDangerArchiveIpc() {
  const store = dangerArchiveStore();
  if (!store) return;
  // 五个口只认主窗口：这套东西能改写他的搜索记录、播放存档与聆听统计，
  // 不能让任何一个外挂页面（浮窗、贴边组件、进度轨）都调得动
  ipcMain.handle(DA_CH.read, async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.read();
    return res.ok ? { ok: true, archives: res.document.archives, file: res.file } : res;
  });
  ipcMain.handle(DA_CH.append, async (event, record) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, error: 'BAD_RECORD' };
    const res = store.append(record);
    return res.ok
      ? { ok: true, archives: res.document.archives, dropped: res.dropped || [], file: res.file }
      : res;
  });
  ipcMain.handle(DA_CH.remove, async (event, id) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.remove(String(id || ''));
    return res.ok ? { ok: true, archives: res.document.archives } : res;
  });
  // 改名：只动 label 一个字段，顺序与 id 都不变（所以不能用 remove + append 顶替）
  ipcMain.handle(DA_CH.setLabel, async (event, id, label) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.setLabel(String(id || ''), String(label == null ? '' : label));
    return res.ok ? { ok: true, archives: res.document.archives } : res;
  });
  ipcMain.handle(DA_CH.clear, async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.clear();
    return res.ok ? { ok: true, archives: res.document.archives } : res;
  });
  log('历史记录与存档（Ctrl+H）的落盘通道已就位：' + store.filePath);
}

function bindTasteProfileIpc() {
  const store = tasteProfileStore();
  if (!store) return;
  ipcMain.handle(TASTE_CH.read, async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.read();
    return res.ok ? { ok: true, profile: res.profile, file: res.file } : res;
  });
  ipcMain.handle(TASTE_CH.save, async (event, profile) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.save(profile);
    return res.ok ? { ok: true, profile: res.profile, file: res.file } : res;
  });
  ipcMain.handle(TASTE_CH.clear, async (event) => {
    if (!isMainSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
    const res = store.clear();
    return res.ok ? { ok: true, profile: res.profile, file: res.file } : res;
  });
  log('口味档案（搜索个性化）的落盘通道已就位：' + store.filePath);
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
        widgetHost();
        registerHotkey();
      }
    });
  });
  // 主窗口关掉时浮窗与贴边组件先收起来：不然一个看不见的浮窗会让进程留在后台退不掉
  const onMainWindowClose = () => {
    hideOverlay('main-window-closing');
    const w = widgetHost();
    if (w) w.hideForMainWindowClose();
  };
  app.on('browser-window-blur', () => { });
  app.on('before-quit', () => {
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    const w = widgetHost();
    if (w) w.closeAll();
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

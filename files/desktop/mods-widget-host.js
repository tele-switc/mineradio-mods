// ============================================================
//  mineradio-mods 贴边组件宿主（主进程侧）：贴边播放小组件 + 屏幕边缘进度轨
//
//  这是外挂自己建的第二、第三个窗口（浮窗是第一先例）。上游 main.js 里那两个
//  子系统被逐字搬过来了，只改了四处"外挂拿不到什么"：
//   - `mainWindow` 是上游模块私有的 → 自己从主窗口的 webContents 反查 BrowserWindow
//   - `getDisplayArea()` 是上游私有的 → 这里就两行，自己实现一份（口径一致）
//   - `focusMainWindow()` 上游那一版还要处理桌面模式/缩放/状态广播 → 外挂只做
//     "最小化就还原、藏着就叫出来、然后夺焦点"这三件用得上的事
//   - 预加载用 `mods-widget-preload.js`（上游那份 overlay-preload.js 里没有这两个
//     窗口的通道，而它是上游文件，更新会换掉）
//
//  贴边进度轨不是第二个开关：它就是小组件"收到屏边"的那个形态，两个窗口的显示
//  都由 miniPlayerState.collapsed 派生，谁都不单独记一份状态（与开发版同口径）。
//
//  吸附几何与状态规范化的纯逻辑在 mods-mini-player-runtime.js 里，那份不依赖 Electron。
// ============================================================

'use strict';

module.exports = function create(ctx) {
  const { BrowserWindow, ipcMain, screen } = require('electron');
  const path = require('node:path');
  const R = require('./mods-mini-player-runtime.js');
  const {
    dockGeometry, frameFor, resolveEdge, normalizeState, normalizeCommand,
    railGeometry, railBandHit, normalizeRailState, normalizeRailCommand, isVerticalRail,
    MINI_PLAYER_DOCK_EDGES,
  } = Object.assign({ MINI_PLAYER_DOCK_EDGES: R.EDGES }, R);

  const log = ctx.log || (() => { });
  const warn = ctx.warn || ((...a) => console.warn('[mods:widget]', ...a));
  const PRELOAD = path.join(__dirname, 'mods-widget-preload.js');

  let miniPlayerWindow = null;
  let miniPlayerState = normalizeState({});
  let miniPlayerDock = null;
  let miniPlayerSnapTimer = null;
  let edgeRailWindow = null;
  let edgeRailState = normalizeRailState({});
  let edgeRailGeo = null;
  let edgeRailPointerCapture = false;
  let edgeRailMouseIgnored = null;
  let bound = false;

  // 主窗口的 BrowserWindow：只认"第一个加载后端根地址的那个 webContents"
  function mainWindow() {
    try {
      const contents = ctx.getMainContents && ctx.getMainContents();
      if (!contents || contents.isDestroyed()) return null;
      const win = BrowserWindow.fromWebContents(contents);
      return win && !win.isDestroyed() ? win : null;
    } catch (_) { return null; }
  }

  function getDisplayArea(display) {
    return (display && (display.workArea || display.bounds)) || screen.getPrimaryDisplay().workArea;
  }

  // ---------- 贴边小组件 ----------

  function miniPlayerWorkArea() {
    let bounds = null;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      try { bounds = miniPlayerWindow.getBounds(); } catch (_) { bounds = null; }
    }
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
    return display.workArea;
  }

  function sameFrame(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2
      && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  }

  function sendMiniPlayerState() {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
    miniPlayerWindow.webContents.send('mineradio-mini-player-state', miniPlayerState);
  }

  // 开关状态以主进程为准回推给主窗口：渲染层自己记一份会与任何非按钮入口失步，
  // 失步后它不再上报播放状态，组件就会永远停在"未在播放"。
  function broadcastMiniPlayerEnabledState(enabled) {
    const win = mainWindow();
    if (!win) return;
    win.webContents.send('mineradio-mini-player-enabled-state', { enabled: !!enabled });
  }

  function applyMiniPlayerFrame() {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed() || !miniPlayerDock) return;
    const frame = frameFor(miniPlayerDock, !!miniPlayerState.collapsed);
    // setBounds 自身会触发 moved，尺寸没变就直接返回，避免和吸附逻辑互相打摆
    if (sameFrame(miniPlayerWindow.getBounds(), frame)) { sendMiniPlayerState(); syncEdgeRailDockState(); return; }
    try {
      miniPlayerWindow.setBounds(frame);
    } catch (e) {
      warn('[MiniPlayer] setBounds failed: ' + e.message);
    }
    sendMiniPlayerState();
    syncEdgeRailDockState();
  }

  function syncEdgeRailDockState() {
    const widgetAlive = miniPlayerWindow && !miniPlayerWindow.isDestroyed();
    const docked = !!miniPlayerState.enabled && !!miniPlayerState.collapsed;
    if (docked) {
      if (widgetAlive && miniPlayerWindow.isVisible()) {
        try { miniPlayerWindow.hide(); } catch (_) { }
      }
      if (!edgeRailWindow || edgeRailWindow.isDestroyed()) {
        createEdgeRailWindow({ edge: miniPlayerState.edge });
        return;
      }
      applyEdgeRailGeometry();
      edgeRailPointerCapture = false;
      applyEdgeRailMouseBehavior();
      try { edgeRailWindow.showInactive(); } catch (_) { }
      return;
    }
    if (edgeRailWindow && !edgeRailWindow.isDestroyed()) {
      // 只有"因为贴边而被我们藏起来"的组件才需要在这里放回来。
      // 无条件 show 会把刚创建、还没 ready-to-show 的组件窗口提前弹成一块白板。
      const railWasVisible = edgeRailWindow.isVisible();
      if (railWasVisible) {
        edgeRailPointerCapture = false;
        applyEdgeRailMouseBehavior();
        try { edgeRailWindow.hide(); } catch (_) { }
        if (widgetAlive && !miniPlayerWindow.isVisible()) {
          try { miniPlayerWindow.showInactive(); } catch (_) { }
        }
      }
    }
  }

  function scheduleMiniPlayerSnap() {
    if (miniPlayerSnapTimer) clearTimeout(miniPlayerSnapTimer);
    miniPlayerSnapTimer = setTimeout(() => {
      miniPlayerSnapTimer = null;
      if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
      const workArea = miniPlayerWorkArea();
      const edge = resolveEdge(miniPlayerWindow.getBounds(), workArea);
      miniPlayerDock = dockGeometry(edge, workArea);
      miniPlayerState = { ...miniPlayerState, edge: miniPlayerDock.edge, collapsed: false };
      applyMiniPlayerFrame();
    }, 200);
  }

  function createMiniPlayerWindow(payload) {
    miniPlayerState = normalizeState({ ...miniPlayerState, ...payload, enabled: true });
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      broadcastMiniPlayerEnabledState(true);
      applyMiniPlayerFrame();
      return miniPlayerWindow;
    }
    const workArea = miniPlayerWorkArea();
    miniPlayerDock = dockGeometry(miniPlayerState.edge, workArea);
    miniPlayerState = { ...miniPlayerState, edge: miniPlayerDock.edge };
    miniPlayerWindow = new BrowserWindow({
      ...frameFor(miniPlayerDock, miniPlayerState.collapsed),
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
      title: 'Mineradio Mini Player',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    try {
      miniPlayerWindow.setAlwaysOnTop(true, 'screen-saver');
      miniPlayerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      warn('[MiniPlayer] topmost setup skipped: ' + e.message);
    }
    miniPlayerWindow.once('ready-to-show', () => {
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
        miniPlayerWindow.showInactive();
        sendMiniPlayerState();
        broadcastMiniPlayerEnabledState(true);
      }
    });
    miniPlayerWindow.webContents.once('did-finish-load', sendMiniPlayerState);
    miniPlayerWindow.on('moved', scheduleMiniPlayerSnap);
    miniPlayerWindow.on('closed', () => {
      miniPlayerWindow = null;
      miniPlayerDock = null;
      if (miniPlayerSnapTimer) {
        clearTimeout(miniPlayerSnapTimer);
        miniPlayerSnapTimer = null;
      }
      broadcastMiniPlayerEnabledState(false);
    });
    // 这个窗口是"贴边"而不是"关掉了"：hide 型窗口只判存在会让程序退不掉，
    // 所以退出前由 mods-host 的 before-quit 统一 destroy（见那边 closeAll）。
    miniPlayerWindow.loadURL(ctx.overlayUrl('mini-player.html')).catch((e) => {
      warn('[MiniPlayer] load failed: ' + e.message);
    });
    return miniPlayerWindow;
  }

  function closeMiniPlayerWindow() {
    miniPlayerState = { ...miniPlayerState, enabled: false, collapsed: false };
    // 进度条是组件的贴边态，组件关了它就没有存在的理由
    if (edgeRailWindow && !edgeRailWindow.isDestroyed()) edgeRailWindow.close();
    edgeRailWindow = null;
    edgeRailGeo = null;
    edgeRailState = { ...edgeRailState, enabled: false };
    broadcastEdgeRailEnabledState(false);
    const hadWindow = miniPlayerWindow && !miniPlayerWindow.isDestroyed();
    if (hadWindow) miniPlayerWindow.close();
    miniPlayerWindow = null;
    miniPlayerDock = null;
    if (!hadWindow) broadcastMiniPlayerEnabledState(false);
  }

  function forwardMiniPlayerCommand(command) {
    const win = mainWindow();
    if (!win) return false;
    win.webContents.send('mineradio-mini-player-command', command);
    return true;
  }

  // 点组件是明确的用户意图：最小化就还原、收进后台就叫出来，然后夺焦点。
  // （上游那个 focusMainWindow 还要处理桌面模式与缩放，外挂这里用不上，也就不去猜。）
  function focusMainWindow() {
    const win = mainWindow();
    if (!win) return false;
    try {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      return true;
    } catch (e) {
      warn('叫出主窗口失败：' + ((e && e.message) || e));
      return false;
    }
  }

  // ---------- 屏幕边缘进度轨 ----------

  function edgeRailWorkArea() {
    let display = null;
    if (edgeRailWindow && !edgeRailWindow.isDestroyed()) {
      try { display = screen.getDisplayMatching(edgeRailWindow.getBounds()); } catch (_) { display = null; }
    }
    return getDisplayArea(display || screen.getPrimaryDisplay());
  }

  function sendEdgeRailState() {
    if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return;
    edgeRailWindow.webContents.send('mineradio-edge-rail-state', edgeRailState);
  }

  // 窗口横截面被 Windows 夹到 ~36px，直接吃鼠标会在屏幕边上留一条假命中区挡住桌面。
  // 所以默认整窗穿透（forward 保留 hover），只有组件页面判定指针落在最外侧那条窄带里
  // 才临时接管点击。
  function applyEdgeRailMouseBehavior() {
    if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return;
    const shouldIgnore = !edgeRailPointerCapture;
    if (edgeRailMouseIgnored === shouldIgnore) return;
    edgeRailMouseIgnored = shouldIgnore;
    try {
      edgeRailWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    } catch (e) {
      warn('[EdgeRail] setIgnoreMouseEvents failed: ' + e.message);
    }
  }

  function edgeRailRect(geo) {
    return { x: geo.x, y: geo.y, width: geo.width, height: geo.height };
  }

  function edgeRailMatches(geo) {
    if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return true;
    const c = edgeRailWindow.getBounds();
    return Math.abs(c.x - geo.x) <= 1 && Math.abs(c.y - geo.y) <= 1
      && Math.abs(c.width - geo.width) <= 1 && Math.abs(c.height - geo.height) <= 1;
  }

  // 两遍定位：第一遍按请求值摆，第二遍用 Windows 夹完之后的真实内容横截面对外沿重算。
  // 必须两遍的原因实测过：底轨请求 34 高，系统给到 38 却不跟着挪 y，于是整窗往屏幕外
  // 溢 4 DIP，条子被切掉一半；150% 缩放下 DIP↔物理像素取整还会在最外沿留 1 物理像素缝，
  // 所以再往屏幕外推 bleed，由页面用 --bleed 把条子内缩回屏幕边界。
  function applyEdgeRailGeometry() {
    if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return;
    const area = edgeRailWorkArea();
    let geo = railGeometry(edgeRailState.edge, area, edgeRailState.thickness);
    if (!edgeRailMatches(geo)) {
      try { edgeRailWindow.setBounds(edgeRailRect(geo)); } catch (e) { warn('[EdgeRail] setBounds failed: ' + e.message); }
    }
    let content = null;
    try { content = edgeRailWindow.getContentBounds(); } catch (_) { content = null; }
    if (content) {
      const actualCross = Math.round(isVerticalRail(geo.edge) ? content.width : content.height) || 0;
      geo = railGeometry(geo.edge, area, edgeRailState.thickness, { actualCross });
      if (!edgeRailMatches(geo)) {
        try { edgeRailWindow.setBounds(edgeRailRect(geo)); } catch (e) { warn('[EdgeRail] setBounds failed: ' + e.message); }
      }
    }
    let after = null;
    try { after = edgeRailWindow.getContentBounds(); } catch (_) { after = null; }
    edgeRailGeo = geo;
    edgeRailState = {
      ...edgeRailState,
      edge: geo.edge,
      geo: {
        edge: geo.edge,
        bleed: geo.bleed,
        visualThickness: geo.visualThickness,
        cross: Math.round(isVerticalRail(geo.edge) ? (after && after.width) || geo.width : (after && after.height) || geo.height),
        screen: { x: area.x, y: area.y, width: area.width, height: area.height },
        content: after || null,
      },
    };
    sendEdgeRailState();
  }

  let screenReflowBound = null;
  function createEdgeRailWindow(payload) {
    edgeRailState = normalizeRailState({ ...edgeRailState, ...payload, enabled: true });
    if (edgeRailWindow && !edgeRailWindow.isDestroyed()) {
      broadcastEdgeRailEnabledState(true);
      applyEdgeRailGeometry();
      return edgeRailWindow;
    }
    edgeRailGeo = railGeometry(edgeRailState.edge, edgeRailWorkArea(), edgeRailState.thickness);
    edgeRailState = { ...edgeRailState, edge: edgeRailGeo.edge };
    edgeRailWindow = new BrowserWindow({
      x: edgeRailGeo.x,
      y: edgeRailGeo.y,
      width: edgeRailGeo.width,
      height: edgeRailGeo.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      skipTaskbar: true,
      show: false,
      title: 'Mineradio Edge Rail',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    try {
      // screen-saver 层级：盖在任务栏与全屏提示之上，才像"屏幕自己的进度条"
      edgeRailWindow.setAlwaysOnTop(true, 'screen-saver');
      edgeRailWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (e) {
      warn('[EdgeRail] topmost setup skipped: ' + e.message);
    }
    applyEdgeRailGeometry();
    edgeRailWindow.once('ready-to-show', () => {
      if (edgeRailWindow && !edgeRailWindow.isDestroyed()) {
        edgeRailWindow.showInactive();
        edgeRailPointerCapture = false;
        edgeRailMouseIgnored = null;
        applyEdgeRailMouseBehavior();
        sendEdgeRailState();
        broadcastEdgeRailEnabledState(true);
      }
    });
    edgeRailWindow.webContents.once('did-finish-load', () => {
      applyEdgeRailMouseBehavior();
      sendEdgeRailState();
    });
    // 分辨率/任务栏变化后重算，保证它始终"铺满整条边"
    const reflow = () => applyEdgeRailGeometry();
    if (!screenReflowBound) {
      screenReflowBound = reflow;
      screen.on('display-metrics-changed', reflow);
      screen.on('display-added', reflow);
      screen.on('display-removed', reflow);
    }
    edgeRailWindow.on('closed', () => {
      edgeRailWindow = null;
      edgeRailGeo = null;
      if (screenReflowBound) {
        const fn = screenReflowBound;
        screenReflowBound = null;
        try {
          screen.removeListener('display-metrics-changed', fn);
          screen.removeListener('display-added', fn);
          screen.removeListener('display-removed', fn);
        } catch (_) { }
      }
      broadcastEdgeRailEnabledState(false);
    });
    edgeRailWindow.loadURL(ctx.overlayUrl('edge-rail.html')).catch((e) => {
      warn('[EdgeRail] load failed: ' + e.message);
    });
    return edgeRailWindow;
  }

  function closeEdgeRailWindow() {
    edgeRailState = { ...edgeRailState, enabled: false };
    const had = edgeRailWindow && !edgeRailWindow.isDestroyed();
    if (had) edgeRailWindow.close();
    edgeRailWindow = null;
    edgeRailGeo = null;
    if (!had) broadcastEdgeRailEnabledState(false);
  }

  function broadcastEdgeRailEnabledState(enabled) {
    const win = mainWindow();
    if (!win) return;
    win.webContents.send('mineradio-edge-rail-enabled-state', {
      enabled: !!enabled,
      edge: edgeRailState.edge,
    });
  }

  // ---------- 通道 ----------

  function isMiniSender(event) {
    try {
      return !!(event && event.sender && miniPlayerWindow && !miniPlayerWindow.isDestroyed()
        && event.sender === miniPlayerWindow.webContents);
    } catch (_) { return false; }
  }

  function isRailSender(event) {
    try {
      return !!(event && event.sender && edgeRailWindow && !edgeRailWindow.isDestroyed()
        && event.sender === edgeRailWindow.webContents);
    } catch (_) { return false; }
  }

  // 主窗口与两个组件窗口都能开关组件（组件自己的关闭按钮也算一次开关）
  function isWidgetCommandSender(event) {
    return ctx.isMainSender(event) || isMiniSender(event) || isRailSender(event);
  }

  function bind() {
    if (bound) return;
    bound = true;

    ipcMain.handle('mineradio-mini-player-set-enabled', async (event, enabled, payload) => {
      if (!isWidgetCommandSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      try {
        if (enabled) createMiniPlayerWindow(payload || {});
        else closeMiniPlayerWindow();
        return { ok: true, enabled: !!enabled };
      } catch (e) {
        return { ok: false, error: e.message || 'MINI_PLAYER_TOGGLE_FAILED' };
      }
    });

    ipcMain.handle('mineradio-mini-player-update', async (event, payload) => {
      if (!isWidgetCommandSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return { ok: false, enabled: false };
      const incoming = payload || {};
      const prevCollapsed = miniPlayerState.collapsed;
      const prevEdge = miniPlayerState.edge;
      // 视图意图（收起/固定/吸附边）以组件侧为准，播放状态以渲染层为准
      miniPlayerState = normalizeState({
        ...miniPlayerState,
        ...incoming,
        enabled: true,
        collapsed: typeof incoming.collapsed === 'boolean' ? incoming.collapsed : prevCollapsed,
        pinned: typeof incoming.pinned === 'boolean' ? incoming.pinned : miniPlayerState.pinned,
        edge: incoming.edge || prevEdge,
      });
      if (miniPlayerState.edge !== prevEdge) {
        miniPlayerDock = dockGeometry(miniPlayerState.edge, miniPlayerWorkArea());
        miniPlayerState = { ...miniPlayerState, edge: miniPlayerDock.edge };
      }
      if (miniPlayerState.collapsed !== prevCollapsed || miniPlayerState.edge !== prevEdge) {
        applyMiniPlayerFrame();
      } else {
        sendMiniPlayerState();
      }
      return { ok: true, collapsed: miniPlayerState.collapsed, edge: miniPlayerState.edge };
    });

    ipcMain.handle('mineradio-mini-player-set-view', async (event, view) => {
      if (!isWidgetCommandSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      const v = view || {};
      const wantEdge = String(v.edge || '');
      if (MINI_PLAYER_DOCK_EDGES.includes(wantEdge) && wantEdge !== miniPlayerState.edge
        && miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
        // 换吸附边以主进程重算为准：组件侧只表达意图，真实工作区与夹取尺寸都在这里
        miniPlayerDock = dockGeometry(wantEdge, miniPlayerWorkArea());
      }
      miniPlayerState = {
        ...miniPlayerState,
        edge: miniPlayerDock ? miniPlayerDock.edge : miniPlayerState.edge,
        collapsed: !!v.collapsed,
        pinned: typeof v.pinned === 'boolean' ? v.pinned : miniPlayerState.pinned,
      };
      applyMiniPlayerFrame();
      return {
        ok: true,
        collapsed: miniPlayerState.collapsed,
        pinned: miniPlayerState.pinned,
        edge: miniPlayerState.edge,
      };
    });

    ipcMain.handle('mineradio-mini-player-command', async (event, payload) => {
      if (!isMiniSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      const command = normalizeCommand(payload);
      if (!command) return { ok: false, error: 'MINI_PLAYER_COMMAND_REJECTED' };
      if (command.action === 'focus-main') return { ok: focusMainWindow() };
      return { ok: forwardMiniPlayerCommand(command) };
    });

    ipcMain.handle('mineradio-edge-rail-set-enabled', async (event, enabled, payload) => {
      if (!isWidgetCommandSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      try {
        if (enabled) createEdgeRailWindow(payload || {});
        else closeEdgeRailWindow();
        return { ok: true, enabled: !!enabled };
      } catch (e) {
        return { ok: false, error: e.message || 'EDGE_RAIL_TOGGLE_FAILED' };
      }
    });

    ipcMain.handle('mineradio-edge-rail-update', async (event, payload) => {
      if (!isWidgetCommandSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return { ok: false, enabled: false };
      const incoming = payload || {};
      const prevEdge = edgeRailState.edge;
      const prevThickness = edgeRailState.thickness;
      // 进度条吸附的边永远跟着组件，不在这里另记一份边
      const railEdge = (miniPlayerWindow && !miniPlayerWindow.isDestroyed())
        ? miniPlayerState.edge
        : (incoming.edge || prevEdge);
      edgeRailState = normalizeRailState({ ...edgeRailState, ...incoming, edge: railEdge, enabled: true });
      // 只有吸附边或厚度变了才需要重算窗口几何，进度更新走消息即可
      if (edgeRailState.edge !== prevEdge || edgeRailState.thickness !== prevThickness) applyEdgeRailGeometry();
      else sendEdgeRailState();
      return { ok: true, enabled: true, edge: edgeRailState.edge };
    });

    ipcMain.handle('mineradio-edge-rail-set-edge', async (event, edge) => {
      if (!isRailSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      if (!edgeRailWindow || edgeRailWindow.isDestroyed()) return { ok: false, enabled: false };
      edgeRailState = { ...edgeRailState, edge: String(edge || '') };
      applyEdgeRailGeometry();
      return { ok: true, edge: edgeRailState.edge };
    });

    // 边缘轨只允许 seek：它是一条进度条，不是第二个控制面板
    ipcMain.handle('mineradio-edge-rail-set-pointer-capture', async (event, active) => {
      if (!isRailSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      edgeRailPointerCapture = !!active;
      applyEdgeRailMouseBehavior();
      return { ok: true, capturing: edgeRailPointerCapture };
    });

    // 页面只上报指针坐标，命中规则在这里判定——规则只有一份，不会两端漂移
    ipcMain.handle('mineradio-edge-rail-pointer', async (event, point) => {
      if (!isRailSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      const capture = railBandHit(edgeRailState, edgeRailGeo, point || {});
      if (capture !== edgeRailPointerCapture) {
        edgeRailPointerCapture = capture;
        applyEdgeRailMouseBehavior();
      }
      // 指针落到屏边窄带 = 用户要把组件叫回来，进度条随即收回、组件窗口顶上
      if (capture && miniPlayerState.collapsed) {
        miniPlayerState = { ...miniPlayerState, collapsed: false };
        applyMiniPlayerFrame();
      }
      return { ok: true, capture };
    });

    ipcMain.handle('mineradio-edge-rail-command', async (event, payload) => {
      if (!isRailSender(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };
      const command = normalizeRailCommand(payload);
      if (!command || command.value < 0) return { ok: false, error: 'EDGE_RAIL_COMMAND_REJECTED' };
      const win = mainWindow();
      if (!win) return { ok: false, error: 'EDGE_RAIL_NO_MAIN_WINDOW' };
      win.webContents.send('mineradio-mini-player-command', { action: 'seek', value: command.value });
      return { ok: true };
    });

    log('贴边组件与边缘进度轨的通道已就位');
  }

  // 退出前必须把这两个窗口 destroy 掉：它们是"贴边"而不是"关掉"，
  // 只判窗口存在会让进程留在后台退不掉（这个坑踩过，见 README 的已知限制）
  function closeAll() {
    try { if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) miniPlayerWindow.destroy(); } catch (_) { }
    try { if (edgeRailWindow && !edgeRailWindow.isDestroyed()) edgeRailWindow.destroy(); } catch (_) { }
    miniPlayerWindow = null;
    edgeRailWindow = null;
  }

  // 主窗口关掉（收进后台）时组件自己收起，与浮窗同一口径
  function hideForMainWindowClose() {
    try {
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed() && miniPlayerWindow.isVisible()) miniPlayerWindow.hide();
      if (edgeRailWindow && !edgeRailWindow.isDestroyed() && edgeRailWindow.isVisible()) edgeRailWindow.hide();
    } catch (_) { }
  }

  function state() {
    return {
      mini: { ...miniPlayerState },
      rail: { ...edgeRailState, geo: edgeRailGeo || null },
    };
  }

  return { bind, closeAll, hideForMainWindowClose, state };
};

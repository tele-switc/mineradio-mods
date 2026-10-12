// ============================================================
//  mineradio-mods：贴边组件与边缘进度轨这两个窗口的预加载桥接
//
//  上游那份 overlay-preload.js 里没有这两个窗口的通道，而它是上游文件（更新会换掉），
//  所以外挂自己建窗口时配自己这份预加载。暴露的名字仍然叫 desktopOverlay：
//  mini-player.html 与 edge-rail.html 是照开发仓库那份原样搬的，页面里问的就是这个名字。
// ============================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function bind(channel, callback) {
  if (typeof callback !== 'function') return () => { };
  const listener = (_event, payload) => callback(payload || {});
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopOverlay', {
  isMineradioModsWidget: true,
  // 贴边小组件
  onMiniPlayerState: (callback) => bind('mineradio-mini-player-state', callback),
  miniPlayerCommand: (action, value) => ipcRenderer.invoke('mineradio-mini-player-command', { action, value }),
  miniPlayerSetView: (view) => ipcRenderer.invoke('mineradio-mini-player-set-view', view || {}),
  miniPlayerUpdate: (payload) => ipcRenderer.invoke('mineradio-mini-player-update', payload || {}),
  miniPlayerClose: () => ipcRenderer.invoke('mineradio-mini-player-set-enabled', false, {}),
  // 屏幕边缘进度轨
  onRailState: (callback) => bind('mineradio-edge-rail-state', callback),
  railSeek: (ratio) => ipcRenderer.invoke('mineradio-edge-rail-command', { action: 'seek', value: ratio }),
  railSetCapture: (active) => ipcRenderer.invoke('mineradio-edge-rail-set-pointer-capture', !!active),
  railPointer: (x, y) => ipcRenderer.invoke('mineradio-edge-rail-pointer', { x, y }),
  railSetEdge: (edge) => ipcRenderer.invoke('mineradio-edge-rail-set-edge', String(edge || '')),
});

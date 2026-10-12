// mineradio-mods：主窗口预加载桥接
// 为什么这一整段要内联在 desktop/preload.js 里而不是 require 一个外挂文件：
// 主窗口的 webPreferences.sandbox 是 true，沙箱预加载只能 require('electron')，
// 读不了磁盘上的外挂文件；而 contextBridge 暴露出去的对象一旦生成就冻结了，
// 事后也没法往 desktopWindow 上补方法。所以桥接必须在这里加一段。
// 名字用新的 desktopMods，不碰上游的 desktopWindow（避免重名 expose 失败）。
(function () {
  var electron = require('electron');
  var contextBridge = electron.contextBridge;
  var ipcRenderer = electron.ipcRenderer;
  if (!contextBridge || !ipcRenderer || !contextBridge.exposeInMainWorld) return;

  function bind(channel, callback) {
    if (typeof callback !== 'function') return function () { };
    var listener = function (_event, payload) { callback(payload || {}); };
    ipcRenderer.on(channel, listener);
    return function () { ipcRenderer.removeListener(channel, listener); };
  }

  contextBridge.exposeInMainWorld('desktopMods', {
    isMineradioMods: true,
    openQuickSearch: function () { return ipcRenderer.invoke('mineradio-quick-search-open'); },
    setQuickSearchEnabled: function (on) { return ipcRenderer.invoke('mineradio-quick-search-set-enabled', on === true); },
    sendQuickSearchResults: function (payload) { return ipcRenderer.invoke('mineradio-quick-search-results', payload || {}); },
    onQuickSearchQuery: function (callback) { return bind('mineradio-quick-search-query', callback); },
    onQuickSearchCommand: function (callback) { return bind('mineradio-quick-search-command', callback); },
    // Ctrl+H「清空与存档」：存档落在 userData 的 JSON 里，渲染层只管界面与状态捕获
    readDangerArchives: function () { return ipcRenderer.invoke('mineradio-danger-archive-read'); },
    appendDangerArchive: function (record) { return ipcRenderer.invoke('mineradio-danger-archive-append', record || {}); },
    removeDangerArchive: function (id) { return ipcRenderer.invoke('mineradio-danger-archive-remove', String(id || '')); },
    clearDangerArchives: function () { return ipcRenderer.invoke('mineradio-danger-archive-clear'); },
    // 贴边小组件与屏幕边缘进度轨：主窗口这一侧是状态来源，两个组件窗口只是它的另一种画法
    setMiniPlayerEnabled: function (on, view) { return ipcRenderer.invoke('mineradio-mini-player-set-enabled', on === true, view || {}); },
    updateMiniPlayer: function (payload) { return ipcRenderer.invoke('mineradio-mini-player-update', payload || {}); },
    setMiniPlayerView: function (view) { return ipcRenderer.invoke('mineradio-mini-player-set-view', view || {}); },
    updateEdgeRail: function (payload) { return ipcRenderer.invoke('mineradio-edge-rail-update', payload || {}); },
    onMiniPlayerCommand: function (callback) { return bind('mineradio-mini-player-command', callback); },
    onMiniPlayerEnabledState: function (callback) { return bind('mineradio-mini-player-enabled-state', callback); },
    onEdgeRailEnabledState: function (callback) { return bind('mineradio-edge-rail-enabled-state', callback); },
  });
})();

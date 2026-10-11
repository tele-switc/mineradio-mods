// ============================================================
//  快速搜索浮窗自己的 preload（外挂窗口用，上游的 overlay-preload.js 一个字都不用改）
//
//  暴露的名字与软件原版给浮窗用的那套**完全同名**（desktopOverlay.*），
//  所以 public/quick-search.html 可以直接复用，不用为外挂做第二个版本。
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

function bind(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload || {});
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopOverlay', {
  isMineradioMods: true,
  quickSearchQuery: (payload) => ipcRenderer.invoke('mineradio-quick-search-query', payload || {}),
  quickSearchPlay: (song) => ipcRenderer.invoke('mineradio-quick-search-command', { action: 'play', song }),
  quickSearchCommand: (payload) => ipcRenderer.invoke('mineradio-quick-search-command', payload || {}),
  quickSearchClose: () => ipcRenderer.invoke('mineradio-quick-search-close'),
  onQuickSearchResults: (callback) => bind('mineradio-quick-search-results', callback),
  onQuickSearchState: (callback) => bind('mineradio-quick-search-state', callback),
});

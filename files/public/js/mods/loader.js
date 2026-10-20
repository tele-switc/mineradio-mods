// ============================================================
//  mineradio-mods 渲染层装载器（上游 index-loader.js 里只加了一行指向这里）
//
//  为什么还要再套一层：这样"以后又写了个外挂"只改这个文件里的清单，
//  不再去动上游的 index-loader.js —— 上游更新时会被换掉的就是那五个文件，
//  少动一处就少一处会丢的东西。
//
//  清单里的路径相对 public/（和上游模块同一个基准）。任何一个加载失败都只是跳过，
//  绝不 throw：外挂少一个文件不能让播放器的界面整个白屏。
// ============================================================
(function mineradioModsLoader() {
  'use strict';

  var MODS = [
    'js/mods/05-sources.js',
    'js/mods/10-quick-search-host.js',
    'js/mods/20-bili-collection.js',
    'js/mods/30-danger-archive.js',
    'js/mods/40-widgets.js',
    'js/mods/50-provider-fallback.js',
    'js/mods/60-taste-profile.js',
  ];

  function read(path) {
    try {
      var request = new XMLHttpRequest();
      request.open('GET', path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now(), false);
      request.send(null);
      if (request.status && (request.status < 200 || request.status >= 300)) return '';
      return request.responseText || '';
    } catch (e) {
      return '';
    }
  }

  var code = [];
  MODS.forEach(function (path) {
    var text = read(path);
    if (!text) { console.warn('[mods] 跳过加载不到的外挂模块：' + path); return; }
    code.push('/* mineradio-mods: ' + path + ' */\n' + text);
  });
  if (!code.length) return;

  // 与上游一样拼成**一个** classic script：这样外挂模块顶层的 function/var 也是全局的，
  // 后面的外挂能包装前面的；而应用自己的顶层函数本来也挂在 window 上，可以直接包。
  var script = document.createElement('script');
  script.text = code.join('\n;\n') + '\n//# sourceURL=mineradio-mods-modules.js\n';
  document.head.appendChild(script);
})();

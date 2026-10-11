#!/usr/bin/env node
// ============================================================
//  干净实例端到端真验：上游原版 2.2.0 + 只装外挂包，跑真窗口
//
//  装完外挂不等于能用。这个脚本要证明的是："别人拿到原版 + 这个包，
//  一条命令装完就能用" —— 所以它跑的是**没被我们改过的上游代码**，
//  外挂只通过 6 个锚点与投放的文件生效。
//
//  用法：node tools/live-check.mjs [--port 9411] [--query "周杰伦 合集"] [--keep]
//  它用开发仓库里那份 electron.exe 直接跑夹具应用目录（不用复制 300MB 运行时），
//  userData 走临时目录，绝不碰你正在用的那份 Mineradio。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const PORT = Number(flag('--port', 9411));
const QUERY = flag('--query', '周杰伦 合集');
// 一份"看起来就是别人电脑上那种原版安装"：Mineradio.exe + resources/app（上游原版 + 只装外挂）
// 运行时文件用 tools/link-runtime.ps1 硬链接过来，不占额外磁盘。
const ROOT = path.resolve(flag('--root', path.join(PACK, '.live', 'Mineradio')));
const APP = path.join(ROOT, 'resources', 'app');
const EXE = flag('--exe', path.join(ROOT, 'Mineradio.exe'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? '✔ ' : '✖ ') + name + (detail ? '  — ' + detail : ''));
};

if (!fs.existsSync(EXE)) { console.log('找不到 Mineradio.exe：' + EXE + '\n（先跑 tools/link-runtime.ps1 造一份干净安装布局）'); process.exit(2); }
if (!fs.existsSync(path.join(APP, 'mods', 'installed.json'))) {
  console.log('这份应用目录没装外挂：先跑 node install.mjs --path ' + APP + ' --go'); process.exit(2);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mods-live-'));

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch (_) { return []; }
}
async function waitTarget(matcher, label, ms) {
  const end = Date.now() + (ms || 90000);
  while (Date.now() < end) {
    const hit = (await targets()).find((x) => x.type === 'page' && matcher(x.url || ''));
    if (hit) return attach(hit);
    await sleep(600);
  }
  throw new Error('等不到目标：' + label);
}
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { id += 1; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error('页面执行出错：' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result ? res.result.value : res;
  };
  const press = async (base) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }); };
  return { ev, send, press, close: () => ws.close(), url: target.url };
}
const KEY = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
};

let main = null; let over = null; let child = null;
try {
  child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    windowsHide: true,
    env: Object.assign({}, process.env, {
      MINERADIO_STARTUP_QA_HIDDEN: '1',
      MINERADIO_STARTUP_QA_USER_DATA: userData,
      HOST: '127.0.0.1',
    }),
  });
  main = await waitTarget((u) => !/quick-search\.html/.test(u), '主窗口', 120000);
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await main.ev(`!!(window.desktopMods && window.desktopMods.openQuickSearch
      && typeof window.quickSearchHostRunQuery === 'function'
      && typeof window.__mrModsHas === 'function') ? 'ready' : 'no'`) === 'ready';
    if (!ready) await sleep(700);
  }
  check('原版 + 外挂：主窗口拿到桥接 desktopMods 与外挂模块', ready);
  check('B 站外挂源注册上了（__mrModsHas("bilibili")）',
    await main.ev(`window.__mrModsHas('bilibili') ? 1 : 0`) === 1);
  check('后端外挂活着（/api/bilibili/login/status 有响应）',
    await main.ev(`fetch('/api/bilibili/login/status').then(r=>r.status===200?1:0).catch(()=>0)`) === 1);
  check('更新检查被接管（回"没有更新"，不再拿 GitHub release 诱惑你升级）',
    await main.ev(`fetch('/api/update/latest?t='+Date.now()).then(function(r){return r.json();})
      .then(function(j){ return (j && j.updateAvailable === false && j.configured === false) ? 1 : 0; }).catch(()=>0)`) === 1);

  const opened = await main.ev(`window.desktopMods.openQuickSearch()`);
  check('从主窗口叫出浮窗', opened && (opened.ok === true || opened.shown === true), JSON.stringify(opened));
  over = await waitTarget((u) => /quick-search\.html/.test(u), '浮窗', 60000);
  await sleep(2500);
  check('浮窗拿到键盘焦点', await over.ev(`document.hasFocus() && document.activeElement.id === 'qs-input' ? 1 : 0`) === 1);

  const tabs = await over.ev(`Array.prototype.map.call(document.querySelectorAll('#qs-tabs button'),function(b){return b.textContent;}).join(',')`);
  check('平台档里有 BL（外挂源没注册就该没有这一档）', /BL/.test(tabs), tabs);
  // 开窗问候（hello）会按主窗口回的平台表重画一次标签，第一下点下去的可能是被换掉的旧节点；
  // 所以点完要确认当前档，没切过去就再点一次（这是测试脚本的抖动，不是浮窗的 bug）
  async function clickTab(mode) {
    for (let i = 0; i < 3; i++) {
      await over.ev(`(function(){var b=document.querySelector('#qs-tabs button[data-qs-mode="${mode}"]'); if(b) b.click(); return !!b;})()`);
      await sleep(500);
      const active = await over.ev(`(function(){var b=document.querySelector('#qs-tabs button.active');return b?(b.getAttribute('data-qs-mode')||''):'';})()`);
      if (active === mode) return true;
    }
    return false;
  }
  check('切到 BL 档（当前档真的变成 BL）', await clickTab('bilibili'));
  await over.send('Input.insertText', { text: QUERY });

  async function rows(max = 40) {
    for (let i = 0; i < max; i++) {
      await sleep(700);
      const n = await over.ev(`document.querySelectorAll('.qs-row').length`);
      if (n) return n;
    }
    return 0;
  }
  const first = await rows();
  const diag = JSON.parse(await main.ev(`JSON.stringify({
    pool: (typeof window.quickSearchHostPoolState==='function')?window.quickSearchHostPoolState():null,
    hasMods: typeof window.__mrModsHas==='function' ? 1 : 0,
    key: (typeof window.songProviderKey==='function')?String(window.songProviderKey({bvid:'BV1',provider:'bilibili'})):'?' })`));
  const srcs = await over.ev(`Array.prototype.slice.call(document.querySelectorAll('.qs-row .qs-src'),0,3).map(function(s){return s.getAttribute('data-src');}).join(',')`);
  check('BL 档搜到结果（走的是外挂后端那一页，不经过软件源注册表）', first > 0 && /bilibili/.test(srcs),
    `${first} 条 / ${QUERY}，前三行源=${srcs}，池子=${JSON.stringify(diag.pool)}，songProviderKey(bili)=${diag.key}`);
  check('每条 B 站结果都标了合集/分段徽章',
    await over.ev(`document.querySelectorAll('.qs-row').length === document.querySelectorAll('.qs-row .qs-badge').length ? 1 : 0`) === 1,
    await over.ev(`Array.prototype.slice.call(document.querySelectorAll('.qs-badge'),0,4).map(function(b){return b.textContent;}).join(' ')`));
  check('B 站时长按秒显示（20 分钟不该变成 0:1）',
    await over.ev(`(function(){var d=document.querySelector('.qs-row .qs-dur');return d && /:\\d\\d/.test(d.textContent) && d.textContent.length>2 ? 1:0;})()`) === 1,
    await over.ev(`(document.querySelector('.qs-row .qs-dur')||{}).textContent || ''`));

  const hasMore = await over.ev(`!!document.querySelector('[data-qs-more]')`);
  await over.press(KEY.End);
  let grown = first;
  for (let i = 0; i < 24; i++) { await sleep(600); grown = await over.ev(`document.querySelectorAll('.qs-row').length`); if (grown > first) break; }
  check('查看更多能往前翻页', hasMore && grown > first, `${first} → ${grown} 条`);

  let drill = null; let lastState = '';
  for (let k = 0; k < Math.min(8, grown); k++) {
    for (let s = 0; s < k; s++) await over.press(KEY.Down);
    await over.press(KEY.Enter);
    await sleep(1200);
    const info = JSON.parse(await over.ev(`JSON.stringify({
      parts: document.querySelectorAll('.qs-row.is-part').length,
      pack: ((document.querySelector('.qs-row.is-collection-head .qs-row-name')||{}).textContent||''),
      back: ((document.querySelector('.qs-back')||{}).textContent||''),
      state: ((document.querySelector('.qs-state')||{}).textContent||''),
      playing: !!(document.querySelector('.qs-now') && document.querySelector('.qs-now').textContent) })`));
    lastState = info.state || (info.playing ? '那行被当成普通歌播掉了（没下钻）' : '');
    if (info.parts >= 2) { drill = info; break; }
    await over.press(KEY.Esc);
    await sleep(500);
  }
  check('B 站行回车展开分 P（合集当播放列表看）', !!drill,
    drill ? `${drill.parts} 段可播 · ${drill.back.slice(0, 40)}` : `前 8 行都没展开出多段合集；最后一次列表状态：${lastState || '（空）'}`);
  if (drill) {
    check('分段列表顶上那行是整包入队', /整包入队/.test(drill.pack), drill.pack);
    const partName = await over.ev(`(document.querySelector('.qs-row.active .qs-row-name')||{}).textContent || ''`);
    const before = await main.ev(`(typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1`);
    await over.press(KEY.Enter);
    let played = null;
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      played = JSON.parse(await main.ev(`JSON.stringify({
        queue:(typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1,
        name:(typeof currentCoverSong==='function'&&currentCoverSong())?(currentCoverSong().name||''):'',
        cid:(typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().cid||''):'',
        part:(typeof currentCoverSong==='function'&&currentCoverSong())?Number(currentCoverSong().biliPartIndex||0):0,
        src:(typeof audio!=='undefined'&&audio&&audio.src)?audio.src.slice(0,48):'',
        playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended)})`));
      if (played.playing) break;
    }
    check('单独播其中一首：只多一条、歌名是分标题、真出声',
      played.queue === before + 1 && played.name === partName && played.playing && !!played.src,
      `播「${played.name}」，队列 ${before}→${played.queue}，src=${played.src || '空'}`);
    check('那一段带自己的 cid（外挂的取址锚点生效，不是整条第一 P）',
      !!played.cid && played.part > 0, `cid=${played.cid || '空'} P${played.part}`);
  }
  // ---- 免登录的两个外挂源：Internet Archive + Radio Paradise ----
  // 浮窗还开着，接着用它（档位切换、真实起播都走用户那条路，不从主窗口抄近道）
  const modKeys = JSON.parse(await main.ev(`JSON.stringify({
    ia: window.__mrModsHas('internetarchive') ? 1 : 0,
    rp: window.__mrModsHas('radioparadise') ? 1 : 0,
    keyIa: String(window.songProviderKey({ archiveId: 'Foo_1956' })),
    keyRp0: String(window.songProviderKey({ rpChan: 0, rpSlug: 'aac-320', provider: 'radioparadise' })),
    keyRpSlug: String(window.songProviderKey({ id: 'rp:5', rpSlug: 'serenity', provider: 'radioparadise' })),
    norm: [window.normalizePlaybackProvider('internetarchive'), window.normalizePlaybackProvider('radioparadise')].join(','),
    lyricIa: String(window.lyricEndpointForSong({ archiveId: 'Foo_1956' })),
    lyricRp: String(window.lyricEndpointForSong({ rpChan: 1 })) })`));
  check('IA / RP 两个源都注册上了', modKeys.ia === 1 && modKeys.rp === 1, JSON.stringify({ ia: modKeys.ia, rp: modKeys.rp }));
  // 上游那条三元链对不认识的源一律回 'netease'；Main Mix 的 chan 是 0，真值判断会把它当成没 chan
  check('songProviderKey 认得 IA 与 RP（含 chan=0 那个坑）',
    modKeys.keyIa === 'internetarchive' && modKeys.keyRp0 === 'radioparadise' && modKeys.keyRpSlug === 'radioparadise',
    `archiveId→${modKeys.keyIa}，chan0→${modKeys.keyRp0}，slug→${modKeys.keyRpSlug}`);
  check('normalizePlaybackProvider 认得新源（否则起播那条 if/else 会去问网易云）',
    modKeys.norm === 'internetarchive,radioparadise', modKeys.norm);
  check('新源的歌词走自己的端点，不掉进网易云兜底分支',
    /^\/api\/internetarchive\/lyric/.test(modKeys.lyricIa) && modKeys.lyricIa.indexOf('bvid') < 0
      && modKeys.lyricRp === '/api/radioparadise/lyric', `${modKeys.lyricIa} | ${modKeys.lyricRp}`);

  const backend = JSON.parse(await main.ev(`Promise.all([
      fetch('/api/radioparadise/channels').then(r=>r.json()),
      fetch('/api/internetarchive/search?keywords=' + encodeURIComponent('Miles Davis') + '&limit=4&offset=0').then(r=>r.json())
    ]).then(function(a){ return JSON.stringify({ channels: (a[0].channels||[]).length, songs: (a[1].songs||[]).length, first: (a[1].songs||[])[0] || {} }); })`));
  check('后端外挂：RP 频道表 + IA 搜索都回东西',
    backend.channels >= 4 && backend.songs > 0 && !!backend.first.archiveId,
    `${backend.channels} 个频道 / IA 命中 ${backend.songs} 条，首条 ${backend.first.archiveId || '无'}`);

  const iaUrl = JSON.parse(await main.ev(`fetch('/api/internetarchive/song/url?archiveId='
    + encodeURIComponent(${JSON.stringify(backend.first.archiveId || '')})).then(r=>r.json())
    .then(function(d){ return JSON.stringify({ playable: !!d.playable, url: String(d.url||'').slice(0,40), quality: d.quality||'', dur: Number(d.durationSeconds)||0, proxy: !!d.needsProxy }); })`));
  check('IA 取址：按音质档从条目里挑到一个浏览器能解的文件，并带时长',
    iaUrl.playable && /^https:\/\/(archive\.org|ia\d+\.us\.archive\.org)\//.test(iaUrl.url) && iaUrl.dur > 0,
    `${iaUrl.quality || '?'} 档 · ${iaUrl.dur}s · ${iaUrl.url}…`);

  const rpUrl = JSON.parse(await main.ev(`fetch('/api/radioparadise/song/url?chan=0').then(r=>r.json())
    .then(function(d){ return JSON.stringify({ playable: !!d.playable, url: String(d.url||''), live: !!d.live }); })`));
  check('RP 取址：Main Mix（chan=0）拿到直播流', rpUrl.playable && /radioparadise\.com/.test(rpUrl.url), rpUrl.url);

  const modTabs = await over.ev(`Array.prototype.map.call(document.querySelectorAll('#qs-tabs button'),function(b){return b.textContent;}).join(',')`);
  check('平台档里有 IA 与 RP', /IA/.test(modTabs) && /RP/.test(modTabs), modTabs);

  async function searchInTab(mode, text) {
    if (!(await clickTab(mode))) return { ok: false, why: '切不过去那一档' };
    await over.ev(`(function(){var i=document.getElementById('qs-input'); i.value=${JSON.stringify(text)}; i.dispatchEvent(new Event('input'));})()`);
    let n = 0; let srcs = '';
    for (let i = 0; i < 40; i++) {
      await sleep(700);
      n = await over.ev(`document.querySelectorAll('.qs-row .qs-src[data-src="${mode}"]').length`);
      if (n) break;
      srcs = await over.ev(`(function(){var s=document.querySelector('.qs-state');return s?s.textContent.slice(0,60):'';})()`);
    }
    return { ok: n > 0, n, note: srcs };
  }

  const iaSearch = await searchInTab('internetarchive', 'Miles Davis');
  const iaBadges = await over.ev(`Array.prototype.slice.call(document.querySelectorAll('.qs-row .qs-badge'),0,3).map(function(b){return b.textContent;}).join(' ')`);
  check('浮窗 IA 档搜到 archive.org 条目', iaSearch.ok, iaSearch.ok ? `${iaSearch.n} 条` : `0 条（列表状态：${iaSearch.note || '（空）'}）`);
  check('IA 那几行老实标了"条目"（一行常是一整张专辑，不是单曲）', /条目/.test(iaBadges), iaBadges);

  // 真起播：从浮窗按回车 → 主窗口排队并开播，音频元素真的在跑才算数
  async function playActiveRow(expectProvider, label) {
    await over.press(KEY.Down);
    await over.press(KEY.Enter);
    let got = null;
    for (let i = 0; i < 45; i++) {
      await sleep(600);
      got = JSON.parse(await main.ev(`JSON.stringify({
        provider: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().provider||currentCoverSong().source||''):'',
        name: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().name||'').slice(0,40):'',
        src: (typeof audio!=='undefined'&&audio&&audio.src)?audio.src.slice(0,70):'',
        dur: (typeof audio!=='undefined'&&audio&&isFinite(audio.duration))?Number(audio.duration).toFixed(0):'live',
        playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended)})`));
      if (got.playing && got.provider === expectProvider) break;
    }
    check(`${label}：从浮窗起播真的出声`, !!got && got.playing && got.provider === expectProvider,
      got ? `播「${got.name}」· ${got.dur === 'live' ? '直播/时长未知' : got.dur + 's'} · ${got.src}` : '（没取到播放状态）');
    return got;
  }
  const iaPlayed = await playActiveRow('internetarchive', 'IA 整条播起来（经 /api/audio 代理，带 Range 才能拖）');
  if (iaPlayed) {
    check('IA 的直链确实走了本地音频代理（不是让浏览器直连 archive.org）',
      /\/api\/audio\?url=/.test(iaPlayed.src), iaPlayed.src);
  }
  const rpSearch = await searchInTab('radioparadise', 'rock');
  const rpBadges = await over.ev(`Array.prototype.slice.call(document.querySelectorAll('.qs-row .qs-badge'),0,3).map(function(b){return b.textContent;}).join(' ')`);
  check('浮窗 RP 档把命中的频道当条目列出来', rpSearch.ok, rpSearch.ok ? `${rpSearch.n} 条，徽章=${rpBadges}` : `0 条（列表状态：${rpSearch.note || '（空）'}）`);
  check('RP 那几行标了"直播"（没有单曲、拖不了进度）', /直播/.test(rpBadges), rpBadges);
  if (rpSearch.ok) await playActiveRow('radioparadise', 'RP 直播开播（无扩展名的 AAC 要报对 Content-Type）');

  // ---- 主界面那一侧：搜索结果行里的分 P 面板（包装 searchSongResultHtml 注入的）----
  // 脚本化搜索必须先把 #search-input 的值设好再调 doSearch：上游那个函数有个
  // "输入框内容与查询词不一致就整批丢掉"的守卫，不设值会得到 0 行，看着像"没结果"。
  await main.ev(`(function(){var el=document.getElementById('search-input'); el.value=${JSON.stringify(QUERY)};})()`);
  await main.ev(`doSearch(${JSON.stringify(QUERY)})`);
  let biliRows = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    // 面板是**整行 div 的兄弟节点**（上游 searchSongResultHtml 返回的是一整个行 div，
    // 外挂只能往它后面追加），所以不能用 .search-result .bili-parts-toggle 去数
    biliRows = await main.ev(`document.querySelectorAll('.bili-parts-toggle').length`);
    if (biliRows) break;
  }
  const allRows = await main.ev(`document.querySelectorAll('.search-result').length`);
  check('主界面结果里出现了 B 站行（外挂源进了软件的搜索路径）', biliRows > 0,
    `${biliRows} 行带面板入口 / 共 ${allRows} 行`);
  const toggles = biliRows;
  check('每条 B 站结果行都挂上"分段 / 合集"面板入口', toggles > 0, `${toggles} 颗按钮`);
  let expanded = 0;
  for (let t = 0; t < Math.min(6, toggles); t++) {
    await main.ev(`(function(){var b=document.querySelectorAll('.bili-parts-toggle'); if(b[${t}]) b[${t}].click();})()`);
    await sleep(1200);
    expanded = await main.ev(`document.querySelectorAll('.bili-part-row').length`);
    if (expanded >= 2) break;
  }
  check('点开展开能看到分 P 列表', expanded >= 2, `${expanded} 段列出来了`);
  if (expanded >= 2) {
    const before = await main.ev(`(typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1`);
    await main.ev(`(function(){var r=document.querySelectorAll('.bili-part-row'); if(r[1]) r[1].click();})()`);
    let part = null;
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      part = JSON.parse(await main.ev(`JSON.stringify({
        queue:(typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1,
        name:(typeof currentCoverSong==='function'&&currentCoverSong())?(currentCoverSong().name||''):'',
        cid:(typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().cid||''):'',
        playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended)})`));
      if (part.playing) break;
    }
    check('主界面点某一段：单独播那一段（带自己的 cid、真出声）',
      !!part.cid && part.playing && part.queue >= before,
      `播「${part.name}」cid=${part.cid || '空'}，队列 ${before}→${part.queue}`);
    const pack = await main.ev(`(function(){var b=document.querySelector('.bili-parts-queue-all');return b?b.textContent.trim():'';})()`)
      .catch(() => '');
    check('展开后给出「整包入队 N 段」', /整包入队/.test(pack), pack || '（没展开到带整包入队的那条）');
  }

  // ---- 主界面的 All 档里也要看得见 IA 行（两个坑：拼在数组末尾就永远不显示；
  // 标签函数不认新源会把行标成"NE"）----
  await main.ev(`(function(){var el=document.getElementById('search-input'); el.value='Miles Davis';})()`);
  await main.ev(`doSearch('Miles Davis')`);
  let iaPool = 0; let poolTotal = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const snap = JSON.parse(await main.ev(`JSON.stringify({
      total: (typeof playlist!=='undefined'&&playlist)?playlist.length:0,
      ia: (typeof playlist!=='undefined'&&playlist)?playlist.filter(function(s){ return window.__mrModsProviderOf(s)==='internetarchive'; }).length:0 })`));
    poolTotal = snap.total; iaPool = snap.ia;
    if (snap.ia) break;
  }
  check('IA 那一页并进了主界面 All 档的池子（外挂源进了软件自己的搜索路径）',
    iaPool > 0, `${iaPool} 条 IA / 池子里共 ${poolTotal} 条`);

  // 上游只画前 MUSIC_SEARCH_INITIAL_VISIBLE=18 行，剩下的靠滚动逐批追加。
  // IA 那些条目名与"Miles Davis"差得远，打分排不进首屏属正常 —— 所以要走"往下滚"这条真实路径
  // 去证明它们确实可达（而不是拼在数组末尾永远看不见），顺带看源标签写的是什么。
  let iaRows = 0; let iaTagText = ''; let batches = 0; let iaIndex = -1;
  for (let i = 0; i < 20 && !iaRows; i++) {
    iaRows = await main.ev(`document.querySelectorAll('.tag-source.internetarchive').length`);
    if (iaRows) break;
    await main.ev(`appendNextSearchResults()`);
    await sleep(700);
    batches += 1;
  }
  if (iaRows) {
    iaTagText = await main.ev(`(document.querySelector('.tag-source.internetarchive')||{}).textContent || ''`);
    iaIndex = await main.ev(`Array.prototype.slice.call(document.querySelectorAll('#search-results .search-result'))
      .findIndex(function(r){ return !!r.querySelector('.tag-source.internetarchive'); })`);
  }
  check('滚到 IA 那一行能真的画出来（按软件自己的打分排过，不是拼在末尾看不见）',
    iaRows > 0, iaRows ? `${iaRows} 行 IA，第 ${iaIndex + 1} 行（追加了 ${batches} 批）` : `池子里有 ${iaPool} 条，滚了 ${batches} 批还没画到`);
  check('IA 行的源标签写的是 IA，不是被兜成 NE', iaRows > 0 && iaTagText === 'IA',
    iaRows ? `标签文字=「${iaTagText}」` : '（没滚到 IA 行，这条没法验）');
} catch (e) {
  console.error('[live-check 异常] ' + ((e && e.stack) || e));
  results.push({ name: '异常', ok: false });
} finally {
  if (over) { try { over.close(); } catch (_) { } }
  if (main) { try { main.close(); } catch (_) { } }
  if (child && !argv.includes('--keep')) { try { child.kill(); } catch (_) { } }
  await sleep(1200);
  if (!argv.includes('--keep')) fs.rmSync(userData, { recursive: true, force: true });
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exitCode = passed === results.length ? 0 : 1;

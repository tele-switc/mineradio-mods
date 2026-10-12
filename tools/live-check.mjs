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
  // CDP 的 modifiers 位图：1=Alt 2=Ctrl 4=Meta 8=Shift
  CtrlH: { key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72, modifiers: 2 },
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
  if (!ready) {
    // 这一条挂了后面全是干等（每条都要耗几十秒），直接把线索打出来退掉。
    // 最常见的原因不是外挂坏了，而是这份夹具自己起不来：resources/app 里没有 node_modules
    // （上游 app 有 5 个运行时依赖），后端崩了但窗口照样开 —— 所以要在这里点名。
    const page = await main.ev(`JSON.stringify({url:location.href.slice(0,90), title:document.title,
      body:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,140)})`).catch(() => '{}');
    const nm = fs.existsSync(path.join(APP, 'node_modules', 'gsap'));
    throw new Error(`主窗口没拿到外挂桥接，提前退出。页面=${page} ；resources/app/node_modules=${nm ? '有' : '没有 ← 跑 tools/link-runtime.ps1 把它链接进来'}`);
  }
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
    // 队列快照：宿主那条口径是"已经在队列里的段靠 queueItemKey 跳过，不重复堆两份"，
    // 所以"只多一条"只有在"这一段本来不在队列里"时才成立 —— 先把它记下来，别把去重当成 bug
    const snapBefore = JSON.parse(await main.ev(`JSON.stringify({
      queue: (typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1,
      keys: (typeof playQueue!=='undefined'&&playQueue)?playQueue.map(function(s){ return String((s&&(s.bvid||s.id))||'') + ':' + String((s&&s.cid)||''); }):[] })`));
    await over.press(KEY.Enter);
    // 立刻读"队列里刚多出来的那一条"：这一步证明的是外挂的取址锚点与分 P 口径
    // （这一段有自己的 cid），不受后面 B 站取址是否成功、自动换源是否插手影响
    await sleep(300);
    const picked = JSON.parse(await main.ev(`JSON.stringify((function(){
      var q = (typeof playQueue !== 'undefined' && Array.isArray(playQueue)) ? playQueue : [];
      var s = (currentIdx >= 0 && currentIdx < q.length) ? q[currentIdx] : null;
      return { name: s ? String(s.name || '') : '', cid: s ? String(s.cid || '') : '',
        bvid: s ? String(s.bvid || '') : '', part: s ? Number(s.biliPartIndex || 0) : 0, queue: q.length };})())`));
    const queuedAlready = !!picked.cid && snapBefore.keys.indexOf(picked.bvid + ':' + picked.cid) >= 0;
    const grew = picked.queue === snapBefore.queue + 1;
    check('单独播其中一首：进队列的就是那一首分标题，且带它自己的 cid（不是整条第一 P）',
      picked.name === partName && !!picked.cid && picked.part > 0 && (grew || queuedAlready),
      `入队「${picked.name}」cid=${picked.cid || '空'} P${picked.part}，队列 ${snapBefore.queue}→${picked.queue}${queuedAlready ? '（这一段已在队列里，宿主按 queueItemKey 去重）' : ''}`);
    let played = null;
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      played = JSON.parse(await main.ev(`JSON.stringify({
        provider:(typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().provider||currentCoverSong().source||''):'',
        src:(typeof audio!=='undefined'&&audio&&audio.src)?audio.src.slice(0,48):'',
        playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended),
        notice:Array.prototype.slice.call(document.querySelectorAll('.source-fallback-card')).map(function(c){return (c.textContent||'').replace(/\\s+/g,' ').slice(0,60);}).join(' | ')})`));
      if (played.playing) break;
    }
    check('那一段真的出声（走外挂那条直链）',
      !!played && played.playing && !!played.src,
      played ? `provider=${played.provider}，src=${played.src || '空'}${played.notice ? ' · 换源提示：' + played.notice : ''}` : '（没取到播放状态）');
    // cid 存在不等于分 P 是对的：如果每一段都拿到整条的第一个 cid，上面两条照样绿（假阳性）。
    // 直接问 view 接口，确认头几段的 cid 互不相同。
    const partsProbe = JSON.parse(await main.ev(`fetch('/api/bilibili/parts?bvid='
      + encodeURIComponent(${JSON.stringify(picked.bvid || '')})).then(function(r){ return r.json(); })
      .then(function(d){
        var p = (d.parts || []).slice(0, 4).map(function (x) { return { cid: String(x.cid || ''), part: String(x.part || '').slice(0, 16) }; });
        return JSON.stringify({ count: p.length, uniq: new Set(p.map(function (x) { return x.cid; }).filter(Boolean)).size,
          sample: p.map(function (x) { return x.cid + '·' + x.part; }).join(' | ') });
      })`));
    check('分 P 的每一段各有自己的 cid（不是把整条第一个 cid 复制 N 遍，那样上面两条也会绿）',
      partsProbe.count >= 2 && partsProbe.uniq === partsProbe.count, `取到 ${partsProbe.count} 段、cid 去重后 ${partsProbe.uniq} 个 · ${partsProbe.sample}`);
  }
  // ---- 贴边组件 + 屏幕边缘进度轨 ----
  // 此刻正在播 IA 那一首（时长有限），正好能测进度条与"点哪跳到哪"
  const hasBtn = await main.ev(`!!document.getElementById('mini-player-btn')`);
  const btnWhere = await main.ev(`(function(){var b=document.getElementById('mini-player-btn');
    if(!b) return ''; var p=b.parentElement; return (b.className||'') + '@' + (p?(p.id||p.className):'');})()`);
  check('入口那颗「贴边」按钮插进了上游那排按钮里（上游 index.html 没它）', hasBtn, btnWhere);

  const playing = await main.ev(`(typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().name||''):''`);
  // 组件要显示总长，前提是音频元素真的把时长读出来了；起播是边下边播，先等它 finite
  let mainDur = 0;
  for (let i = 0; i < 30; i++) {
    mainDur = Number(await main.ev(`(audio&&isFinite(audio.duration))?Number(audio.duration):0`));
    if (mainDur > 0) break;
    await sleep(700);
  }
  await main.ev(`(function(){var b=document.getElementById('mini-player-btn'); if(b) b.click();})()`);
  let mini = null;
  try { mini = await waitTarget((u) => /mini-player\.html/.test(u), '贴边组件窗口', 40000); } catch (_) { mini = null; }
  check('点那颗按钮真的建出了组件窗口', !!mini, mini ? mini.url : '（等不到 mini-player.html 这个页面）');
  let rail = null;
  if (mini) {
    let miniTitle = '';
    let miniDur = '';
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      miniTitle = await mini.ev(`(document.getElementById('title')||{}).textContent || ''`);
      miniDur = await mini.ev(`(document.getElementById('t-dur')||{}).textContent || ''`);
      if (miniTitle && miniTitle !== '未在播放' && miniDur && miniDur !== '0:00') break;
    }
    check('组件显示的就是正在播的那首，连总长都推过去了（主窗口每 500ms 推一帧）',
      !!playing && miniTitle.slice(0, 4) === playing.slice(0, 4) && miniDur !== '0:00' && mainDur > 0,
      `主窗口「${playing}」/ 组件「${miniTitle}」· 组件读到总长 ${miniDur}（主窗口 ${Math.round(mainDur)}s）`);
    // 组件上的播放键要真的能遥控主窗口：只断言"按下去换个状态、再按回来"，
    // 不去猜按下前到底在不在播（那取决于前面几步起播后缓冲到哪一步了）
    const audioState = async () => JSON.parse(await main.ev(`JSON.stringify({
      paused: !!(typeof audio!=='undefined'&&audio&&audio.paused), had: !!(typeof audio!=='undefined'&&audio&&audio.src)})`));
    const st0 = await audioState();
    await mini.ev(`document.getElementById('btn-play').click()`);
    await sleep(1300);
    const st1 = await audioState();
    await mini.ev(`document.getElementById('btn-play').click()`);
    await sleep(1300);
    const st2 = await audioState();
    check('组件上那颗播放/暂停键真的在遥控主窗口',
      st0.had && st1.paused !== st0.paused && st2.paused === st0.paused,
      `按下前 paused=${st0.paused} → 第一次 ${st1.paused} → 第二次 ${st2.paused}`);

    // 收到屏边 = 组件窗口让位、整条边变成进度条（这一步用桥接直接表达意图，不去猜它自己多久收）
    await main.ev(`window.desktopMods.setMiniPlayerView({ collapsed: true, edge: 'right' }).then(function(r){return JSON.stringify(r||{});})`);
    try { rail = await waitTarget((u) => /edge-rail\.html/.test(u), '边缘进度轨窗口', 30000); } catch (_) { rail = null; }
    // 收起态下组件窗口是被 hide 掉的，这里只把它的可见性取出来当线索（不参与断言）
    const miniVisibility = await mini.ev(`document.visibilityState || ''`);
    check('组件收到屏边：进度轨窗口出来了', !!rail, rail ? rail.url : '（等不到 edge-rail.html）');
    if (rail) {
      // 进度轨的窗口只有 34px 宽，用 DOM 反推进度不可靠；直接再挂一个监听，
      // 收主窗口推过来的那一帧状态，和主窗口自己的 currentTime 对表
      await rail.ev(`window.__mrRailSeen = null; window.desktopOverlay.onRailState(function(s){ window.__mrRailSeen = s; });`);
      let seen = {};
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        seen = JSON.parse(await rail.ev(`JSON.stringify(window.__mrRailSeen || {})`));
        if (seen && Number(seen.durationSec) > 0) break;
      }
      const nowMain = JSON.parse(await main.ev(`JSON.stringify({
        cur:(audio&&isFinite(audio.currentTime))?Number(audio.currentTime):-1,
        dur:(audio&&isFinite(audio.duration))?Number(audio.duration):-1})`));
      // 竖向那一轨是把高度当进度（width 固定 100%），横向反过来 —— 所以两个都读，取那个不是 100% 的
      const railGeom = JSON.parse(await rail.ev(`JSON.stringify({
        w: (document.getElementById('fill') || {}).style ? document.getElementById('fill').style.width : '',
        h: (document.getElementById('fill') || {}).style ? document.getElementById('fill').style.height : '',
        axis: document.body.getAttribute('data-axis') || ''})`));
      const railPct = parseFloat(railGeom.h !== '100%' ? railGeom.h : railGeom.w);
      const expectPct = nowMain.dur > 0 ? (nowMain.cur / nowMain.dur) * 100 : -1;
      check('进度轨收到的是这一帧真实进度，且按比例画出来了（它是进度条，不是第二条控制条）',
        Number(seen.durationSec) > 0 && Math.abs(Number(seen.positionSec) - nowMain.cur) < 10
          && isFinite(railPct) && Math.abs(railPct - expectPct) < 10,
        `轨上 ${seen.positionSec}/${seen.durationSec}s，主窗口 ${nowMain.cur.toFixed(1)}/${nowMain.dur.toFixed(1)}s，画到 ${railPct.toFixed(1)}%（该 ${expectPct.toFixed(1)}%，axis=${railGeom.axis}），组件页 visibility=${miniVisibility}`);
      // 在进度轨上点一下就该跳转：页面只发比例，主进程转成 seek 送回主窗口
      const durBefore = await main.ev(`(audio&&isFinite(audio.duration))?Number(audio.duration):0`);
      await rail.ev(`window.desktopOverlay.railSeek(0.5)`);
      let jumped = null;
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        jumped = JSON.parse(await main.ev(`JSON.stringify({cur:(audio&&isFinite(audio.currentTime))?Number(audio.currentTime).toFixed(1):-1,dur:(audio&&isFinite(audio.duration))?Number(audio.duration):0})`));
        if (jumped.cur > 0) break;
      }
      check('在进度轨上点一下，主窗口真的跳到那一处',
        !!jumped && durBefore > 0 && Math.abs(jumped.cur - durBefore * 0.5) < durBefore * 0.15,
        `跳到 ${jumped ? jumped.cur : '?'}s / 共 ${jumped ? jumped.dur : '?'}s`);
      // 指针回到那条边 = 用户要把组件叫回来（页面只上报坐标，命中规则在主进程那份里）
      // 命中条件是 x ≥ 可见宽 - 窄带，所以按这个窗口自己的尺寸报一个最内侧的点
      const railInner = JSON.parse(await rail.ev(`JSON.stringify({w:window.innerWidth,h:window.innerHeight})`));
      const hitX = Math.max(1, railInner.w - 1);
      await rail.ev(`window.desktopOverlay.railPointer(${hitX}, ${Math.floor(railInner.h / 2)})`);
      await sleep(900);
      const backToWide = await main.ev(`window.desktopMods.updateMiniPlayer({}).then(function(r){return JSON.stringify(r||{});})`);
      const stillCollapsed = JSON.parse(String(backToWide || '{}')).collapsed !== false;
      check('指针落到屏边那条窄带，组件就重新展开（进度轨收回）',
        !stillCollapsed, `窗口 ${railInner.w}×${railInner.h}，报 x=${hitX} → 回读 ${String(backToWide)}`);
    }
    // 再点一次按钮：两个窗口都要没
    await main.ev(`(function(){var b=document.getElementById('mini-player-btn'); if(b) b.click();})()`);
    await sleep(1500);
    const gone = await targets();
    const stillMini = gone.some((x) => /mini-player\.html/.test(x.url || ''));
    const stillRail = gone.some((x) => /edge-rail\.html/.test(x.url || ''));
    check('再点一次「贴边」把两个窗口都收掉（不留隐形窗口把进程挂在后台）',
      !stillMini && !stillRail, `mini=${stillMini} rail=${stillRail}`);
    const pressed = await main.ev(`(function(){var b=document.getElementById('mini-player-btn');return b?(b.getAttribute('aria-pressed')||'')+' '+(b.className||''):'';})()`);
    check('按钮的开关状态跟着主进程回推（不自己记一份）', /false/.test(pressed), pressed.trim());
    try { mini.close(); } catch (_) { }
    if (rail) { try { rail.close(); } catch (_) { } }
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
    ]).then(function(a){ return JSON.stringify({ channels: (a[0].channels||[]).length, songs: (a[1].songs||[]).length, first: (a[1].songs||[])[0] || {}, ids: (a[1].songs||[]).slice(0,4).map(function(s){return s.archiveId||s.id||'';}) }); })`));
  check('后端外挂：RP 频道表 + IA 搜索都回东西',
    backend.channels >= 4 && backend.songs > 0 && !!backend.first.archiveId,
    `${backend.channels} 个频道 / IA 命中 ${backend.songs} 条，首条 ${backend.first.archiveId || '无'}`);

  // archive.org 的条目是"人工元数据 + 随便什么格式"，头一条完全可能只有 ALAC/CAFF 这类
  // 浏览器解不了的音频，所以按前 4 条逐个试：成一个即算通过，但把每个的结果都报出来
  const iaTry = JSON.parse(await main.ev(`Promise.all((${JSON.stringify(backend.ids || [])}).map(function(id){
      return fetch('/api/internetarchive/song/url?archiveId=' + encodeURIComponent(id) + '&quality=')
        .then(function(r){ return r.json(); })
        .then(function(d){ return { id: id, playable: !!d.playable, url: String(d.url || ''), quality: d.quality || '', dur: Number(d.durationSeconds) || 0, err: String(d.error || d.message || '') }; })
        .catch(function(e){ return { id: id, playable: false, url: '', quality: '', dur: 0, err: String((e && e.message) || e) }; });
    })).then(function(list){ return JSON.stringify(list); })`));
  const iaGood = iaTry.filter(function (x) {
    return x.playable && /^https:\/\/(archive\.org|ia\d+\.us\.archive\.org)\//.test(x.url) && x.dur > 0;
  })[0] || null;
  check('IA 取址：按音质档从条目里挑到一个浏览器能解的文件，并带时长（前 4 个条目里至少成一个）',
    !!iaGood, iaGood
      ? `成的是 ${String(iaGood.id).slice(0, 28)} · ${iaGood.quality} 档 · ${iaGood.dur}s · ${iaGood.url.slice(0, 34)}…；其余 ${iaTry.filter((x) => x !== iaGood).map((x) => x.err || '没解得了的格式').join(' / ')}`
      : `四个都没成：${iaTry.map((x) => x.err || '?').join(' / ')}`);

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

  // 真起播：从浮窗按回车 → 主窗口排队并开播，音频元素真的在跑才算数。
  // IA 那一档容许多试几行：archive.org 的条目是人工整理的，头一条完全可能挑不出能播的文件，
  // 而"这一行播不响"到底是包的 bug 还是那个条目本来就没有可播文件，得能区分开。
  async function gotoRow(k) {
    for (let g = 0; g < 40; g++) {
      const cur = Number(await over.ev(`(function(){var r=document.querySelectorAll('.qs-row');
        for(var i=0;i<r.length;i++){ if(r[i].classList.contains('active')) return i; } return -1;})()`));
      if (cur === k) return true;
      await over.press(cur < k ? KEY.Down : KEY.Up);
      await sleep(120);
    }
    return false;
  }
  async function playActiveRow(expectProvider, maxTries) {
    const tries = Number(maxTries) || 1;
    let got = null;
    const notes = [];
    for (let k = 0; k < tries; k++) {
      if (!(await gotoRow(k))) break;
      await over.press(KEY.Enter);
      for (let i = 0; i < 20; i++) {
        await sleep(600);
        got = JSON.parse(await main.ev(`JSON.stringify({
          provider: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().provider||currentCoverSong().source||''):'',
          name: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().name||'').slice(0,40):'',
          src: (typeof audio!=='undefined'&&audio&&audio.src)?audio.src.slice(0,70):'',
          dur: (typeof audio!=='undefined'&&audio&&isFinite(audio.duration))?Number(audio.duration).toFixed(0):'live',
          playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended)})`));
        if (got.playing && got.provider === expectProvider) return Object.assign(got, { triedRow: k, notes });
      }
      notes.push(`第 ${k + 1} 行 12 秒内没播响（当时 provider=${got ? got.provider : '?'}）`);
    }
    return Object.assign(got || {}, { triedRow: -1, notes });
  }
  const iaPlayed = await playActiveRow('internetarchive', 4);
  const iaPlayedOk = !!iaPlayed && iaPlayed.playing && iaPlayed.provider === 'internetarchive';
  check('IA 从浮窗起播真的出声（前四行里有一行播起来了）', iaPlayedOk,
    iaPlayedOk
      ? `播「${iaPlayed.name}」· ${iaPlayed.dur === 'live' ? '时长未知' : iaPlayed.dur + 's'}·用的是第 ${iaPlayed.triedRow + 1} 行 · ${iaPlayed.src}`
      : `试了 4 行：${(iaPlayed && iaPlayed.notes || []).join('，') || '没列表'}`);
  if (iaPlayedOk) {
    check('IA 的直链确实走了本地音频代理（不是让浏览器直连 archive.org）',
      /\/api\/audio\?url=/.test(iaPlayed.src), iaPlayed.src);
  }
  const rpSearch = await searchInTab('radioparadise', 'rock');
  const rpBadges = await over.ev(`Array.prototype.slice.call(document.querySelectorAll('.qs-row .qs-badge'),0,3).map(function(b){return b.textContent;}).join(' ')`);
  check('浮窗 RP 档把命中的频道当条目列出来', rpSearch.ok, rpSearch.ok ? `${rpSearch.n} 条，徽章=${rpBadges}` : `0 条（列表状态：${rpSearch.note || '（空）'}）`);
  check('RP 那几行标了"直播"（没有单曲、拖不了进度）', /直播/.test(rpBadges), rpBadges);
  if (rpSearch.ok) {
    const rpPlayed = await playActiveRow('radioparadise', 2);
    check('RP 直播从浮窗开播真的出声（那条无扩展名的 AAC 要报对容器类型）',
      !!rpPlayed && rpPlayed.playing && rpPlayed.provider === 'radioparadise',
      rpPlayed && rpPlayed.playing
        ? `播「${rpPlayed.name}」· ${rpPlayed.dur === 'live' ? '直播流，本来就没有总长' : rpPlayed.dur + 's'} · ${rpPlayed.src}`
        : `试了：${(rpPlayed && rpPlayed.notes || []).join('，') || '没播'}`);
  }

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
    const before = JSON.parse(await main.ev(`JSON.stringify((function(){
      var q = (typeof playQueue !== 'undefined' && Array.isArray(playQueue)) ? playQueue : [];
      return { queue: q.length, title: (document.querySelectorAll('.bili-part-title')[1] || {}).textContent || '' };})())`));
    await main.ev(`(function(){var r=document.querySelectorAll('.bili-part-row'); if(r[1]) r[1].click();})()`);
    await sleep(320);
    // 先只看"进了队列的那一条是不是这一段自己（带 cid）"，再等它出声：
    // 出声那一步可能被 B 站取址失败与自动换源插手改变结果，两件事不该混在一条断言里
    const pickedMain = JSON.parse(await main.ev(`JSON.stringify((function(){
      var q = (typeof playQueue !== 'undefined' && Array.isArray(playQueue)) ? playQueue : [];
      var s = (currentIdx >= 0 && currentIdx < q.length) ? q[currentIdx] : null;
      return { name: s ? String(s.name || '') : '', cid: s ? String(s.cid || '') : '', part: s ? Number(s.biliPartIndex || 0) : 0, queue: q.length };})())`));
    const mainTitle = (before.title || '').replace(/\s+/g, ' ').trim();
    check('主界面点某一段：进队列的就是那一段，且带它自己的 cid',
      !!pickedMain.cid && pickedMain.part > 0 && !!mainTitle && pickedMain.name === mainTitle,
      `行文案「${mainTitle}」/ 入队「${pickedMain.name}」cid=${pickedMain.cid || '空'} P${pickedMain.part}，队列 ${before.queue}→${pickedMain.queue}`);
    let part = null;
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      part = JSON.parse(await main.ev(`JSON.stringify({
        name:(typeof currentCoverSong==='function'&&currentCoverSong())?(currentCoverSong().name||''):'',
        playing:!!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended),
        notice:Array.prototype.slice.call(document.querySelectorAll('.source-fallback-card')).map(function(c){return (c.textContent||'').replace(/\\s+/g,' ').slice(0,60);}).join(' | ')})`));
      if (part.playing) break;
    }
    check('那一段在主界面这条路上也真的出声', !!part && part.playing,
      part ? `播「${part.name}」${part.notice ? ' · 换源提示：' + part.notice : ''}` : '（没取到播放状态）');
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

  // 那条"拼在数组末尾就永远看不见"的坑，用**顺序**来验而不是用"滚到看得见"来验：
  // archive.org 的条目名跟 "Miles Davis" 差得远时打分就低，落在首屏之外属正常，
  // 拿"滚到了吗"当断言会让这一条跟着远端结果一起漂（实测同一句查询，两趟分别 2 批和 20 批）。
  // 真正要钉住的是：IA 那几条**参进了这次排序**，插在了别的源的行中间。
  const order = JSON.parse(await main.ev(`JSON.stringify((function(){
    var q = (typeof playlist !== 'undefined' && Array.isArray(playlist)) ? playlist : [];
    var ia = []; var lastOther = -1;
    q.forEach(function (s, i) {
      if (window.__mrModsProviderOf(s) === 'internetarchive') ia.push(i);
      else lastOther = i;
    });
    return { total: q.length, iaCount: ia.length, firstIa: ia.length ? ia[0] : -1,
      lastIa: ia.length ? ia[ia.length - 1] : -1, lastOther: lastOther };})())`));
  check('IA 那几条参进了软件自己的排序（插在别的源的行中间，不是整块拼在数组末尾）',
    order.iaCount > 0 && order.firstIa >= 0 && order.firstIa < order.lastOther,
    `池子 ${order.total} 条，IA 占 ${order.iaCount} 条，首条 IA 在第 ${order.firstIa + 1} 位（最后一条别的源在第 ${order.lastOther + 1} 位）`);

  // 源标签那一路（上游那条只认 NE/QQ/KG/QS/SP 的三元链）直接问渲染函数本身：
  // 拿池子里真的一条 IA 歌走上游的行渲染函数，看拼出来的那颗是什么文字
  const iaRowHtml = await main.ev(`(function(){
    var q = (typeof playlist !== 'undefined' && Array.isArray(playlist)) ? playlist : [];
    var s = null;
    for (var i = 0; i < q.length; i++) { if (window.__mrModsProviderOf(q[i]) === 'internetarchive') { s = q[i]; break; } }
    if (!s || typeof searchSongResultHtml !== 'function') return '';
    return String(searchSongResultHtml(s, 0)).slice(0, 600);})()`);
  const iaTagText = /tag-source internetarchive[^>]*>([^<]*)</.exec(iaRowHtml || '');
  check('IA 行渲染出来的源标签写的是 IA，不是被上游兜成 NE',
    /tag-source internetarchive/.test(iaRowHtml || '') && !!iaTagText && iaTagText[1].trim() === 'IA',
    iaRowHtml ? `那颗标签=「${iaTagText ? iaTagText[1].trim() : '?'}」，行 HTML 前 90 字：${iaRowHtml.slice(0, 90)}…` : '（池子里没有 IA 行或没有行渲染函数）');

  // ---- 自动换源：当前源取不到地址时，自己去找同一首歌的另一个源 ----
  const poolInfo = JSON.parse(await main.ev(`JSON.stringify({
    public: (typeof sourceFallbackPublicProviders==='function')?sourceFallbackPublicProviders():null,
    excluded: (typeof SOURCE_FALLBACK_AUTO_EXCLUDED_PROVIDERS!=='undefined')?SOURCE_FALLBACK_AUTO_EXCLUDED_PROVIDERS:null,
    reject: (typeof biliAdoptDecision==='function')?biliAdoptDecision({name:'晴天 指弹教学',artist:'周杰伦',categoryName:'音乐'}):'?',
    noted: (typeof biliAdoptNoteText==='function')?biliAdoptNoteText({name:'晴天（伴奏版）',artist:'周杰伦'}):'?',
    ready: (typeof sourceFallbackProviderReady==='function')?sourceFallbackProviderReady('bilibili'):null,
    noLive: (typeof sourceFallbackProviderReady==='function')?[sourceFallbackProviderReady('internetarchive'),sourceFallbackProviderReady('radioparadise')]:null,
    title: (typeof sourceFallbackProviderTitle==='function')?[sourceFallbackProviderTitle('bilibili'),sourceFallbackProviderTitle('internetarchive')].join('/'):''
  })`));
  check('换源池子是包里这一份（免登录只有 netease + B 站，IA/RP 明确不参与）',
    Array.isArray(poolInfo.public) && poolInfo.public.join(',') === 'netease,bilibili'
      && Array.isArray(poolInfo.excluded) && poolInfo.excluded.indexOf('internetarchive') >= 0
      && poolInfo.excluded.indexOf('radioparadise') >= 0
      && poolInfo.ready === true && Array.isArray(poolInfo.noLive) && poolInfo.noLive.join(',') === 'false,false',
    JSON.stringify(poolInfo));
  check('B 站采纳判据在包里生效：教学拒掉，伴奏收但要标注',
    poolInfo.reject === 'reject' && poolInfo.noted === '伴奏/纯音乐版',
    `教学=${poolInfo.reject} · 伴奏=${poolInfo.noted} · 源名=${poolInfo.title}`);

  // 真的换一次：塞一条"网易云取不到地址"的歌起播，看它自己找到 B 站那一版并播响
  const fakeNetease = { id: '0000000000', name: '晴天', artist: '周杰伦', source: 'netease', provider: 'netease', duration: 269000 };
  await main.ev(`(function(){ if(!Array.isArray(playQueue)) playQueue=[]; playQueue.push(${JSON.stringify(fakeNetease)});
    currentIdx = playQueue.length - 1; playQueueAt(currentIdx, { manual: true }); })()`);
  let adopted = null;
  for (let i = 0; i < 55; i++) {
    await sleep(600);
    adopted = JSON.parse(await main.ev(`JSON.stringify({
      provider: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().provider||currentCoverSong().source||''):'',
      name: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().name||'').slice(0,40):'',
      bvid: (typeof currentCoverSong==='function'&&currentCoverSong())?String(currentCoverSong().bvid||''):'',
      src: (typeof audio!=='undefined'&&audio&&audio.src)?audio.src.slice(0,52):'',
      playing: !!(typeof audio!=='undefined'&&audio&&audio.src&&!audio.paused&&!audio.ended),
      notice: Array.prototype.slice.call(document.querySelectorAll('.source-fallback-card')).map(function(c){return (c.textContent||'').replace(/\\s+/g,' ').slice(0,80);}).join(' | ')
    })`));
    if (adopted.playing && adopted.provider === 'bilibili') break;
  }
  check('取不到地址时自动换源真的换到了 B 站并播响（不是只弹一句"播放失败"）',
    !!adopted && adopted.playing && adopted.provider === 'bilibili' && !!adopted.bvid,
    adopted ? `现在播「${adopted.name}」bvid=${adopted.bvid} · ${adopted.src} · 说明：${adopted.notice || '（没留提示卡）'}` : '（没观察到换源）');

  // ---- Ctrl+H 历史记录与状态存档 ----
  // 这一段跑在最后：它真的要改这个实例的搜索记录与聆听记录（恢复那一条还会覆盖队列），
  // 用的是临时 userData，绝不碰你日常那份。
  // 2026-10-12 起界面上没有密码门也没有「一键清空」，所以这两处改成断言"它们不在"，
  // 防止哪天又被谁加回来；产生存档的那一步换成「存一份当前状态」（只存不清）。
  const daSnap = async () => JSON.parse(await main.ev(`(function(){
    var m=document.getElementById('danger-archive-modal');
    var text=function(sel){var n=document.querySelector(sel);return n?(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,46):'';};
    var items=function(key){ try { var r=JSON.parse(localStorage.getItem(key)||'[]'); if(Array.isArray(r)) return r; return Array.isArray(r.items)?r.items:[]; } catch(e){ return null; } };
    var stats=(function(){ try { return JSON.parse(localStorage.getItem('mineradio-listen-stats-v1')||'{}'); } catch(e){ return {}; } })();
    var hist=items('mineradio-search-history');
    return JSON.stringify({
      modal: !!m,
      shown: !!(m && m.classList.contains('show')),
      onArchive: !!(m && m.classList.contains('page-archive')),
      style: !!document.querySelector('link[data-mineradio-mods="danger-archive"]'),
      entryBtn: !!document.getElementById('danger-archive-history-btn'),
      hasPassword: !!document.getElementById('danger-archive-password'),
      hasClearAll: !!document.querySelector('.danger-archive-clear-all'),
      searchRows: document.querySelectorAll('[data-danger-archive-history-del^="search:"]').length,
      listenRows: document.querySelectorAll('[data-danger-archive-history-del^="listen:"]').length,
      archiveRows: document.querySelectorAll('#danger-archive-list .danger-archive-item[data-danger-archive-id]').length,
      snapshotBtn: !!document.querySelector('.danger-archive-snapshot'),
      confirmBtn: !!document.querySelector('#danger-archive-list .danger-archive-del.is-confirm'),
      editing: !!document.querySelector('[data-danger-archive-rename-input]'),
      firstKind: text('#danger-archive-list .danger-archive-item-kind'),
      firstSong: text('#danger-archive-list .danger-archive-item-song'),
      history: hist ? hist.length : -1,
      historyFirst: hist && hist[0] ? String(hist[0]).slice(0, 46) : '',
      playback: (localStorage.getItem('mineradio-last-playback-v1') || '').length,
      stats: (localStorage.getItem('mineradio-listen-stats-v1') || '').length,
      listenHist: Array.isArray(stats.history) ? stats.history.length : -1,
      listenSongs: stats.songs && typeof stats.songs==='object' ? Object.keys(stats.songs).length : -1,
      queue: (typeof playQueue!=='undefined'&&playQueue)?playQueue.length:-1,
      current: (typeof currentCoverSong==='function'&&currentCoverSong())?(currentCoverSong().name||''):'',
      paused: !!(typeof audio!=='undefined'&&audio&&audio.paused)
    });})()`));
  const daStore = async () => JSON.parse(await main.ev(`window.desktopMods.readDangerArchives()
    .then(function(r){ return JSON.stringify({ ok: !!r.ok, n: (r.archives||[]).length, label: (r.archives&&r.archives[0]&&r.archives[0].label)||'', kind: (r.archives&&r.archives[0]&&r.archives[0].kind)||'', file: r.file||'', error: r.error||'' }); })`));
  const seeded = await daSnap();
  check('模态框、样式与入口按钮都注入成功（上游 index.html / index.css 里没有这三处）',
    seeded.modal && seeded.style && seeded.entryBtn, `modal=${seeded.modal} css=${seeded.style} 按钮=${seeded.entryBtn}`);
  check('界面上没有密码框、也没有「一键清空」（2026-10-12 按用户要求删掉的两处）',
    !seeded.hasPassword && !seeded.hasClearAll, `密码框=${seeded.hasPassword} 清空钮=${seeded.hasClearAll}`);
  check('进这一段前先有东西可编辑（前面几步真搜过真播过）',
    seeded.history > 0 && seeded.queue > 0, `搜索记录 ${seeded.history} 条 · 队列 ${seeded.queue} 首`);

  await main.ev(`(function(){var i=document.getElementById('search-input'); if(i) i.blur();})()`);
  await main.press(KEY.CtrlH);
  await sleep(800);
  const byHotkey = await daSnap();
  check('按 Ctrl+H 直接打开「历史」页签，不再问密码',
    byHotkey.shown && !byHotkey.onArchive && byHotkey.searchRows > 0 && byHotkey.listenRows >= 0,
    `shown=${byHotkey.shown} 存档页=${byHotkey.onArchive} 搜索行 ${byHotkey.searchRows} · 聆听行 ${byHotkey.listenRows}`);

  await main.press(KEY.Esc);
  await sleep(450);
  const escClosed = await daSnap();
  check('Esc 把面板关掉', !escClosed.shown, `shown=${escClosed.shown}`);
  await main.ev(`(function(){var b=document.getElementById('danger-archive-history-btn'); if(b) b.click();})()`);
  await sleep(650);
  const byButton = await daSnap();
  check('那排桌面按钮里的「历史」那颗也能打开同一个面板',
    byButton.shown && byButton.searchRows > 0, `搜索行 ${byButton.searchRows} 颗按钮在=${byButton.entryBtn}`);

  const newWord = 'check改名' + (Date.now() % 100000);
  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-rename="search:0"]'); if(b) b.click();})()`);
  await sleep(450);
  const editing = await daSnap();
  check('点一行就是进入改名（行上出现输入框，不是直接触发什么）', editing.editing, `editing=${editing.editing}`);
  await main.ev(`(function(){var i=document.querySelector('[data-danger-archive-rename-input]'); if(i){ i.value=''; i.focus(); }})()`);
  await main.send('Input.insertText', { text: newWord });
  await sleep(250);
  await main.press(KEY.Enter);
  await sleep(650);
  const renamed = await daSnap();
  check('搜索记录改名：回车即保存，条数不变（只动点的那一条）',
    renamed.historyFirst === newWord && renamed.history === seeded.history && !renamed.editing,
    `头一条现在是「${renamed.historyFirst}」，还是 ${renamed.history} 条`);

  const secondWord = String(await main.ev(`(function(){try{var r=JSON.parse(localStorage.getItem('mineradio-search-history')||'[]');var a=Array.isArray(r)?r:(r&&r.items)||[];return String(a[1]||'');}catch(e){return '';}})()`));
  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-history-del="search:0"]'); if(b) b.click();})()`);
  await sleep(650);
  const afterDel = await daSnap();
  check('搜索记录删一条：只少一条，第二条原样留着（没有"一把清空"）',
    afterDel.history === seeded.history - 1 && (!secondWord || afterDel.historyFirst === secondWord),
    `${seeded.history} → ${afterDel.history} 条，头一条「${afterDel.historyFirst}」`);

  const beforeListen = await daSnap();
  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-history-del="listen:0"]'); if(b) b.click();})()`);
  await sleep(700);
  const afterListen = await daSnap();
  check('聆听记录删一条：历史少一行，累计统计（songs）没被牵连',
    beforeListen.listenHist > 0 && afterListen.listenHist === beforeListen.listenHist - 1
      && afterListen.listenSongs === beforeListen.listenSongs && afterListen.listenRows === afterListen.listenHist,
    `history ${beforeListen.listenHist} → ${afterListen.listenHist} 行 · songs 还是 ${afterListen.listenSongs} 首`);

  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-tab="archive"]'); if(b) b.click();})()`);
  await sleep(1000);
  const onArchive = await daSnap();
  const storeBefore = await daStore();
  check('页签切到「存档」：历史页收起来，那颗只存不清的按钮在',
    onArchive.onArchive && onArchive.shown && onArchive.snapshotBtn, `已有 ${onArchive.archiveRows} 条 · 文件里 ${storeBefore.n} 条`);

  await main.ev(`(function(){var b=document.querySelector('.danger-archive-snapshot'); if(b) b.click();})()`);
  await sleep(1500);
  const stored = await daSnap();
  const storeAfter = await daStore();
  const fileNorm = String(storeAfter.file || '').replace(/\\/g, '/');
  check('「存一份当前状态」什么都不清：存完 localStorage 那三条与队列都还在',
    stored.history > 0 && stored.playback > 0 && stored.stats > 0 && stored.queue > 0,
    `搜索 ${stored.history} 条 · 播放存档 ${stored.playback} 字节 · 统计 ${stored.stats} 字节 · 队列 ${stored.queue} 首`);
  check('存的这份写在 userData 而不是 resources/app 下面（软件更新冲不掉）',
    storeAfter.ok && storeAfter.n === storeBefore.n + 1 && /mineradio-danger-archive\.json$/.test(fileNorm)
      && fileNorm.indexOf('resources/app') < 0,
    `列表 ${stored.archiveRows} 条 · 文件里 ${storeAfter.n} 条 · ${fileNorm || storeAfter.error}`);
  check('新那条标的是「手动」（不是老版本那个清空前）',
    /手动/.test(stored.firstKind) && storeAfter.kind === 'manual', stored.firstKind + ' / ' + storeAfter.kind);

  // 存档页里这些选择器必须限定在 #danger-archive-list 内：历史页与存档页都留在 DOM 里，
  // 只靠 display 切显隐。写成 .danger-archive-item-wrap [data-danger-archive-rename] 会先命中
  // 隐藏那一页的搜索记录行 —— 实测点下去改的是搜索记录，界面上一眼看上去却"什么都没发生"，
  // 于是一条断言失败连带后面四条在面板关着的状态下点空。
  const labelWord = 'check标注' + (Date.now() % 100000);
  await main.ev(`(function(){var b=document.querySelector('#danger-archive-list [data-danger-archive-rename]'); if(b) b.click();})()`);
  await sleep(450);
  await main.ev(`(function(){var i=document.querySelector('[data-danger-archive-rename-input]'); if(i){ i.value=''; i.focus(); }})()`);
  await main.send('Input.insertText', { text: labelWord });
  await sleep(250);
  await main.press(KEY.Enter);
  await sleep(900);
  const labeled = await daSnap();
  const labelRead = await daStore();
  check('存档改名：写进 userData 那份文件，界面上那条也带上了名字',
    labeled.shown && labeled.onArchive && labelRead.label === labelWord && labeled.firstSong.indexOf(labelWord) >= 0,
    `文件 label=「${labelRead.label}」 行上「${labeled.firstSong}」`);

  await main.press(KEY.Esc);
  await sleep(400);
  await main.ev(`(function(){var b=document.getElementById('danger-archive-history-btn'); if(b) b.click();})()`);
  await sleep(700);
  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-tab="archive"]'); if(b) b.click();})()`);
  await sleep(1000);
  const reopened = await daSnap();
  check('关掉再重开面板，改过的名字还在（不是只活在内存里）',
    reopened.shown && reopened.onArchive && reopened.firstSong.indexOf(labelWord) >= 0,
    `shown=${reopened.shown} 页签=${reopened.onArchive ? 'archive' : reopened.page} 行上「${reopened.firstSong}」`);

  const beforeRestore = await daSnap();
  const disturbWord = 'check改动' + (Date.now() % 100000);
  await main.ev(`(function(){try{var r=JSON.parse(localStorage.getItem('mineradio-search-history')||'[]');var a=Array.isArray(r)?r:(r&&r.items)||[];a.unshift('${disturbWord}');localStorage.setItem('mineradio-search-history',JSON.stringify({version:3,items:a}));}catch(e){}})()`);
  await main.ev(`(function(){var it=document.querySelector('#danger-archive-list .danger-archive-item[data-danger-archive-id]'); if(it) it.click();})()`);
  await sleep(2600);
  const restored = await daSnap();
  const restoreRead = await daStore();
  check('点那条存档，整个软件回到存下那一刻：搜索记录、队列、当前曲目都回来了',
    restored.history === beforeRestore.history && restored.historyFirst !== disturbWord
      && restored.queue > 0 && !!restored.current,
    `搜索记录回到 ${restored.history} 条（头一条「${restored.historyFirst}」）· 队列 ${restored.queue} 首 · 正在显示「${restored.current}」`);
  check('恢复完面板自己收掉，并先留了一条「恢复前」退路',
    !restored.shown && restoreRead.n === beforeRestore.archiveRows + 1,
    `存档 ${beforeRestore.archiveRows} → ${restoreRead.n} 条`);

  const delTarget = restored.archiveRows;
  await main.ev(`(function(){var b=document.getElementById('danger-archive-history-btn'); if(b) b.click();})()`);
  await sleep(700);
  await main.ev(`(function(){var b=document.querySelector('[data-danger-archive-tab="archive"]'); if(b) b.click();})()`);
  await sleep(1000);
  await main.ev(`(function(){var b=document.querySelector('#danger-archive-list .danger-archive-del'); if(b) b.click();})()`);
  await sleep(500);
  const pendingDel = await daSnap();
  check('删存档第一步只把它标成"待确认"，条数一条没少',
    pendingDel.confirmBtn && pendingDel.archiveRows === delTarget, `确认态=${pendingDel.confirmBtn} · 还是 ${pendingDel.archiveRows} 条`);
  await main.ev(`(function(){var b=document.querySelector('#danger-archive-list .danger-archive-del.is-confirm'); if(b) b.click();})()`);
  await sleep(1100);
  const deleted = await daSnap();
  const deleteRead = await daStore();
  check('第二步点「确认删除」才真删：列表与 userData 文件一起少一条',
    deleted.archiveRows === delTarget - 1 && deleteRead.n === delTarget - 1,
    `${delTarget} → ${deleted.archiveRows} 条 · 文件 ${deleteRead.n} 条`);

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

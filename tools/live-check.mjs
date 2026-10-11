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
  // ---- 主界面那一侧：搜索结果行里的分 P 面板（包装 searchSongResultHtml 注入的）----
  // 脚本化搜索必须先把 #search-input 的值设好再调 doSearch：上游那个函数有个
  // "输入框内容与查询词不一致就整批丢掉"的守卫，不设值会得到 0 行，看着像"没结果"。
  await main.ev(`(function(){var el=document.getElementById('search-input'); el.value=${JSON.stringify(QUERY)};})()`);
  await main.ev(`doSearch(${JSON.stringify(QUERY)})`);
  let biliRows = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    biliRows = await main.ev(`document.querySelectorAll('.search-result[data-source="bilibili"]').length`);
    if (biliRows) break;
  }
  check('主界面搜得到 B 站结果（外挂源进了软件的搜索路径）', biliRows > 0, `${biliRows} 行`);
  const toggles = await main.ev(`document.querySelectorAll('.bili-parts-toggle').length`);
  check('每条 B 站结果行都挂上"分段 / 合集"面板入口', toggles >= biliRows && toggles > 0,
    `${toggles} 颗按钮 / ${biliRows} 行`);
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

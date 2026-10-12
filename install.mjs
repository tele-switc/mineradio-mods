#!/usr/bin/env node
// ============================================================
//  mineradio-mods 安装器
//
//  默认**干跑**：只说将要动哪些文件，加 --go 才真做。理由和上游那份
//  tools/sync-source-to-installed.mjs 一样——这是往别人正在用的软件里写东西。
//
//  用法：
//    node install.mjs                        自动找 Mineradio，打印计划（不动文件）
//    node install.mjs --path "D:\Mineradio"  指定安装目录（根目录或 resources\app 都行）。
//                                           这个目录认不出来就报错停下，不会退回自动探测去动另一份
//    node install.mjs --go [--autostart]     真装；--autostart 顺带注册"开机检查并自动重注入"
//    node install.mjs --status               看外挂装没装、上游文件有没有被新版本换掉
//    node install.mjs --verify [--mod X]     逐条校验锚点与文件（退出码 0 = 全好）
//    node install.mjs --uninstall [--mod X]  撤锚点、删投放的文件（备份留着）；目标位置上本来
//                                           就有同名文件的是**还原原件**，不是把它删掉
//                                           --mod 只撤那一族：共用的锚点与别的族在用的文件不动
//
//  软件更新之后怎么办：再跑一次 `node install.mjs --go`（或等开机那次自动重注入）。
//  锚点是成对标记，标记还在就原地替换；上游把整个文件换了就按 locator 重新插。
//  只有"连 locator 都找不到"才会报 drift 让人来看，那种情况不会瞎插。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { detect, resolveAppDir } from './lib/detect.mjs';
import { applyAnchor, removeAnchor, readAnchor } from './lib/anchors.mjs';
import { registerAutostart, unregisterAutostart, autostartStatus } from './lib/autostart.mjs';

const PACK = path.resolve(import.meta.dirname);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const contentKey = (buf) => sha(buf.toString('binary').replace(/\r\n/g, '\n'));
const rel = (p) => path.relative(PACK, p).replace(/\\/g, '/');
const say = (...a) => console.log(...a);
const pad = (s, n) => String(s).padEnd(n);

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK, 'mods.json'), 'utf8'));
  manifest.anchors.forEach((a) => {
    if (a.blockFrom) a.blockLines = fs.readFileSync(path.join(PACK, a.blockFrom), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    else a.blockLines = a.block || [];
  });
  return manifest;
}

function enabledMods(manifest, only) {
  return manifest.mods.filter((m) => m.enabled !== false && (!only.length || only.includes(m.id)));
}

function plan(manifest, appDir, mods) {
  const need = new Set();
  mods.forEach((m) => (m.anchors || []).forEach((id) => need.add(id)));
  const anchors = manifest.anchors.filter((a) => need.has(a.id));
  const files = [];
  mods.forEach((m) => (m.files || []).forEach((f) => files.push({ ...f, mod: m.id })));
  return { anchors, files, appDir };
}

function readState(target, manifest) {
  const out = [];
  for (const spec of target.anchors) {
    const file = path.join(target.appDir, spec.file);
    if (!fs.existsSync(file)) { out.push({ spec, state: 'missing-file' }); continue; }
    const info = readAnchor(fs.readFileSync(file, 'utf8'), spec, manifest.marker, manifest.packVersion);
    out.push({ spec, state: info.installed ? (info.matches ? 'ok' : 'stale') : (info.drift ? 'drift' : 'todo'), info });
  }
  for (const f of target.files) {
    const src = path.join(PACK, f.from);
    const dst = path.join(target.appDir, f.to);
    if (!fs.existsSync(src)) { out.push({ file: f, state: 'missing-source' }); continue; }
    const same = fs.existsSync(dst) && contentKey(fs.readFileSync(src)) === contentKey(fs.readFileSync(dst));
    out.push({ file: f, state: same ? 'ok' : 'todo' });
  }
  return out;
}

function report(target, states, manifest, mods) {
  say(`\n外挂包 mineradio-mods v${manifest.packVersion}（功能族：${mods.map((m) => m.id).join(', ') || '无'}）`);
  say(`目标 app 目录：${target.appDir}`);
  say(`上游版本：${target.version || '?'}   exe：${target.exe || '（没找到，只改了 app 目录）'}\n`);
  const rows = [
    ...states.filter((s) => s.spec).map((s) => ['锚点', s.spec.id, s.state, s.spec.file]),
    ...states.filter((s) => s.file).map((s) => ['文件', s.file.to, s.state, `来自 ${rel(s.file.from)}`]),
  ];
  rows.forEach((r) => say(`  ${pad(r[0], 3)} ${pad(r[2], 6)} ${pad(r[1], 22)} ${r[3]}`));
  const bad = states.filter((s) => ['drift', 'missing-file', 'missing-source'].includes(s.state));
  const todo = states.filter((s) => ['todo', 'stale'].includes(s.state));
  say(`\n  已就位 ${states.length - bad.length - todo.length} 项 · 待写入 ${todo.length} 项 · 有问题 ${bad.length} 项`);
  if (bad.length) {
    say('\n  ⚠ 这几项没法自动处理（上游把锚点周围的代码换了位置）：');
    bad.forEach((s) => say(`    - ${s.state}: ${s.spec ? s.spec.file : s.file.to}${s.info && s.info.error ? '（' + s.info.error + '）' : ''}`));
    say('    处理办法：手动把 mods.json 里那条 anchor 的 locator 改成新版本里的样子，或在 README 提的兼容版本内重装。');
  }
  return { bad, todo };
}

function backup(appDir, files, stamp) {
  const dir = path.join(appDir, 'mods-backup', stamp);
  files.forEach((relPath) => {
    const src = path.join(appDir, relPath);
    if (!fs.existsSync(src)) return;
    const dst = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  });
  return dir;
}

function writeLedger(appDir, target, manifest, mods, extra) {
  const file = path.join(appDir, 'mods', 'installed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old = { createdFiles: [] };
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { }
  const created = new Set((old.createdFiles || []).concat(target.files.map((f) => f.to)));
  // 覆盖过别人文件的那些：记下原件在哪个备份目录里，卸载时要还原而不是删掉
  const overwritten = Object.assign({}, old.overwritten || {}, (extra && extra.overwritten) || {});
  fs.writeFileSync(file, JSON.stringify({
    pack: manifest.pack,
    packVersion: manifest.packVersion,
    mods: mods.map((m) => m.id),
    anchors: target.anchors.map((a) => a.id),
    files: target.files.map((f) => ({ to: f.to, sha: sha(fs.readFileSync(path.join(appDir, f.to))) })),
    anchorsSnapshot: target.anchors.reduce((acc, a) => {
      acc[a.file] = sha(fs.readFileSync(path.join(appDir, a.file)));
      return acc;
    }, {}),
    createdFiles: [...created].sort(),
    overwritten,
    installedAt: new Date().toISOString(),
  }, null, 2));
}

function apply(target, states, manifest, opts) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const touch = [
    ...states.filter((s) => s.spec && ['todo', 'stale'].includes(s.state)).map((s) => s.spec.file),
  ];
  // 投放目标已经在那儿了 = 可能是上游自己的文件或用户放的文件；覆盖前必须留一份原件，
  // 否则卸载就是"把别人家本就存在的文件删掉"，那种损失没法恢复。
  const overwrite = states.filter((s) => s.file && s.state === 'todo'
    && fs.existsSync(path.join(target.appDir, s.file.to))).map((s) => s.file.to);
  const backupDir = opts.go && (touch.length || overwrite.length) ? backup(target.appDir, [...new Set(touch.concat(overwrite))], stamp) : '';
  if (opts.go && touch.length) say(`\n  已备份将被改动的上游文件到：${backupDir}`);
  if (opts.go && overwrite.length) say(`  目标位置上已有同名文件，原件已备份：${overwrite.join(', ')}`);

  for (const s of states) {
    if (s.spec && ['todo', 'stale'].includes(s.state)) {
      const file = path.join(target.appDir, s.spec.file);
      const text = fs.readFileSync(file, 'utf8');
      const res = applyAnchor(text, s.spec, manifest.marker, manifest.packVersion);
      if (opts.go) fs.writeFileSync(file, res.text);
      say(`  ${opts.go ? '✔' : '·'} 锚点 ${s.spec.id}：${res.action}${res.changed ? '' : '（内容本来就一致）'}`);
    }
    if (s.file && s.state === 'todo') {
      const dst = path.join(target.appDir, s.file.to);
      if (opts.go) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(PACK, s.file.from), dst);
      }
      say(`  ${opts.go ? '✔' : '·'} 投放 ${s.file.to}（${s.file.mod}）`);
    }
  }
  if (!opts.go) return;
  const overwritten = {};
  if (backupDir) overwrite.forEach((to) => { overwritten[to] = path.relative(target.appDir, backupDir).replace(/\\/g, '/'); });
  writeLedger(target.appDir, target, manifest, opts.mods, { overwritten });
  // 重注入脚本与它要用的清单/代码段/锚点库都放一份在 app 目录里：
  // 更新后就算 %LOCALAPPDATA% 那份被删了，手工跑 resources\app\mods\reapply.mjs 也能把锚点补回来
  // （anchors-lib.mjs 必须一起放：reapply.mjs 是 import './anchors-lib.mjs' 的，少了它那份就是块砖）
  [['mods/reapply.mjs', path.join(PACK, 'files', 'mods', 'reapply.mjs')],
   ['mods/anchors-lib.mjs', path.join(PACK, 'lib', 'anchors.mjs')],
   ['mods/blocks/preload-main.js', path.join(PACK, 'blocks', 'preload-main.js')]]
    .forEach(([relPath, src]) => {
      if (!fs.existsSync(src)) return;
      const dst = path.join(target.appDir, relPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    });
  fs.writeFileSync(path.join(target.appDir, 'mods', 'mods.json'), JSON.stringify(manifest, null, 2));
}

function uninstall(target, manifest, opts) {
  const ledgerFile = path.join(target.appDir, 'mods', 'installed.json');
  let ledger = { createdFiles: [], anchors: [] };
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (_) { }
  const byId = manifest.anchors.reduce((acc, a) => { acc[a.id] = a; return acc; }, {});
  // --mod 只撤一族：还留下的那些族共用的锚点与文件一个字都不能动
  // （renderer-modules / server-routes 这些是好几个族公用的，撤了别人就瞎了）
  const pulling = new Set((opts.mods || []).map((m) => m.id));
  const survivors = manifest.mods.filter((m) => m.enabled !== false && !pulling.has(m.id));
  const keepAnchors = new Set(); const keepFiles = new Set();
  survivors.forEach((m) => {
    (m.anchors || []).forEach((id) => keepAnchors.add(id));
    (m.files || []).forEach((f) => keepFiles.add(f.to));
  });
  const anchorIds = [...new Set((ledger.anchors || []).concat(target.anchors.map((a) => a.id)))]
    .filter((id) => byId[id] && !keepAnchors.has(id));
  for (const id of anchorIds) {
    const spec = { ...byId[id] };
    spec.blockLines = [];
    const file = path.join(target.appDir, spec.file);
    if (!fs.existsSync(file)) continue;
    const res = removeAnchor(fs.readFileSync(file, 'utf8'), spec, manifest.marker);
    if (opts.go && res.changed) fs.writeFileSync(file, res.text);
    say(`  ${opts.go ? '✔' : '·'} 撤掉锚点 ${id}${res.changed ? '' : '（本来就没有）'}`);
  }
  const overwritten = ledger.overwritten || {};
  const removed = new Set();
  for (const relPath of ledger.createdFiles || []) {
    if (keepFiles.has(relPath)) continue;
    removed.add(relPath);
    const full = path.join(target.appDir, relPath);
    if (!fs.existsSync(full)) continue;
    // 这份位置上的文件原本是别人的（装外挂时被覆盖、原件在备份里）：还原原件，不是删掉
    const bakRel = overwritten[relPath];
    const bak = bakRel ? path.join(target.appDir, ...bakRel.split('/'), relPath) : '';
    if (bakRel && fs.existsSync(bak)) {
      if (opts.go) fs.copyFileSync(bak, full);
      say(`  ${opts.go ? '✔' : '·'} 还原 ${relPath}（原件来自备份 ${bakRel}）`);
      continue;
    }
    if (bakRel) { say(`  ⚠ ${relPath} 装之前就有文件，但备份已经不在了 —— 留着不动，只从台账里划掉`); continue; }
    if (opts.go) fs.rmSync(full, { force: true });
    say(`  ${opts.go ? '✔' : '·'} 删除投放的文件 ${relPath}`);
  }
  if (!opts.go) { say('\n  这是干跑：上面这些一个字都没动。确认无误后加 --go。'); return; }
  if (survivors.length) {
    // 只撤了一族：台账按剩下的族重写，别把还在用的那几族也写成"没装"
    const left = plan(manifest, target.appDir, survivors);
    left.anchors = left.anchors.filter((a) => fs.existsSync(path.join(target.appDir, a.file)));
    left.files = left.files.filter((f) => fs.existsSync(path.join(target.appDir, f.to)));
    fs.writeFileSync(ledgerFile, JSON.stringify({
      ...ledger,
      createdFiles: (ledger.createdFiles || []).filter((p) => !removed.has(p)),
      overwritten: Object.fromEntries(Object.entries(overwritten).filter(([p]) => !removed.has(p))),
    }, null, 2));
    writeLedger(target.appDir, left, manifest, survivors);
    say(`  ✔ 还剩 ${survivors.length} 个功能族在装：${survivors.map((m) => m.id).join(', ')}（开机自动重注入保持注册）`);
    say('\n  上游文件本体没动过：撤掉的那几个锚点已回到原版样子。');
    return;
  }
  const r = unregisterAutostart(target.appDir);
  say(`  ${r.ok ? '✔' : '·'} 开机自动重注入：${r.message}`);
  for (const extra of ['mods/installed.json', 'mods/mods.json', 'mods/reapply.mjs', 'mods/reapply.cjs',
    'mods/anchors-lib.mjs', 'mods/blocks/preload-main.js', 'mods/README.md']) {
    fs.rmSync(path.join(target.appDir, extra), { force: true });
  }
  // 只收空壳：目录里还有别的东西就留着，不替用户删他放进 mods/ 的文件
  ['mods/blocks', 'mods'].forEach((d) => { try { fs.rmdirSync(path.join(target.appDir, d)); } catch (_) { } });
  say('\n  上游文件本体没动过：撤完就是原版。备份留在 resources/app/mods-backup/ 里，要回滚直接拷。');
}

function status(target, manifest) {
  const ledgerFile = path.join(target.appDir, 'mods', 'installed.json');
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (_) { }
  if (!ledger) { say('  这个 app 目录里没装过 mineradio-mods。'); return; }
  say(`  装过：v${ledger.packVersion}（${ledger.installedAt}），功能族 ${ledger.mods.join(', ')}`);
  const drift = Object.entries(ledger.anchorsSnapshot || {}).filter(([file, hash]) => {
    const full = path.join(target.appDir, file);
    return !fs.existsSync(full) || sha(fs.readFileSync(full)) !== hash;
  });
  if (drift.length) {
    say(`  ⚠ 有 ${drift.length} 个上游文件在装完之后被换过（多半是软件更新或重装）：${drift.map((d) => d[0]).join(', ')}`);
    say('    → 跑一次 `node install.mjs --go` 重新注入即可（锚点会按 locator 重新插回去）。');
  } else say('  上游文件与装外挂时一致，没被换过。');
  const missing = (ledger.files || []).filter((f) => !fs.existsSync(path.join(target.appDir, f.to)));
  say(missing.length ? `  ⚠ 外挂文件缺 ${missing.length} 个：${missing.map((m) => m.to).join(', ')}` : '  外挂文件都在。');
  const auto = autostartStatus();
  say(`  开机自动重注入：${auto.installed ? `已注册（${auto.detail}）` : '未注册'}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      path: { type: 'string' }, go: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false },
      uninstall: { type: 'boolean', default: false }, autostart: { type: 'boolean', default: false },
      mod: { type: 'string', multiple: true, default: [] }, help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    // 把文件开头那段注释当帮助文本：按收尾的 ==== 划线，加几行用法也不用再改这里的行号
    const lines = fs.readFileSync(path.join(PACK, 'install.mjs'), 'utf8').split('\n');
    const end = lines.findIndex((l, i) => i > 1 && /^\/\/ ?={5,}/.test(l));
    lines.slice(1, end > 0 ? end : 24).forEach((l) => say(l.replace(/^\/\/ ?/, '')));
    return;
  }
  const manifest = loadManifest();
  const positional = (values['--'] || []).concat([]);
  const given = values.path || positional[0] || '';
  // 没给路径时，卸载可以从当前目录起手（把包解压进安装目录那种用法）
  let target = resolveAppDir(given || (values.uninstall && process.cwd()) || '');
  if (given && !target) {
    // 明说了 --path 就不能再退回自动探测：那样会把外挂写进另一个目录里，
    // 而另一个往往就是用户正在用的那一份（README 的 .live 步骤没跑起来时最容易踩）
    say(`指定的目录里没认出 Mineradio：${path.resolve(given)}`);
    say('  要的是安装根目录、resources\\app、或 Mineradio.exe 本身；这个目录要么不存在，要么不是原版布局。');
    say('  想让安装器自己找：把 --path 去掉。');
    process.exitCode = 2; return;
  }
  if (!target) {
    const found = detect();
    if (!found.length) {
      say('没找到 Mineradio 安装目录。用 --path 指给它（安装根目录、resources\\app、或 Mineradio.exe 都行）。');
      process.exitCode = 2; return;
    }
    if (found.length > 1) {
      say('找到好几个 Mineradio，先说清要装哪个（--path）：');
      found.forEach((f) => say('  ' + f.dir + (f.version ? `  (v${f.version})` : '')));
      process.exitCode = 2; return;
    }
    target = found[0];
  }
  // detect.mjs 交的是 {dir,root,exe,version}，后面统一用 appDir 这个名字
  target = { appDir: target.dir, root: target.root, exe: target.exe, version: target.version };
  // 越界防护：别把外挂装进包自己的源码（files/ 与 blocks/）。
  // .live/ 与 .fixture/ 这两个沙箱目录是故意允许试验的（README 的真跑验证就在里面跑）。
  const appAbs = path.resolve(target.appDir);
  const forbidden = [path.join(PACK, 'files'), path.join(PACK, 'blocks')];
  if (forbidden.some((p) => appAbs === p || appAbs.startsWith(p + path.sep))) {
    say('目标目录在外挂包自己的源码里，拒绝执行（防越界）。'); process.exitCode = 2; return;
  }

  if (values.status) { status(target, manifest); return; }
  // --mod 写错名字不能当成"什么都没选"继续跑：那会写出一份空台账，或让卸载悄悄落空
  const known = new Set(manifest.mods.map((m) => m.id));
  const typo = values.mod.filter((id) => !known.has(id));
  if (typo.length) {
    say(`--mod 里没有这个功能族：${typo.join(', ')}`);
    say('  可选：' + manifest.mods.map((m) => m.id + (m.enabled === false ? '（未开）' : '')).join(', '));
    process.exitCode = 2; return;
  }
  const mods = enabledMods(manifest, values.mod);
  if (!mods.length) { say('选中的功能族都没启用，没什么可做的。'); process.exitCode = 2; return; }
  const target2 = { ...target, anchors: [], files: [] };
  const t = plan(manifest, target.appDir, mods);
  Object.assign(target2, t);
  const states = readState(target2, manifest);
  const { bad } = report(target2, states, manifest, mods);
  if (values.verify || values.status) {
    // verify 的语义是"现在这个状态能不能用"：锚点被更新冲掉就是不能用，
    // 只报 drift 不算失败是错的（第一次实演就在这里漏了红）
    const todo = states.filter((s) => ['todo','stale'].includes(s.state));
    if (values.verify && todo.length) say('✖ 有 ' + todo.length + ' 项没到位（多半是软件更新把上游文件换掉了），跑 node install.mjs --go 补回');
    process.exitCode = (bad.length || (values.verify && todo.length)) ? 1 : 0; return;
  }
  if (values.uninstall) { uninstall(target2, manifest, { ...values, mods }); return; }
  if (bad.length) { process.exitCode = 1; return; }
  apply(target2, states, manifest, { ...values, mods });
  if (!values.go) { say('\n这是干跑，什么都没写。确认无误后加 --go。'); return; }
  if (values.autostart) {
    const r = registerAutostart({ appDir: target2.appDir, exe: target2.exe, packDir: PACK });
    say(`  ${r.ok ? '✔' : '✖'} 开机自动重注入：${r.message}`);
  }
  const after = readState(target2, manifest);
  const left = after.filter((s) => !['ok'].includes(s.state));
  say(left.length ? `\n装完仍有 ${left.length} 项没到位：${left.map((s) => (s.spec || s.file).id || s.spec?.file || s.file.to).join(', ')}` : '\n装完了。重启 Mineradio 生效（正在开着的那份不会自己换代码）。');
  process.exitCode = left.length ? 1 : 0;
}

main().catch((e) => { say('[安装器异常] ' + ((e && e.stack) || e)); process.exitCode = 1; });

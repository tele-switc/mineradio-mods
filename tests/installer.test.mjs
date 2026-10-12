// ============================================================
//  安装器自测：全程在临时目录里跑，不碰任何真的 Mineradio
//
//  夹具是**上游原版 2.2.0**（基线提交 d43de56）的 resources/app，
//  从旁边的开发仓库 `git archive` 出来；没有那个仓库就整组跳过并说明原因。
//  为什么非要真原版：外挂包要装在别人手上，别人那份一个字都没改过。
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyAnchor, removeAnchor, readAnchor } from '../lib/anchors.mjs';
import { prepareFixture, skipReason, DEV_REPO, fixtureDir } from './fixture.mjs';

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = fixtureDir(PACK);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACK, 'mods.json'), 'utf8'));

const fixture = prepareFixture(PACK, DEV_REPO);
function skip(t) { return skipReason(t, fixture); }

function tmpApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-mods-test-'));
  const app = path.join(dir, 'resources', 'app');
  fs.cpSync(FIXTURE, app, { recursive: true });
  return { dir, app };
}

// 清单里的 blockLines 与 install.mjs 一样从 blockFrom 读，测试要复现同一份解析
function anchors() {
  return MANIFEST.anchors.map((a) => ({
    ...a,
    blockLines: a.blockFrom
      ? fs.readFileSync(path.join(PACK, a.blockFrom), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)
      : a.block || [],
  }));
}

function applyAll(app, list) {
  for (const spec of list) {
    const file = path.join(app, spec.file);
    const before = fs.readFileSync(file, 'utf8');
    const res = applyAnchor(before, spec, MANIFEST.marker, MANIFEST.packVersion);
    assert.equal(res.action === 'drift', false, `锚点 ${spec.id} 在上游原版里找不到注入位置：${spec.file}`);
    fs.writeFileSync(file, res.text);
  }
}

function snapshotTree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r));
    }
  };
  walk('');
  return out;
}

// 下面这几条要跑**真的安装器**（子进程），因为出事的是 install.mjs 那层的
// 路径判断、备份与台账，lib/anchors.mjs 自己那一层是好的。
// 状态目录一律指到临时目录：开机自启那条 Run 键是全局的，测试不能碰用户机器上那份。
function installer(args, env) {
  const base = { ...process.env, ...(env || {}) };
  if (!base.MINERADIO_MODS_STATE) base.MINERADIO_MODS_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mods-state-'));
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(PACK, 'install.mjs'), ...args],
      { encoding: 'utf8', cwd: PACK, env: base, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
const marked = (app, rel) => {
  try { return (String(fs.readFileSync(path.join(app, rel), 'utf8')).match(/<<mineradio-mods:/g) || []).length; }
  catch (_) { return -1; }
};
const UPSTREAM_FILES = ['public/js/index-loader.js', 'desktop/main.js', 'server.js',
  'public/js/modules/05-playback/13-playback-start-audio.js', 'desktop/preload.js'];

test('清单自洽：每个功能族声明的锚点存在、要投放的文件在包里', () => {
  const byId = anchors().reduce((acc, a) => { acc[a.id] = a; return acc; }, {});
  for (const mod of MANIFEST.mods) {
    for (const id of mod.anchors || []) assert.ok(byId[id], `${mod.id} 声明了不存在的锚点 ${id}`);
    for (const f of mod.files || []) {
      assert.ok(fs.existsSync(path.join(PACK, f.from)), `${mod.id} 的文件没在包里：${f.from}`);
      assert.ok(!path.isAbsolute(f.to) && !f.to.includes('..'), `${f.to} 必须是 app 目录内的相对路径`);
    }
    for (const dep of mod.requires || []) {
      assert.ok(MANIFEST.mods.some((m) => m.id === dep), `${mod.id} 依赖不存在的功能族 ${dep}`);
    }
  }
});

test('上游原版里八个锚点都找得到位置', (t) => {
  if (skip(t)) return;
  for (const spec of anchors()) {
    const info = readAnchor(fs.readFileSync(path.join(FIXTURE, spec.file), 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion);
    assert.equal(info.installed, false, `${spec.id} 在原版里本来不该有`);
    assert.equal(info.drift, false, `${spec.id} 定位不到（${spec.mode} @ ${spec.file}）`);
  }
});

test('注入后四个上游文件仍是合法 JS，且重复注入结果一样', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    const list = anchors();
    applyAll(app, list);
    for (const rel of ['server.js', 'desktop/main.js', 'desktop/preload.js', 'public/js/index-loader.js']) {
      execFileSync(process.execPath, ['--check', path.join(app, rel)], { stdio: 'pipe' });
    }
    const once = snapshotTree(app);
    applyAll(app, list);
    const twice = snapshotTree(app);
    for (const key of Object.keys(once)) {
      assert.deepEqual(twice[key] && twice[key].toString('hex'), once[key].toString('hex'),
        `第二次注入改变了 ${key}（幂等失败）`);
    }
    for (const spec of list) {
      const info = readAnchor(fs.readFileSync(path.join(app, spec.file), 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion);
      assert.equal(info.installed, true, `${spec.id} 注入后读不回来`);
      assert.equal(info.matches, true, `${spec.id} 注入内容与清单不一致`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('卸载回到原版：逐文件字节比对', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    const list = anchors();
    const pristine = {};
    for (const spec of list) pristine[spec.file] = fs.readFileSync(path.join(app, spec.file));
    applyAll(app, list);
    for (const spec of list) {
      const file = path.join(app, spec.file);
      const res = removeAnchor(fs.readFileSync(file, 'utf8'), spec, MANIFEST.marker);
      assert.equal(res.changed, true, `${spec.id} 撤不掉`);
      fs.writeFileSync(file, res.text);
    }
    for (const spec of list) {
      const after = fs.readFileSync(path.join(app, spec.file));
      assert.equal(after.toString('binary'), pristine[spec.file].toString('binary'),
        `${spec.file} 撤完和原版不一样（行尾或空行被改了）`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('软件更新把上游文件换掉之后，重跑一次就能全部恢复', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    const list = anchors();
    applyAll(app, list);
    // 模拟更新：上游那五个文件被新版本整份替换（内容按原版还原 = 标记没了）
    for (const spec of list) {
      fs.copyFileSync(path.join(FIXTURE, spec.file), path.join(app, spec.file));
    }
    const lost = list.filter((spec) => readAnchor(
      fs.readFileSync(path.join(app, spec.file), 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion).installed === false);
    assert.equal(lost.length, list.length, '更新后锚点应该全丢（这条断言是在确认模拟方式没错）');
    applyAll(app, list);
    for (const spec of list) {
      const info = readAnchor(fs.readFileSync(path.join(app, spec.file), 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion);
      assert.equal(info.matches, true, `重注入后 ${spec.id} 没到位`);
    }
    execFileSync(process.execPath, ['--check', path.join(app, 'server.js')], { stdio: 'pipe' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('上游把锚点周围代码挪走时要报 drift 而不是瞎插', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    const spec = anchors().find((a) => a.id === 'server-routes');
    const file = path.join(app, 'server.js');
    // 上游把 const pn = url.pathname; 改名了
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('const pn = url.pathname;', 'const pathnameOnly = url.pathname;'));
    const res = applyAnchor(fs.readFileSync(file, 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion);
    assert.equal(res.action, 'drift');
    assert.equal(res.changed, false, '定位不到时一个字都不该写');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ============ 下面这些是"跑真安装器"的回归测试 ============
// 出问题的从来不是锚点算法，是安装器外面那一层：目标目录怎么定的、覆盖前备不备份、
// 卸载撤得干不干净、--mod 的作用域。这几条都是照着"别人电脑上真会踩到"写的。

test('--path 指到认不出的目录时必须报错，不许退回自动探测去写另一份', (t) => {
  if (skip(t)) return;
  // 用 LOCALAPPDATA 摆一份"自动探测会找到的另一份安装"：这就是用户自己那份的替身
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mods-decoy-'));
  const decoy = path.join(fake, 'Programs', 'Mineradio', 'resources', 'app');
  fs.cpSync(FIXTURE, decoy, { recursive: true });
  try {
    const r = installer(['--path', path.join(fake, '写错的那个目录', 'resources', 'app'), '--go'], { LOCALAPPDATA: fake });
    assert.equal(r.code, 2, `--path 认不出来就该停下来，实际退出码 ${r.code}：${r.out}`);
    assert.match(r.out, /写错的那个目录/, '要说清是哪个目录没认出来');
    const before = snapshotTree(FIXTURE); const after = snapshotTree(decoy);
    assert.equal(Object.keys(after).length, Object.keys(before).length,
      `另一份安装被加了文件：${Object.keys(after).filter((k) => !(k in before)).join(', ')}`);
    Object.keys(after).forEach((k) => assert.equal(after[k].toString('binary'), before[k].toString('binary'),
      `另一份安装被动了：${k}（--path 打错却写进了自动探测到的目录）`));
  } finally { fs.rmSync(fake, { recursive: true, force: true }); }
});

test('目标位置上已经有同名文件：先备份原件再覆盖，卸载时还原原件而不是删掉', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    const mine = '这份文件是我自己放的，外挂不能悄悄吃掉它\r\n';
    ['public/quick-search.html', 'desktop/mods-host.js'].forEach((f) => fs.writeFileSync(path.join(app, f), mine));
    const r = installer(['--path', app, '--go']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /备份/, '覆盖别人文件时要说一句"原件已备份"');
    const bakRoot = path.join(app, 'mods-backup');
    const stamp = fs.readdirSync(bakRoot)[0];
    const bak = snapshotTree(path.join(bakRoot, stamp));
    ['public/quick-search.html', 'desktop/mods-host.js'].forEach((f) =>
      assert.equal(bak[f] && bak[f].toString('utf8'), mine, `备份里没存住原件：${f}`));
    const u = installer(['--path', app, '--uninstall', '--go']);
    assert.equal(u.code, 0, u.out);
    ['public/quick-search.html', 'desktop/mods-host.js'].forEach((f) => {
      assert.ok(fs.existsSync(path.join(app, f)), `卸载把本来就存在的文件删掉了：${f}`);
      assert.equal(fs.readFileSync(path.join(app, f), 'utf8'), mine, `卸载没还原原件：${f}`);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('卸载要卸干净：app 目录里不留下任何原版没有的文件（含重注入脚本那份副本）', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    assert.equal(installer(['--path', app, '--go']).code, 0);
    assert.ok(fs.existsSync(path.join(app, 'mods', 'reapply.mjs')), '装的时候该把重注入脚本连同它的依赖一起放进去');
    assert.equal(marked(app, 'desktop/preload.js'), 1);
    const u = installer(['--path', app, '--uninstall', '--go']);
    assert.equal(u.code, 0, u.out);
    const stock = snapshotTree(FIXTURE); const after = snapshotTree(app);
    const leftover = Object.keys(after).filter((k) => !k.startsWith('mods-backup/') && !(k in stock));
    assert.deepEqual(leftover, [], `卸载后残留：${leftover.join(', ')}（README 说"删投放的文件"，残留的副本会让下一版软件多出一块砖）`);
    UPSTREAM_FILES.forEach((f) => assert.equal(after[f].toString('binary'), stock[f].toString('binary'),
      `卸载后 ${f} 与原版不一样（行尾或多空行）`));
    assert.ok(fs.existsSync(path.join(app, 'mods-backup')), '备份是故意留着的，卸载不该连备份一起删');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--uninstall --mod 只撤那一族，共用锚点与别的族的文件都不许动', (t) => {
  if (skip(t)) return;
  // 这一条不写死"哪个锚点属于哪一族"：族数从 4 涨到 6 之后，原来那条断言（main-process
  // 只属于 quick-search）当场就过时了 —— 硬编归属的测试会比代码先坏，反而盖住真问题。
  // 现在改成从 mods.json 现算：这一族独占什么就撤什么，跟别族共用的一个字都不许动。
  const enabled = MANIFEST.mods.filter((m) => m.enabled !== false);
  const target = enabled.find((m) => m.id === 'quick-search') || enabled[0];
  const others = enabled.filter((m) => m !== target);
  const byId = new Map(anchors().map((a) => [a.id, a]));
  const otherAnchors = new Set(others.flatMap((m) => m.anchors || []));
  const ownAnchors = (target.anchors || []).filter((id) => !otherAnchors.has(id));
  const sharedAnchors = (target.anchors || []).filter((id) => otherAnchors.has(id));
  const otherFiles = new Set(others.flatMap((m) => (m.files || []).map((f) => f.to)));
  const ownFiles = (target.files || []).map((f) => f.to).filter((to) => !otherFiles.has(to));
  const sharedFiles = (target.files || []).map((f) => f.to).filter((to) => otherFiles.has(to));

  const { dir, app } = tmpApp();
  try {
    assert.equal(installer(['--path', app, '--go']).code, 0);
    const r = installer(['--path', app, '--uninstall', '--mod', target.id, '--go']);
    assert.equal(r.code, 0, r.out);

    ownAnchors.forEach((id) => {
      const info = readAnchor(fs.readFileSync(path.join(app, byId.get(id).file), 'utf8'),
        byId.get(id), MANIFEST.marker, MANIFEST.packVersion);
      assert.equal(info.installed, false, `${id} 只有这一族在用，撤掉${target.id}就该撤掉它`);
    });
    sharedAnchors.forEach((id) => {
      const spec = byId.get(id);
      const info = readAnchor(fs.readFileSync(path.join(app, spec.file), 'utf8'), spec, MANIFEST.marker, MANIFEST.packVersion);
      assert.equal(info.installed, true, `${id} 还与 ${others.map((m) => m.id).join('/')} 共用，撤了别人就瞎了`);
      assert.equal(info.matches, true, `${id} 被改动过：应当原样留着`);
    });
    ownFiles.forEach((f) => assert.ok(!fs.existsSync(path.join(app, f)), `${target.id} 独占的文件该删：${f}`));
    sharedFiles.forEach((f) => assert.ok(fs.existsSync(path.join(app, f)), `还在用的文件被删了：${f}`));
    // 现在六族互相共用锚点，独占锚点这一支是空的；上面 ownAnchors 的断言只在将来出现
    // 独占锚点时才会跑到 —— 这里明说，免得以后有人以为这条测试什么都没验
    if (!ownAnchors.length) {
      assert.ok(sharedAnchors.length > 0, '至少要真验到"共用锚点没被动"');
    }

    const ledger = JSON.parse(fs.readFileSync(path.join(app, 'mods', 'installed.json'), 'utf8'));
    assert.deepEqual(ledger.mods, others.map((m) => m.id), '台账要按剩下的族重写');
    const survivor = others[0];
    assert.equal(installer(['--path', app, '--verify', '--mod', survivor.id]).code, 0,
      `剩下的族应该还验得过：${installer(['--path', app, '--verify', '--mod', survivor.id]).out}`);
    assert.match(fs.readFileSync(path.join(app, 'public/js/index-loader.js'), 'utf8'), /js\/mods\/loader\.js/);
    // 族名写错不能当成"什么都没选"闷声跑下去
    const typo = installer(['--path', app, '--uninstall', '--mod', 'quick-seach', '--go']);
    assert.equal(typo.code, 2, `--mod 名字写错应该报错：${typo.out}`);
    assert.match(typo.out, /quick-seach/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('app 目录里那份 mods/reapply.mjs 单独也跑得起来（更新后手工补一次）', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  try {
    assert.equal(installer(['--path', app, '--go']).code, 0);
    // 模拟软件更新：五个上游文件被整份换掉，外挂文件也没了
    for (const f of UPSTREAM_FILES) fs.copyFileSync(path.join(FIXTURE, f), path.join(app, f));
    fs.rmSync(path.join(app, 'public', 'quick-search.html'), { force: true });
    UPSTREAM_FILES.forEach((f) => assert.equal(marked(app, f), 0, `${f} 更新后本来不该有锚点`));
    const state = path.join(dir, 'no-such-state-dir');   // 状态目录被删过也不能崩
    let out = '';
    try {
      out = execFileSync(process.execPath, [path.join(app, 'mods', 'reapply.mjs')],
        { encoding: 'utf8', env: { ...process.env, MINERADIO_MODS_STATE: state } });
    } catch (e) { assert.fail(`跑不起来：${e.message}${e.stdout || ''}`); }
    UPSTREAM_FILES.forEach((f) => assert.equal(marked(app, f), f === 'server.js' ? 3 : f.includes('13-playback') ? 2 : 1,
      `${f} 没被补回来：${out}`));
    // 桥接那段是从 blocks/ 取的：拿不到就得跳过，不能插一对空标记骗过去
    assert.match(fs.readFileSync(path.join(app, 'desktop/preload.js'), 'utf8'), /desktopMods/,
      `preload-main 插成了空块：${out}`);
    Object.keys(snapshotTree(FIXTURE)).filter((k) => !UPSTREAM_FILES.includes(k))
      .forEach((f) => assert.equal(fs.existsSync(path.join(app, f)), true, `reapply 不该动原版其它文件：${f}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没注册过开机检查时，卸载不去新建状态目录、也不碰注册表', (t) => {
  if (skip(t)) return;
  const { dir, app } = tmpApp();
  const state = path.join(dir, 'never-registered', 'MineradioMods');
  try {
    assert.equal(installer(['--path', app, '--go']).code, 0);
    const u = installer(['--path', app, '--uninstall', '--go'], { MINERADIO_MODS_STATE: state });
    assert.equal(u.code, 0, u.out);
    assert.match(u.out, /没注册过/, `没注册过就该什么都不动：${u.out}`);
    assert.equal(fs.existsSync(state), false, '卸载凭空建了一个状态目录（里面只有一份空台账）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

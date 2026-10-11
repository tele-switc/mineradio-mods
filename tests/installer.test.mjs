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

const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_REPO = process.env.MINERADIO_DEV_REPO || 'E:/Projects/mineradio';
const BASELINE = 'd43de56';
const FIXTURE = path.join(PACK, '.fixture', 'stock-app');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACK, 'mods.json'), 'utf8'));

function buildFixture() {
  if (fs.existsSync(path.join(FIXTURE, 'server.js'))) return true;
  if (!fs.existsSync(path.join(DEV_REPO, '.git'))) return false;
  fs.mkdirSync(FIXTURE, { recursive: true });
  execFileSync('bash', ['-c',
    `git -C "${DEV_REPO}" archive ${BASELINE} | tar -x -C "${FIXTURE}"`,
  ], { stdio: 'inherit' });
  return fs.existsSync(path.join(FIXTURE, 'server.js'));
}

const haveFixture = buildFixture();
function skip(t) {
  if (haveFixture) return false;
  t.skip(`没有上游原版夹具（把开发仓库路径给 MINERADIO_DEV_REPO，或预置 .fixture/stock-app）`);
  return true;
}

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

test('上游原版里六个锚点都找得到位置', (t) => {
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

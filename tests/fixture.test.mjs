// ============================================================
//  夹具这一层的回归测试：解不出来要给出原因，不许把整组测试崩掉
//
//  真踩过的那次：把仓库 clone 到 %TEMP% 下面跑 `node --test tests/`，
//  旧写法（bash -c 里 git archive | tar -x -C "C:\..."）被 MSYS 的 tar 把
//  带盘符的路径当成远端主机，解包失败，异常直接抛在测试文件顶层——
//  整组红且看不出为什么。README 说的是"没有那个仓库就整组跳过并说明原因"。
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture, fixtureDir, skipReason, DEV_REPO, BASELINE } from './fixture.mjs';

const REPO = path.resolve(import.meta.dirname, '..');   // 一个真 git 仓库，但没有上游那个基线提交

test('上游仓库不存在时返回原因，而不是抛异常', () => {
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-fixture-'));
  try {
    const r = prepareFixture(pack, path.join(pack, '没有这份仓库'));
    assert.equal(r.ok, false);
    assert.match(r.why, /没有上游开发仓库/);
    assert.equal(fs.existsSync(fixtureDir(pack)), false, '仓库都没有，不该先建个空的夹具目录');
    let skipped = '';
    const fake = { skip: (m) => { skipped = m; } };
    assert.equal(skipReason(fake, r), true, '拿不到夹具就该走 skip');
    assert.match(skipped, /MINERADIO_DEV_REPO/, '跳过的原因要告诉人家怎么补上');
  } finally { fs.rmSync(pack, { recursive: true, force: true }); }
});

test('仓库在但没有那个基线提交时也是给原因，不是崩', () => {
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-fixture-'));
  try {
    // 拿本仓库自己当"上游仓库"：.git 在，但 d43de56 这种上游提交不在
    const r = prepareFixture(pack, REPO, 'no-such-baseline-commit');
    assert.equal(r.ok, false, '解不出夹具必须返回 ok:false');
    assert.match(r.why, /no-such-baseline-commit/, `原因里要带上是哪一步失败的：${r.why}`);
    assert.equal(fs.existsSync(path.join(fixtureDir(pack), 'stock-fixture.tar')), false, '半成品 tar 包要清掉');
  } finally { fs.rmSync(pack, { recursive: true, force: true }); }
});

test('clone 在带盘符的临时目录里也解得开夹具（旧写法在这里必崩）', (t) => {
  if (!fs.existsSync(path.join(DEV_REPO, '.git'))) { t.skip(`没有 ${DEV_REPO}，这条没法验`); return; }
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-fixture-'));
  try {
    const r = prepareFixture(pack, DEV_REPO, BASELINE);
    assert.equal(r.ok, true, `解不开：%${r.why}`);
    assert.equal(fs.existsSync(path.join(fixtureDir(pack), 'server.js')), true, '上游原版该有 server.js');
    assert.equal(fs.existsSync(path.join(fixtureDir(pack), 'desktop', 'main.js')), true);
  } finally { fs.rmSync(pack, { recursive: true, force: true }); }
});

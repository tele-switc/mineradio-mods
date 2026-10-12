// ============================================================
//  找安装目录：README 说"各盘根目录的 Mineradio"也认，那就真得盘一遍
//  （以前只写死 D:\ 与 E:\，装在别的盘的人会收到"没找到 Mineradio 安装目录"）
//
//  这里只验探测清单的形状：不能漏盘，也不能去探没挂载的盘符
//  （探空光驱/断线的网络盘会卡几秒，Windows 上还可能弹窗）。
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveRoots, looksLikeAppDir, resolveAppDir } from '../lib/detect.mjs';

test('探测清单包含两个 Program Files 与各盘根目录', () => {
  const roots = driveRoots();
  assert.ok(Array.isArray(roots) && roots.length >= 3, `清单不该是空的：${JSON.stringify(roots)}`);
  assert.ok(roots.includes('C:\\Program Files'), 'Program Files 那份要保留');
  assert.ok(roots.includes('C:\\Program Files (x86)'));
  const drives = roots.filter((r) => /^[A-Za-z]:\\$/.test(r));
  assert.ok(drives.length >= 1, `盘符根一个都没探到：${JSON.stringify(roots)}`);
  assert.equal(new Set(drives).size, drives.length, '同一个盘不能探两遍');
  // 系统盘一定在里面：装在别的盘的那份也要能被认出来
  const sys = String(process.env.SystemDrive || 'C:').toUpperCase();
  assert.ok(drives.some((d) => d.toUpperCase() === sys + '\\'), `少了系统盘 ${sys}：${JSON.stringify(drives)}`);
});

test('探的都是真挂载的盘，且带 Mineradio 的那份能被认出来', () => {
  driveRoots().filter((r) => /^[A-Za-z]:\\$/.test(r)).forEach((base) => {
    assert.equal(fs.existsSync(base), true, `${base} 没挂载也去探，会白等几秒甚至弹窗`);
  });
  // 装在各盘根目录那种布局：<盘符>\Mineradio\resources\app
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-detect-'));
  try {
    const app = path.join(tmp, 'Mineradio', 'resources', 'app');
    fs.mkdirSync(path.join(app, 'desktop'), { recursive: true });
    fs.mkdirSync(path.join(app, 'public'), { recursive: true });
    ['desktop/main.js', 'server.js', 'public/index.html'].forEach((f) => fs.writeFileSync(path.join(app, f), '// x\n'));
    assert.equal(looksLikeAppDir(app), true, '原版布局该被认出来');
    assert.equal(looksLikeAppDir(path.join(tmp, 'Mineradio')), false, '安装根目录本身不是 app 目录');
    // 给安装根目录（README 说这种也认）要归一到 resources\app
    const got = resolveAppDir(path.join(tmp, 'Mineradio'));
    assert.ok(got && got.dir, '给安装根目录应该能找到 resources\\app');
    assert.equal(path.resolve(got.dir).toLowerCase(), path.resolve(app).toLowerCase(),
      `归一到别处去了：${got.dir}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

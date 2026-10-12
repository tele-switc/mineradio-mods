// ============================================================
//  上游原版夹具：从开发仓库 git archive 出基线提交那份 stock-app
//
//  为什么单独一个文件：这条路上栽过两次，都得能被单独测——
//   1) 以前是 `bash -c "git archive | tar -x -C "C:\...""`：MSYS 那个 tar 会把
//      带盘符的路径当成"远端主机:文件"，仓库 clone 到 %TEMP% 之类的位置就解不出来；
//   2) 解不出来时旧代码直接把异常抛在测试文件顶层，整组测试崩成红，
//      而 README 说的是"没有那个仓库就整组跳过并说明原因"。
//  现在不走 shell：git 自己写 tar 包，再用系统自带的 tar 在夹具目录里解出来
//  （两个参数都是相对路径，任何带盘符的路径都不会递进子进程），失败只返回原因。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEV_REPO = process.env.MINERADIO_DEV_REPO || 'E:/Projects/mineradio';
export const BASELINE = 'd43de56';

export function fixtureDir(pack) { return path.join(pack, '.fixture', 'stock-app'); }

function untarHere(cwd, tarName) {
  // System32 的 tar 是 bsdtar，认 Windows 路径；找不到再退回 PATH 上的那个
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const exe = fs.existsSync(sys) ? sys : 'tar';
  execFileSync(exe, ['-xf', tarName, '-C', '.'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

// 返回 { ok: true } 或 { ok: false, why: '为什么没有夹具' }——绝不往外抛
export function prepareFixture(pack, devRepo = DEV_REPO, baseline = BASELINE) {
  const dir = fixtureDir(pack);
  if (fs.existsSync(path.join(dir, 'server.js'))) return { ok: true, dir };
  if (!devRepo || !fs.existsSync(path.join(devRepo, '.git'))) {
    return { ok: false, dir, why: `没有上游开发仓库：${devRepo || '(没设)'}` };
  }
  fs.mkdirSync(dir, { recursive: true });
  const tarName = 'stock-fixture.tar';
  try {
    execFileSync('git', ['-C', devRepo, 'archive', '--format=tar', '-o',
      path.join(dir, tarName).replace(/\\/g, '/'), baseline], { stdio: ['ignore', 'pipe', 'pipe'] });
    untarHere(dir, tarName);
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).split(/\r?\n/).filter(Boolean)[0] || '未知错误';
    return { ok: false, dir, why: `从 ${devRepo} 取 ${baseline} 失败：${why}` };
  } finally {
    try { fs.rmSync(path.join(dir, tarName), { force: true }); } catch (_) { }
  }
  if (!fs.existsSync(path.join(dir, 'server.js'))) {
    return { ok: false, dir, why: `夹具解出来了但没有 server.js（${baseline} 不在那份仓库里？）` };
  }
  return { ok: true, dir };
}

// 给"没有夹具就整组跳过"的测试用：一句说明为什么跳，别让人以为是真的过了
export function skipReason(t, fixture) {
  if (fixture.ok) return false;
  t.skip(`没有上游原版夹具（${fixture.why}）——把仓库路径给 MINERADIO_DEV_REPO，或预置 .fixture/stock-app`);
  return true;
}

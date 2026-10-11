// ============================================================
//  "软件更新后外挂不消失"这一条的实现
//
//  关键判断：**能活过更新的东西不能放在 resources/app 里**。
//  更新/重装会把整个 resources/app 换掉（锚点被抹掉正是我们要修的事），
//  所以重注入要用的那份外挂本体放在 %LOCALAPPDATA%\MineradioMods\ 下：
//      pack/            外挂本体（文件 + mods.json + 桥接块）
//      reapply.cjs      检查并重新注入（用 Mineradio.exe 自带的 Node 跑，不要求对方装 Node）
//      reapply.vbs      无窗口启动器（Run 键指的就是它）
//      targets.json     管着哪几个安装目录
//      reapply.log      每次动手都写一行，出问题能查
//
//  触发方式：HKCU 的 Run 键（登录时跑一次，不需要管理员，卸载就是删这个键）。
//  README 里会把这件事写在最前面：开机检查一次，发现上游文件被换过就重新注入。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const STATE_DIR = process.env.MINERADIO_MODS_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MineradioMods');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'MineradioMods';

function copyTree(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) { if (name !== 'node_modules') copyTree(s, d, filter); continue; }
    if (filter && !filter(s)) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
  }
}

function readTargets() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'targets.json'), 'utf8')); } catch (_) { return []; }
}

function writeTargets(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'targets.json'), JSON.stringify(list, null, 2));
}

export function registerAutostart({ appDir, exe, packDir }) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    copyTree(path.join(packDir, 'files'), path.join(STATE_DIR, 'pack'), (p) => !/\.map$/.test(p));
    copyTree(path.join(packDir, 'blocks'), path.join(STATE_DIR, 'pack', 'blocks'));
    fs.copyFileSync(path.join(packDir, 'mods.json'), path.join(STATE_DIR, 'mods.json'));
    fs.copyFileSync(path.join(packDir, 'lib', 'anchors.mjs'), path.join(STATE_DIR, 'anchors-lib.mjs'));
    fs.copyFileSync(path.join(packDir, 'files', 'mods', 'reapply.mjs'), path.join(STATE_DIR, 'reapply.mjs'));
    const targets = readTargets().filter((t) => t.appDir !== appDir);
    targets.push({ appDir, exe: exe || '', addedAt: new Date().toISOString() });
    writeTargets(targets);
    // VBS 里不解析 JSON：给启动器单独留一行 exe 路径，读起来不会出错
    const exes = targets.map((t) => t.exe).filter((p) => p && fs.existsSync(p));
    fs.writeFileSync(path.join(STATE_DIR, 'exe.txt'), (exes[0] || exe || '') + '\r\n');
    const vbs = path.join(STATE_DIR, 'reapply.vbs');
    fs.writeFileSync(vbs, [
      'Option Explicit',
      'Dim sh, fso, state, exe',
      'Set sh = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'state = fso.GetParentFolderName(WScript.ScriptFullName)',
      'If Not fso.FileExists(state & "\\exe.txt") Then WScript.Quit 0',
      'exe = Trim(fso.OpenTextFile(state & "\\exe.txt", 1).ReadLine())',
      'If Not fso.FileExists(exe) Then WScript.Quit 0',
      '// 用 Mineradio.exe 自带的 Node 跑重注入，不要求对方电脑上装 Node',
      'sh.Environment("PROCESS").Item("ELECTRON_RUN_AS_NODE") = "1"',
      'sh.Run Chr(34) & exe & Chr(34) & " " & Chr(34) & state & "\\reapply.mjs" & Chr(34), 0, False',
      '',
    ].join('\r\n'));
    execFileSync('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ',
      '/d', `C:\\Windows\\System32\\wscript.exe //B "${vbs}"`, '/f'], { windowsHide: true });
    return { ok: true, message: `已注册登录时自动检查（${vbs}）` };
  } catch (e) {
    return { ok: false, message: '注册失败：' + ((e && e.message) || e) };
  }
}

export function unregisterAutostart(appDir) {
  try {
    execFileSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (_) { /* 没注册过就是没有 */ }
  // 只把自己这条从台账里划掉：机器上装着两份 Mineradio 时，卸一份不能把另一份的开机检查弄没
  const targets = appDir ? readTargets().filter((t) => path.resolve(t.appDir) !== path.resolve(appDir)) : readTargets();
  writeTargets(targets);
  fs.writeFileSync(path.join(STATE_DIR, 'exe.txt'),
    (targets.map((t) => t.exe).filter((p) => p && fs.existsSync(p))[0] || '') + '\r\n');
  if (targets.length) return { ok: true, message: `已取消这个目录的开机检查（还有 ${targets.length} 个目录在管）` };
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (_) { }
  return { ok: true, message: '已取消开机检查并清掉状态目录' };
}

export function autostartStatus() {
  try {
    const text = execFileSync('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = String(text).split(/\r?\n/).find((l) => l.includes(RUN_VALUE)) || '';
    return { installed: true, detail: line.trim() };
  } catch (_) {
    return { installed: false, detail: '' };
  }
}

// ============================================================
//  找 Mineradio 装在哪
//
//  别人机器上的位置千奇百怪（NSIS 默认在 %LOCALAPPDATA%\Programs\Mineradio，
//  也可以自己挑盘；我们这份是 E:\Projects\mineradio 这种"仓库即安装目录"）。
//  所以这里只认一个硬事实：**app 目录里有 desktop/main.js + server.js + public/index.html**。
//  认不出来的目录一律不碰，宁可让人手动 --path。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const APP_MARKERS = [
  path.join('desktop', 'main.js'),
  'server.js',
  path.join('public', 'index.html'),
];

export function looksLikeAppDir(dir) {
  if (!dir) return false;
  try {
    return APP_MARKERS.every((rel) => fs.statSync(path.join(dir, rel)).isFile());
  } catch (_) {
    return false;
  }
}

// 给一个目录（安装根 / app 目录 / 甚至 exe），归一成 app 目录
export function resolveAppDir(input) {
  if (!input) return '';
  let dir = path.resolve(String(input).replace(/^"|"$/g, ''));
  const out = {};
  const tryPaths = [
    dir,
    path.join(dir, 'resources', 'app'),
    dir.endsWith('.exe') ? path.join(path.dirname(dir), 'resources', 'app') : '',
    path.join(path.dirname(dir), 'resources', 'app'),
  ].filter(Boolean);
  for (const p of tryPaths) if (looksLikeAppDir(p)) { out.dir = p; break; }
  if (!out.dir) return null;
  out.root = path.dirname(path.dirname(out.dir));
  out.exe = [path.join(out.root, 'Mineradio.exe'), path.join(out.root, 'mineradio.exe')]
    .find((p) => fs.existsSync(p)) || '';
  let version = '';
  try { version = String(JSON.parse(fs.readFileSync(path.join(out.dir, 'package.json'), 'utf8')).version || ''); } catch (_) { }
  out.version = version;
  return out;
}

function localPrograms() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [path.join(base, 'Programs', 'Mineradio')];
}

// 正在跑的那个 Mineradio 的 exe 路径（用 PowerShell 问，不依赖 wmic——Win11 已经没 wmic 了）
function runningExe() {
  try {
    const text = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-Process Mineradio -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -First 1",
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const line = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line || '';
  } catch (_) {
    return '';
  }
}

export function detect() {
  const seen = new Set();
  const found = [];
  const push = (dir) => {
    const app = resolveAppDir(dir);
    if (!app || seen.has(app.dir)) return;
    seen.add(app.dir);
    found.push(app);
  };
  push(runningExe());
  localPrograms().forEach(push);
  ['C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\', 'E:\\'].forEach((base) => {
    ['Mineradio', 'mineradio'].forEach((name) => push(path.join(base, name)));
  });
  return found;
}

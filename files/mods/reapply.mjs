// ============================================================
//  开机自动重注入（由 %LOCALAPPDATA%\MineradioMods\reapply.vbs 用 Mineradio.exe
//  自带的 Node 跑起来，不需要对方电脑上装 Node）
//
//  它只做一件事：对着 targets.json 里那些安装目录，检查
//   1) 六个锚点还在不在上游文件里；
//   2) 外挂本体文件还在不在；
//  少了就补上（备份 + 写日志），都在就什么都不做。
//
//  为什么需要它：软件更新/重装会把 resources/app 整个换掉，注入的那几行随之消失。
//  这件事在 README 最前面写着，不想被开机检查的人：安装时不加 --autostart，
//  或者 `node install.mjs --uninstall` 一并撤掉。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyAnchor } from './anchors-lib.mjs';

const STATE = process.env.MINERADIO_MODS_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MineradioMods');
const manifest = JSON.parse(fs.readFileSync(path.join(STATE, 'mods.json'), 'utf8'));
const targets = JSON.parse(fs.readFileSync(path.join(STATE, 'targets.json'), 'utf8') || '[]');
const logFile = path.join(STATE, 'reapply.log');

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  try { fs.appendFileSync(logFile, text + '\n'); } catch (_) { }
}

function blockOf(spec) {
  return { ...spec, blockLines: spec.blockFrom
    ? fs.readFileSync(path.join(STATE, 'pack', spec.blockFrom.replace(/^blocks\//, 'blocks/')), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)
    : (spec.block || []) };
}

function reapplyOne(target) {
  const appDir = target.appDir;
  if (!fs.existsSync(path.join(appDir, 'server.js'))) { log(`跳过（不像 Mineradio 的 app 目录）：${appDir}`); return 0; }
  let fixed = 0;
  for (const raw of manifest.anchors) {
    const spec = blockOf(raw);
    const file = path.join(appDir, spec.file);
    if (!fs.existsSync(file)) { log(`缺上游文件，跳过锚点 ${spec.id}：${spec.file}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    if (new RegExp(`//\\s*<<${manifest.marker}:${spec.id}\\b`).test(text)) continue; // 还在，不动
    const res = applyAnchor(text, spec, manifest.marker, manifest.packVersion);
    if (res.action === 'drift') { log(`⚠ 锚点 ${spec.id} 在 ${spec.file} 里找不到注入位置（上游改了那块代码），需要人工更新 mods.json 的 locator`); continue; }
    if (!res.changed) continue;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const bak = path.join(appDir, 'mods-backup', `reapply-${stamp}`, spec.file);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(file, bak);
    fs.writeFileSync(file, res.text);
    log(`重新注入锚点 ${spec.id} → ${spec.file}（原件备份在 ${path.relative(appDir, bak)}）`);
    fixed += 1;
  }
  const packFiles = manifest.mods.filter((m) => m.enabled !== false)
    .reduce((acc, m) => acc.concat((m.files || []).map((f) => ({ ...f, mod: m.id }))), []);
  for (const f of packFiles) {
    const src = path.join(STATE, 'pack', path.relative('files', f.from.replace(/\\/g, '/')));
    const dst = path.join(appDir, f.to);
    if (!fs.existsSync(src)) { log(`外挂包里缺 ${f.from}`); continue; }
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    log(`补回外挂文件 ${f.to}`);
    fixed += 1;
  }
  return fixed;
}

let total = 0;
for (const target of targets) {
  try { total += reapplyOne(target); } catch (e) { log('检查失败：' + ((e && e.message) || e)); }
}
log(total ? `完成：补回 ${total} 项。下次启动 Mineradio 就是带外挂的状态。` : `完成：一切正常，没动任何文件。`);

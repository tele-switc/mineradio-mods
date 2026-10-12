// ============================================================
//  开机自动重注入（由 %LOCALAPPDATA%\MineradioMods\reapply.vbs 用 Mineradio.exe
//  自带的 Node 跑起来，不需要对方电脑上装 Node）
//
//  同一个文件也放一份在安装目录的 resources\app\mods\ 里：状态目录被清过、
//  或者根本就没注册过开机检查时，手工跑它也能把锚点补回来（那时只补锚点，
//  文件备货在 %LOCALAPPDATA%\MineradioMods\pack\ 里）。
//
//  它只做一件事：对着 targets.json 里那些安装目录，检查
//   1) 八个锚点还在不在上游文件里；
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
import { fileURLToPath } from 'node:url';
import { applyAnchor } from './anchors-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.MINERADIO_MODS_STATE
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MineradioMods');
// 这份脚本可能跑在两个地方：%LOCALAPPDATA%\MineradioMods\（开机那一次）或安装目录的 mods\ 里（手工补一次）。
// 清单先认脚边那份，再退回状态目录 —— 状态目录可能被清过，手工跑的时候不能因此整个崩掉。
const manifestFile = [path.join(HERE, 'mods.json'), path.join(STATE, 'mods.json')].find((p) => fs.existsSync(p));
if (!manifestFile) { console.log(`[reapply] 找不到 mods.json（看过 ${HERE} 与 ${STATE}），什么都不做。`); process.exit(0); }
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const targetsFile = path.join(STATE, 'targets.json');
const targets = fs.existsSync(targetsFile) ? (JSON.parse(fs.readFileSync(targetsFile, 'utf8') || '[]')) : [];
// 手工跑安装目录里那一份时（mods.json 就在自己脚边），要管的都是自己所在的那份 app 目录
const selfApp = (manifestFile === path.join(HERE, 'mods.json') && path.basename(HERE) === 'mods')
  ? path.dirname(HERE) : '';
const list = targets.length ? targets : (selfApp ? [{ appDir: selfApp, exe: '' }] : []);
if (!list.length) {
  console.log(`[reapply] 既没有 ${targetsFile}，也不在某份 app 目录里（这里是 ${HERE}）：不知道该管谁，什么都不做。`);
  process.exit(0);
}
const logFile = path.join(STATE, 'reapply.log');
// 外挂本体的备货只有状态目录那一份：app 目录里的那些一更新就没了，正是它要来补的东西
const packRoot = fs.existsSync(path.join(STATE, 'pack')) ? path.join(STATE, 'pack') : '';

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  try { fs.appendFileSync(logFile, text + '\n'); } catch (_) { }
}

function blockOf(spec) {
  if (!spec.blockFrom) return { ...spec, blockLines: spec.block || [] };
  const from = [path.join(HERE, spec.blockFrom), path.join(STATE, 'pack', spec.blockFrom)]
    .find((p) => fs.existsSync(p));
  // 拿不到代码段就返回 null 让调用方跳过这个锚点：插一对空标记比不插更糟
  if (!from) return null;
  return { ...spec, blockLines: fs.readFileSync(from, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/) };
}

function reapplyOne(target) {
  const appDir = target.appDir;
  if (!fs.existsSync(path.join(appDir, 'server.js'))) { log(`跳过（不像 Mineradio 的 app 目录）：${appDir}`); return 0; }
  let fixed = 0;
  for (const raw of manifest.anchors) {
    const spec = blockOf(raw);
    if (!spec) { log(`⚠ 拿不到代码段 ${raw.blockFrom}，跳过锚点 ${raw.id}`); continue; }
    const file = path.join(appDir, spec.file);
    if (!fs.existsSync(file)) { log(`缺上游文件，跳过锚点 ${spec.id}：${spec.file}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    if (new RegExp(`//\\s*<<${manifest.marker}:${spec.id}\\b`).test(text)) continue; // 还在，不动
    const res = applyAnchor(text, spec, manifest.marker, manifest.packVersion);
    if (res.action === 'drift') { log(`⚠ 锚点 ${spec.id} 在 ${spec.file} 里找不到注入位置（上游改了那块代码），需要人工更新 mods.json 的 locator`); continue; }
    if (!res.changed) continue;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const bak = path.join(appDir, 'mods-backup', `reapply-${stamp}`, spec.file);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(file, bak);
    fs.writeFileSync(file, res.text);
    log(`重新注入锚点 ${spec.id} → ${spec.file}（原件备份在 ${path.relative(appDir, bak)}）`);
    fixed += 1;
  }
  const packFiles = manifest.mods.filter((m) => m.enabled !== false)
    .reduce((acc, m) => acc.concat((m.files || []).map((f) => ({ ...f, mod: m.id }))), []);
  if (!packRoot) { log('状态目录里没有 pack 备货，只补锚点、不补文件'); return fixed; }
  for (const f of packFiles) {
    const src = path.join(packRoot, path.relative('files', f.from.replace(/\\/g, '/')));
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
for (const target of list) {
  try { total += reapplyOne(target); } catch (e) { log('检查失败：' + ((e && e.message) || e)); }
}
log(total ? `完成：补回 ${total} 项。下次启动 Mineradio 就是带外挂的状态。` : `完成：一切正常，没动任何文件。`);

#!/usr/bin/env node
// ============================================================
//  预检 tools/live-check.mjs 里每一条"送给页面的表达式"
//
//  为什么要这么一个小工具：live-check 是端到端真跑，一趟 8~10 分钟，
//  而模板字符串里少写一个右括号这种事，只有跑到那一条断言时才会炸
//  —— 于是每次都是跑了七分钟才在中间停下来（真发生过三次）。
//  这个脚本把 88 条表达式全部抽出来单独解析，两秒钟告诉你哪一条不配平。
//
//  它只看语法，不看语义（表达式引用了谁、页面在不在，它不管）。
//  Runtime.evaluate 既收单个表达式也收多语句脚本，所以两种写法都试一遍，
//  都不过才算错。${...} 插值统一当成字符串占位，不影响配平判断。
//
//  用法：node tools/check-page-expressions.mjs [文件路径]
// ============================================================

import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BT = String.fromCharCode(96);
const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, 'live-check.mjs');

const src = fs.readFileSync(target, 'utf8');
let idx = 0;
let found = 0;
const bad = [];

while (true) {
  const at = src.indexOf('.ev(', idx);
  if (at < 0) break;
  const open = src.indexOf(BT, at);
  const close = src.indexOf(BT, open + 1);
  // .ev( 与反引号之间只允许几个空白/参数名字符，否则说明这条不是我们要看的那种调用
  if (open < 0 || close < 0 || src.slice(at, open).replace(/\s/g, '').length > 12) { idx = at + 4; continue; }
  const raw = src.slice(open + 1, close);
  const line = src.slice(0, open).split('\n').length;
  idx = close + 1;
  if (!raw.trim()) continue;
  found += 1;
  const expr = raw.replace(/\$\{[^}]*\}/g, '"zz"');
  try {
    try { new Function('return (' + expr + ')'); }
    catch (e1) { new Function(expr); }
  } catch (e2) {
    bad.push({ line, msg: e2.message, head: raw.slice(0, 80).replace(/\n/g, ' ') });
  }
}

console.log(`从 ${path.basename(target)} 抽到 ${found} 条送给页面的表达式`);
if (!bad.length) {
  console.log('全部语法通过');
  process.exitCode = 0;
} else {
  bad.forEach((b) => console.log(`  ✖ 第 ${b.line} 行：${b.msg}  ← ${b.head}…`));
  console.log(`共 ${bad.length} 条不配平 —— 先修完再跑 live-check，别拿八分钟去换一行报错`);
  process.exitCode = 1;
}

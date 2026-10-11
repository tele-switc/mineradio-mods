// ============================================================
//  锚点协议：外挂往上游核心文件里注入的那几行，长什么样、怎么找、怎么撤
//
//  为什么不用 .patch / git apply：补丁认的是"上下文行"，上游一改那块代码就冲突，
//  普通人修不了。这里认的是**成对标记**：
//      // <<mineradio-mods:main-process v1>>
//      ...注入的那几行...
//      // >>mineradio-mods:main-process
//  有标记就原地替换（改外挂内容不用先卸载），没标记就按 locator 找位置插进去，
//  标记和 locator 都找不到就报 drift 让人来看——绝不猜位置。
//
//  三条硬规矩：
//   1. 幂等：跑一次和跑五次结果一样（软件更新后重跑就是靠这个）；
//   2. 可撤：uninstall 只删标记块，别的一行不碰；
//   3. 行尾照抄原文件：打包过程会把行尾改成 CRLF，插 LF 行会让 diff 里整篇都是改动。
// ============================================================

const OPEN = (marker, id, version) => `// <<${marker}:${id} v${version}>>`;
const CLOSE = (marker, id) => `// >>${marker}:${id}`;

// 统一按 LF 处理，写回时再还原成原文件的行尾
export function splitLines(text) {
  return String(text).split(/\r?\n/);
}

export function dominantEol(text) {
  const crlf = (String(text).match(/\r\n/g) || []).length;
  const lf = (String(text).match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function joinLines(lines, eol) {
  return lines.join(eol);
}

function findMarkerRange(lines, marker, id) {
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*//\\s*<<${marker}:${id}\\b`).test(lines[i])) { open = i; break; }
  }
  if (open < 0) return null;
  const closeRe = new RegExp(`^\\s*//\\s*>>${marker}:${id}\\s*$`);
  for (let i = open + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) return { start: open, end: i, body: lines.slice(open + 1, i) };
  }
  // 只有开头没有结尾 = 上次被人为截断，按"到文件末尾"处理并让调用方报警
  return { start: open, end: lines.length - 1, body: lines.slice(open + 1), truncated: true };
}

// 按 locator 找"该插在哪一行后面"
function findInsertPoint(lines, spec) {
  if (spec.mode === 'append') return lines.length;
  if (spec.mode === 'insert-after') {
    const re = new RegExp(spec.locator);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
    return -1;
  }
  if (spec.mode === 'insert-before') {
    const re = new RegExp(spec.locator);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  }
  if (spec.mode === 'array-append') {
    const at = lines.findIndex((line) => line.includes(spec.arrayLocator));
    if (at < 0) return -1;
    for (let i = at + 1; i < lines.length; i++) if (/^\s*\];/.test(lines[i])) return i;
    return -1;
  }
  return -1;
}

export function readAnchor(text, spec, marker, version) {
  const lines = splitLines(text);
  const range = findMarkerRange(lines, marker, spec.id);
  if (!range) {
    const at = findInsertPoint(lines, spec);
    return { id: spec.id, installed: false, drift: at < 0, position: at < 0 ? null : at };
  }
  const expected = spec.blockLines || [];
  const same = range.body.length === expected.length
    && range.body.every((line, i) => line.trim() === String(expected[i]).trim());
  return {
    id: spec.id,
    installed: true,
    matches: same && !range.truncated,
    truncated: !!range.truncated,
    version: (/v(\d+)/.exec(lines[range.start]) || [])[1] || '',
    lines: [range.start + 1, range.end + 1],
    body: range.body,
  };
}

// 插入或原地替换；返回 { changed, text }
export function applyAnchor(text, spec, marker, version) {
  const eol = dominantEol(text);
  const lines = splitLines(text);
  const block = [OPEN(marker, spec.id, version)].concat(spec.blockLines || [], [CLOSE(marker, spec.id)]);
  const range = findMarkerRange(lines, marker, spec.id);
  if (range) {
    const before = joinLines(lines, eol);
    const next = lines.slice(0, range.start).concat(block, lines.slice(range.end + 1));
    const out = joinLines(next, eol);
    return { changed: out !== before, text: out, action: range.truncated ? 'repaired' : 'replaced' };
  }
  const at = findInsertPoint(lines, spec);
  if (at < 0) return { changed: false, text, action: 'drift', error: `找不到注入位置（${spec.mode}）` };
  const pad = at === lines.length ? ['', '// 上面这段之后是 mineradio-mods 外挂的注入点，卸载时整段删掉即可。'] : [];
  const next = lines.slice(0, at).concat(pad, block, lines.slice(at));
  return { changed: true, text: joinLines(next, eol), action: 'inserted' };
}

export function removeAnchor(text, spec, marker) {
  const eol = dominantEol(text);
  const lines = splitLines(text);
  const range = findMarkerRange(lines, marker, spec.id);
  if (!range) return { changed: false, text, action: 'absent' };
  // 顺带把 append 模式下我们加的那句说明一起清掉
  let start = range.start;
  if (start > 1 && /mineradio-mods 外挂的注入点/.test(lines[start - 1])) start -= 2;
  const next = lines.slice(0, start).concat(lines.slice(range.end + 1));
  return { changed: true, text: joinLines(next, eol), action: 'removed' };
}

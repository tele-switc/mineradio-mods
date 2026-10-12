// ============================================================
//  存档落盘层（desktop/mods-danger-archive-store.js）：2026-10-12 新加的 label 与 manual 种类
//
//  为什么单独测这一层：改名这条路上有个坑只有落盘层能踩到 —— 用 remove + append 顶替
//  setLabel 的话，条目会被挤到列表最前面，用户看到的时间线就乱了；而 label 是新字段，
//  normalizeArchive 的白名单如果没放行，改名当下在界面上是好的，重开面板就没了。
//  这两件事都必须钉在测试里，不能靠"看起来对"。
//
//  只测**这个文件里那三条记录能不能存、能不能改、能不能读回来**，用临时目录，
//  绝不碰 %APPDATA%\Mineradio 里正在用的那份 mineradio-danger-archive.json。
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DangerArchiveStore, DANGER_ARCHIVE_LABEL_MAX, DANGER_ARCHIVE_KINDS } = require(
  '../files/desktop/mods-danger-archive-store.js',
);

// 一个够真的存档：三条 localStorage 原始字符串（store 只认键名，不看内容）
function makeState() {
  return {
    'mineradio-search-history': JSON.stringify({ version: 3, items: ['落日飞车', '坂本龙一'] }),
    'mineradio-last-playback-v1': JSON.stringify({ version: 1, queue: [{ id: '1', name: '美声浮世绘' }], current: { id: '1', name: '美声浮世绘' } }),
    'mineradio-listen-stats-v1': JSON.stringify({ history: [{ key: 'k1', name: '美声浮世绘', listenMs: 200000 }], songs: {}, artists: {} }),
  };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-archive-test-'));
  // t.after 只在这个用例里注册，rmSync 的目标就是这一条 mkdtemp 出来的目录
  return { dir, store: new DangerArchiveStore({ userDataPath: dir }) };
}

function appendRecord(store, overrides) {
  const createdAt = Date.now();
  return store.append(Object.assign({
    id: 'archive-' + createdAt + '-abc',
    createdAt,
    kind: 'manual',
    reason: 'manual-snapshot',
    summary: { searchItems: 2, queueLength: 1, listenRecords: 1, listenMinutes: 3 },
    state: makeState(),
  }, overrides || {}));
}

test('文件不存在时是"还没有存档"，不是读失败', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = store.read();
  assert.equal(read.ok, true);
  assert.equal(read.document.archives.length, 0);
  assert.equal(read.missing, true, 'missing 要标出来：上层靠它区分"首次使用"和"文件坏了"');
});

test('kind=manual 存进去能原样读回来（新那颗「存一份当前状态」用的就是它）', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appended = appendRecord(store, { kind: 'manual' });
  assert.equal(appended.ok, true);
  const read = store.read();
  assert.equal(read.ok, true);
  assert.equal(read.document.archives.length, 1);
  assert.equal(read.document.archives[0].kind, 'manual',
    'store 的 kind 白名单不放行 manual 的话，新存的存档会被静默改成 clear，界面上就是"手动"变成"清空前"');
  assert.deepEqual(read.document.archives[0].state['mineradio-search-history'],
    makeState()['mineradio-search-history'], 'state 必须是原始字符串，一个字节都不能被"顺手规范化"');
});

test('label 是新字段：白名单没放行的话改名会存了个寂寞', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(DANGER_ARCHIVE_KINDS.indexOf('manual') >= 0, true);
  appendRecord(store, { label: '  给 A 场景留的  ' });
  const read = store.read();
  assert.equal(read.document.archives[0].label, '给 A 场景留的', '首尾空格要削掉，中间的留着');
});

test('setLabel 只动 label：id / createdAt / kind / state 与顺序都不变', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const older = appendRecord(store, { id: 'archive-1000-old', createdAt: 1000 });
  assert.equal(older.ok, true);
  const newer = appendRecord(store, { id: 'archive-2000-new', createdAt: 2000 });
  assert.equal(newer.ok, true);

  const before = store.read().document.archives;
  assert.equal(before.length, 2);
  assert.equal(before[0].id, 'archive-2000-new', '新在前');

  const renamed = store.setLabel('archive-2000-new', '第一次改名');
  assert.equal(renamed.ok, true);
  const after = store.read().document.archives;
  assert.equal(after[0].id, 'archive-2000-new',
    '改名把条目挤到列表前面 = 用 remove + append 顶替了 set-label，时间线会乱');
  assert.equal(after[0].label, '第一次改名');
  assert.equal(after[1].label, '', '另一条不该被牵连');
  assert.equal(after[0].createdAt, 2000);
  assert.equal(after[0].kind, 'manual');
  assert.deepEqual(after[0].state, before[0].state, '恢复读的就是这份 state，改名不许动它');

  const emptied = store.setLabel('archive-2000-new', '   ');
  assert.equal(emptied.ok, true);
  assert.equal(store.read().document.archives[0].label, '', '名字清空 = 回到没标注，不是留下空白');

  const missing = store.setLabel('archive-does-not-exist', 'x');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'DANGER_ARCHIVE_NOT_FOUND');
});

test('label 长度有上限（截到 DANGER_ARCHIVE_LABEL_MAX，不是整段塞进文件）', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  appendRecord(store, { label: 'x'.repeat(DANGER_ARCHIVE_LABEL_MAX + 200) });
  const read = store.read();
  assert.equal(read.document.archives[0].label.length, DANGER_ARCHIVE_LABEL_MAX);
});

test('不认识的种类（旧文件的 clear、手改的乱码）退回 clear，但条目必须保住', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.append({ kind: 'clear', createdAt: 500, state: makeState(), summary: {} });
  // 直接改写文件，模拟"外部塞进来一个我们不认的 kind"
  const file = path.join(dir, 'mineradio-danger-archive.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.archives[0].kind = 'something-future';
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');

  const read = store.read();
  assert.equal(read.ok, true);
  assert.equal(read.document.archives.length, 1,
    '这条是用户唯一的备份，不能因为一个显示字段不在白名单就把整条丢掉');
  assert.equal(read.document.archives[0].kind, 'clear');
  assert.equal(typeof read.document.archives[0].label, 'string', '旧文件没这个字段也得补成空串，别让界面读到 undefined');
});

test('state 里只认那三个键，别的东西一律丢掉（这文件是磁盘上的不可信输入）', () => {
  const { dir, store } = freshStore();
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = makeState();
  state['mineradio-something-else'] = 'not-ours';
  state['mineradio-listen-stats-v1'] = { history: [] };
  const appended = appendRecord(store, { state });
  assert.equal(appended.ok, true);
  const kept = store.read().document.archives[0].state;
  assert.equal(Object.keys(kept).length, 2, '第四个键与"值不是字符串"的那条都该被丢掉');
  assert.equal(kept['mineradio-search-history'], state['mineradio-search-history']);
});

// ============================================================
//  口味档案落盘层（desktop/mods-taste-store.js）自测
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TasteProfileStore, TASTE_FILE } = require(
  '../files/desktop/mods-taste-store.js',
);

function tempStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-taste-test-' + (label || '') + '-'));
  return { dir, store: new TasteProfileStore({ userDataPath: dir }) };
}

test('口味档案：文件不存在时是正常空文档，不是错误', () => {
  const { dir, store } = tempStore('missing');
  const res = store.read();
  assert.equal(res.ok, true);
  assert.equal(res.missing, true);
  assert.equal(typeof res.document, 'object');
  assert.equal(Object.keys(res.document.songs).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('口味档案：写进去再读回来是同一份，带来源与权重', () => {
  const { dir, store } = tempStore('roundtrip');
  const doc = {
    version: 1,
    enabled: true,
    strength: 'standard',
    songs: {
      '晴天': { key: '晴天', name: '晴天', artist: '周杰伦', weight: 4.5, hits: 3, sources: { 'file:a.txt:1': 2 } },
    },
    artists: {
      '周杰伦': { name: '周杰伦', weight: 3, hits: 2, sources: { 'file:a.txt:1': 2 } },
    },
    sources: {
      'file:a.txt:1': { id: 'file:a.txt:1', kind: 'file', label: 'a.txt', count: 1, addedAt: 123 },
    },
  };
  const written = store.save(doc);
  assert.equal(written.ok, true);
  const back = store.read();
  assert.equal(back.ok, true);
  assert.equal(back.missing, false);
  assert.equal(back.document.songs['晴天'].artist, '周杰伦');
  assert.equal(back.document.sources['file:a.txt:1'].label, 'a.txt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('口味档案：读坏时拒绝覆盖', () => {
  const { dir, store } = tempStore('corrupt');
  fs.writeFileSync(path.join(dir, TASTE_FILE), '{ broken json', 'utf8');
  const bad = store.read();
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'TASTE_CORRUPT');
  const denied = store.save({ songs: {} });
  assert.equal(denied.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('口味档案：超字节上限按权重从低往高丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-taste-test-small-'));
  const store = new TasteProfileStore({ userDataPath: dir, maxBytes: 1200 });
  const many = { songs: {}, artists: {}, sources: {} };
  for (let i = 0; i < 60; i++) {
    many.songs['s' + i] = { name: 'Song ' + i, artist: 'A', weight: i + 1, hits: 1, sources: { 'file:x:1': 1 } };
  }
  const saved = store.save(many);
  assert.equal(saved.ok, true);
  assert.ok(saved.dropped >= 1);
  const back = store.read();
  const keys = Object.keys(back.document.songs);
  assert.ok(keys.length < 60);
  assert.ok(keys.some((k) => back.document.songs[k].weight === 60), '最铁的那首留在档案里');
  fs.rmSync(dir, { recursive: true, force: true });
});

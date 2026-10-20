// ============================================================
//  mineradio-mods: 网易云超级增强与双擎日推漫游自动化测试
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACK, 'mods.json'), 'utf8'));

test('mods.json 包含 netease-supercharged 且声明自洽', () => {
  const mod = MANIFEST.mods.find(m => m.id === 'netease-supercharged');
  assert.ok(mod, 'mods.json 必须注册 netease-supercharged 功能族');
  assert.equal(mod.enabled, true, '必须默认启用');
  assert.ok(Array.isArray(mod.anchors) && mod.anchors.includes('server-routes'));
  assert.ok(Array.isArray(mod.anchors) && mod.anchors.includes('renderer-modules'));

  // 验证声明的文件都必须真实存在
  for (const f of mod.files) {
    const full = path.join(PACK, f.from);
    assert.ok(fs.existsSync(full), `声明的文件必须存在于包内: ${f.from}`);
  }
});

test('loader.js 包含了 70-netease-supercharged.js', () => {
  const loaderSource = fs.readFileSync(path.join(PACK, 'files', 'public', 'js', 'mods', 'loader.js'), 'utf8');
  assert.match(loaderSource, /70-netease-supercharged\.js/, 'loader.js 必须加载 70-netease-supercharged.js');
});

test('server-api.js mapNcmSong 正确格式化普通歌曲与云盘歌曲', () => {
  const serverApi = require(path.join(PACK, 'files', 'mods', 'server-api.js'));
  const mapper = serverApi.mapNcmSong;
  assert.ok(typeof mapper === 'function', 'server-api.js 必须导出 mapNcmSong 函数');

  // Case 1: 标准网易云歌曲结构
  const standardSong = {
    id: 1827600686,
    name: '向云端',
    ar: [{ id: 12085562, name: '小霞' }, { id: 12174057, name: '海洋Bo' }],
    al: { id: 129188176, name: '向云端', picUrl: 'https://p1.music.126.net/cov.jpg' },
    dt: 243000,
  };
  const m1 = mapper(standardSong);
  assert.equal(m1.provider, 'netease');
  assert.equal(m1.id, 1827600686);
  assert.equal(m1.name, '向云端');
  assert.equal(m1.artist, '小霞 / 海洋Bo');
  assert.equal(m1.album, '向云端');
  assert.equal(m1.cover, 'https://p1.music.126.net/cov.jpg');
  assert.equal(m1.duration, 243000);
  assert.equal(m1.playable, true);

  // Case 2: 简单或兜底字段
  const fallbackSong = {
    songId: 998877,
    songName: '私人录音.mp3',
    artist: '独立音乐人',
    album: '自制合辑',
    duration: 180000,
  };
  const m2 = mapper(fallbackSong);
  assert.equal(m2.provider, 'netease');
  assert.equal(m2.id, 998877);
  assert.equal(m2.name, '私人录音.mp3');
  assert.equal(m2.artist, '独立音乐人');
});

test('server-api.js 接管所有网易云增强端点且无异常抛出', () => {
  const serverApi = require(path.join(PACK, 'files', 'mods', 'server-api.js'));
  const tryHandle = serverApi.tryHandle;
  assert.ok(typeof tryHandle === 'function', 'server-api.js 必须导出 tryHandle');

  const endpoints = [
    '/api/feed/super-daily',
    '/api/personal_fm',
    '/api/fm_trash',
    '/api/playmode/intelligence/list',
    '/api/song/similar',
    '/api/user/cloud',
    '/api/user/cloud/del',
    '/api/toplist',
    '/api/toplist/detail',
    '/api/user/record',
    '/api/record/recent/song',
    '/api/artist/songs',
    '/api/artist/albums',
  ];

  for (const ep of endpoints) {
    const fakeReq = { method: 'GET' };
    let sentStatus = 200;
    let sentData = null;
    const fakeRes = {
      writeHead: (status) => { sentStatus = status; },
      end: (data) => { sentData = data; },
    };
    const fakeUrl = new URL('http://localhost:3000' + ep + '?id=123');

    const handled = tryHandle(fakeReq, fakeRes, fakeUrl, ep);
    assert.equal(handled, true, `端点 ${ep} 必须被 server-api tryHandle 捕获接管`);
  }
});

test('70-netease-supercharged.js 包含全套核心方法与链接识别', () => {
  const code = fs.readFileSync(path.join(PACK, 'files', 'public', 'js', 'mods', '70-netease-supercharged.js'), 'utf8');

  // 核心功能点检查
  assert.match(code, /startPersonalFmMode/, '必须提供私人 FM 开启方法');
  assert.match(code, /startSuperDailyFeedMode/, '必须提供双擎日推漫游启动方法');
  assert.match(code, /trashCurrentFmTrack/, '必须提供私人 FM 垃圾桶（不再推荐）功能');
  assert.match(code, /startSongIntelligenceMode/, '必须提供心动模式开启方法');
  assert.match(code, /loadSongSimilarTracks/, '必须提供听相似歌曲功能');

  // 虚拟歌单入口检查
  assert.match(code, /super-daily-feed/, '必须置顶双擎日推刷歌漫游入口');
  assert.match(code, /netease-cloud-disk/, '必须置顶音乐云盘 / 本地私有仓入口');
  assert.match(code, /netease-recent-played/, '必须置顶最近播放歌曲入口');
  assert.match(code, /netease-toplist/, '必须置顶官方排行榜入口');

  // 分享链接识别正则
  const testUrl = 'https://music.163.com/#/playlist?id=3778678';
  const match = testUrl.match(/music\.163\.com.*?[?&]id=(\d+)/i);
  assert.ok(match, '正则必须能识别网易云歌单分享链接');
  assert.equal(match[1], '3778678');
});

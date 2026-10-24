// ============================================================
//  外挂包：全局只播能完整听完的歌 + 实时反馈
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACK, 'mods.json'), 'utf8'));
const engine = require(path.join(PACK, 'files/mods/recommendation-engine.js'));
const serverApi = require(path.join(PACK, 'files/mods/server-api.js'));

function tempAppData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-mods-test-'));
  const old = process.env.APPDATA;
  process.env.APPDATA = dir;
  return () => {
    if (old === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

test('mods.json 注册了 full-playback-only，且锚点/文件齐全', () => {
  const mod = MANIFEST.mods.find(item => item.id === 'full-playback-only');
  assert.ok(mod, '必须有 full-playback-only 功能族');
  assert.equal(mod.enabled, true);
  assert.ok(mod.anchors.includes('renderer-modules'));
  assert.ok(mod.anchors.includes('playback-full-guard'));
  assert.ok(mod.files.some(file => file.to === 'public/js/mods/75-full-playback-only.js'));
  for (const file of mod.files) {
    assert.ok(fs.existsSync(path.join(PACK, file.from)), `文件不存在：${file.from}`);
  }

  const anchor = MANIFEST.anchors.find(item => item.id === 'playback-full-guard');
  assert.ok(anchor, '必须声明 playback-full-guard 锚点');
  assert.equal(anchor.file, 'public/js/modules/05-playback/13-playback-start-audio.js');
  assert.match(anchor.block.join('\n'), /__mrModsGuardPlaybackData/);

  const netease = MANIFEST.mods.find(item => item.id === 'netease-supercharged');
  assert.ok(netease.files.some(file => file.to === 'mods/recommendation-engine.js'));
});

test('loader 会加载 75 号模块', () => {
  const loader = fs.readFileSync(path.join(PACK, 'files/public/js/mods/loader.js'), 'utf8');
  assert.match(loader, /75-full-playback-only\.js/);
});

test('所有外挂 JS 文件语法可解析（防正则反斜杠丢失）', () => {
  const roots = [
    path.join(PACK, 'files/public/js/mods'),
    path.join(PACK, 'files/mods'),
    path.join(PACK, 'files/desktop'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(root, name);
      assert.doesNotThrow(
        () => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }),
        `语法错误：${file}`
      );
    }
  }
});

test('引擎判据：试听/会员/无版权/pl=0 都不算完整可播', () => {
  const netease = { provider: 'netease', id: 1, name: 'x', artist: 'y' };
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, fee: 0 }), true);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, fee: 8 }), true);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, fee: 1 }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, fee: 1 }, { neteaseVip: true }), true);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, fee: 4 }, { neteaseVip: true }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, trial: true }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, freeTrialInfo: { start: 0 } }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, privilege: { st: -200, pl: 0 } }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, privilege: { st: 0, pl: 0 } }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ ...netease, noCopyrightRcmd: { type: 1 } }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ provider: 'bilibili', id: 'BV1' }), true);
  assert.equal(engine.ncmSongIsFullyPlayable({ provider: 'qishui', id: 9, trial: true }), false);
  assert.equal(engine.ncmSongIsFullyPlayable({ provider: 'local', localUrl: 'file:///a.mp3' }), true);
});

test('关键词清理与实时反馈种子', () => {
  const restore = tempAppData();
  try {
    const seeds = engine.extractTasteSeeds({
      keywords: ['wasted', 'wa', '古风bgm', '猎魔女团bgm合集', "猎魔女团b'g'm", 'undefined'],
      artists: ['Sik World', 'Sik World', '未知歌手'],
      anchorSongs: [{ name: 'Wasted', artist: 'Juice WRLD', plays: 1, raw: { completed: 1 } }],
      history: [{ name: 'Wasted', artist: 'Juice WRLD', completed: true, listenMs: 120000 }],
      trashKeys: ['trash-key-1'],
      skips: [{ name: '晴天', artist: '周杰伦', count: 2 }],
    });
    assert.ok(seeds.keywords.includes('wasted'));
    assert.ok(seeds.keywords.includes('古风bgm'));
    assert.ok(seeds.keywords.includes('猎魔女团bgm合集'));
    assert.ok(!seeds.keywords.includes('wa'));
    assert.ok(!seeds.keywords.includes("猎魔女团b'g'm"));
    assert.deepEqual(seeds.artists, ['Sik World']);
    assert.ok(seeds.trashKeys.includes('trash-key-1'));
    assert.ok(seeds.skipKeys.includes(engine.tasteTitleKey({ name: '晴天', artist: '周杰伦' })));
    assert.equal(seeds.skipArtists['周杰伦'], 2);
    assert.ok(seeds.heardSongs.some(song => song.name === 'Wasted' && song.artist === 'Juice WRLD'));
  } finally {
    restore();
  }
});

test('锚点清洗：从 B 站装饰标题还原搜索词', () => {
  assert.equal(
    engine.cleanTasteQuery('永不Wasted！百万级录音棚听《Wasted》Juice WRLD / Lil Uzi Vert'),
    'Wasted Juice WRLD / Lil Uzi Vert'
  );
  assert.equal(
    engine.cleanTasteQuery('“就这个古风拼好歌爽！”|《古风DJ大串烧》降调'),
    '古风DJ大串烧 降调'
  );
  assert.equal(engine.cleanTasteQuery('猎魔女团主题曲全收集12首'), '猎魔女团主题曲');
});

test('server-api mapNcmSong 带上可播性字段', () => {
  const mapped = serverApi.mapNcmSong({
    id: 123,
    name: '晴天',
    ar: [{ name: '周杰伦' }],
    al: { name: '叶惠美', picUrl: 'https://p1.music.126.net/x.jpg' },
    dt: 269000,
    fee: 1,
    privilege: { st: 0, pl: 0, fee: 1 },
  });
  assert.equal(mapped.fee, 1);
  assert.equal(mapped.privilege.pl, 0);
  assert.equal(mapped.privilege.st, 0);
  assert.equal(mapped.playable, true);
});

test('75 号模块包含搜索/歌单过滤、试听硬闸门与实时反馈', () => {
  const code = fs.readFileSync(path.join(PACK, 'files/public/js/mods/75-full-playback-only.js'), 'utf8');
  assert.match(code, /__mrModsGuardPlaybackData/);
  assert.match(code, /trial_only/);
  assert.match(code, /fetchMusicSearchResults/);
  assert.match(code, /fetchPlaylistTracksPage/);
  assert.match(code, /FEEDBACK_KEY/);
  assert.match(code, /__mrModsBuildTasteSeeds/);
  assert.match(code, /recordSkipIfNeeded/);
  assert.match(code, /window\.nextTrack/);
  assert.match(code, /restoreLastPlaybackSnapshot/);
});

test('70 号模块改为实时 POST 并写入本机垃圾桶', () => {
  const code = fs.readFileSync(path.join(PACK, 'files/public/js/mods/70-netease-supercharged.js'), 'utf8');
  assert.match(code, /mrBuildDailySeeds/);
  assert.match(code, /method: 'POST'/);
  assert.match(code, /__mrModsBuildTasteSeeds/);
  assert.match(code, /__mrModsMarkTrash/);
  assert.match(code, /hiddenUnplayable/);
  assert.doesNotMatch(code, /if \(typeof window\.fetchNextPersonalFmTracks !== 'function'\)/);
});

'use strict';

// 口味档案与搜索个性化（mineradio-mods 外挂层）回归测试。
// 跑的是真实外挂源码逻辑，界面与落盘副作用沙箱打桩。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const tastePath = path.join(repoRoot, 'files', 'public', 'js', 'mods', '60-taste-profile.js');
const overlayPath = path.join(repoRoot, 'files', 'public', 'quick-search.html');
const loaderPath = path.join(repoRoot, 'files', 'public', 'js', 'mods', 'loader.js');
const modsJsonPath = path.join(repoRoot, 'mods.json');
const preloadPath = path.join(repoRoot, 'blocks', 'preload-main.js');
const hostPath = path.join(repoRoot, 'files', 'desktop', 'mods-host.js');
const cssPath = path.join(repoRoot, 'files', 'public', 'css', 'mods-taste-profile.css');

const tasteSource = fs.readFileSync(tastePath, 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}() in 60-taste-profile.js`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) regex = false;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '/') {
      let previousIndex = index - 1;
      while (previousIndex >= bodyStart && /\s/.test(source[previousIndex])) previousIndex -= 1;
      const previous = source[previousIndex] || '';
      if (!previous || /[=(,:;!&|?{}\[]/.test(previous)) {
        regex = true;
        regexClass = false;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}

function topLevelArrayLiteral(source, name) {
  const hit = new RegExp(`var ${name} = (\\[[^\\]]*\\]);`).exec(source);
  assert.ok(hit, `missing var ${name} in 60-taste-profile.js`);
  return `var ${name} = ${hit[1]};`;
}

function topLevelObjectLiteral(source, name) {
  const declaration = new RegExp(`var ${name} = \\{`).exec(source);
  assert.ok(declaration, `missing var ${name} in 60-taste-profile.js`);
  let depth = 0;
  for (let index = declaration.index + declaration[0].length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (!depth) return source.slice(declaration.index, index + 1) + ';';
    }
  }
  throw new Error(`unterminated var ${name}`);
}

const SANDBOX_STRENGTHS = topLevelObjectLiteral(tasteSource, 'TASTE_STRENGTHS');
const STRENGTHS = vm.runInNewContext(`${SANDBOX_STRENGTHS}\nTASTE_STRENGTHS;`);

const SANDBOX_PRELUDE = `
var TASTE_ARTIST_FUZZY_LIMIT = 300;
${SANDBOX_STRENGTHS}
var listenStatsState = { history: [], songs: {}, artists: {}, updatedAt: 0 };
var tasteProfileState = tasteEmptyDocument();
var tasteViewCache = { signature: '', songs: {}, artists: {}, artistKeys: [] };
function tasteSaveProfile() { tasteProfileState.updatedAt = 1700000000000; }
function tasteWriteLocal() { }
function tasteBridge() { return null; }
function tasteRecount() { return {}; }
function tasteRerankOpenSearchResults() { return false; }
function renderTasteModal() { }
function tasteToast() { }
`;

function freshView() {
  return 'tasteViewCache = { signature: "", songs: {}, artists: {}, artistKeys: [] };';
}

const PURE_FUNCTIONS = [
  'tastePlainObject', 'tasteEmptyDocument', 'tasteNormalizeText', 'tasteIsNoiseArtist', 'tasteArtistParts',
  'tasteTitleKey', 'tasteEvidenceScale', 'tasteNormalizeSourceCounts', 'tasteNormalizeDocument', 'tasteStrength',
  'tasteSearchEnabled', 'tasteListenSignature', 'tasteProfileSignature', 'tasteBuildListenIndex', 'tasteMergeEntry',
  'tasteCapEntrySources', 'tasteView', 'tasteHasData', 'tasteFindArtistEntry', 'tasteArtistsOverlap', 'tasteSourceLabel', 'tasteReasonLabel',
  'tasteReasonDetail', 'tasteMatchSong', 'tasteClearMarks', 'applyTasteSearchBoost', 'tasteMergeSongEntry',
  'tasteMergeArtistEntry', 'tasteIngestRows', 'tasteTrimDocument', 'tasteRemoveSource',
];

function buildTasteSandbox() {
  const names = Array.from(new Set(PURE_FUNCTIONS));
  const sandbox = { console };
  const body = names.map((name) => namedFunctionSource(tasteSource, name)).join('\n');
  const code = `${SANDBOX_PRELUDE}\n${body}\nthis.api = {\n`
    + '  document: tasteEmptyDocument,\n'
    + '  normalize: tasteNormalizeDocument,\n'
    + '  ingest: tasteIngestRows,\n'
    + '  trim: tasteTrimDocument,\n'
    + '  removeSource: tasteRemoveSource,\n'
    + '  boost: applyTasteSearchBoost,\n'
    + '  match: tasteMatchSong,\n'
    + '  view: tasteView,\n'
    + '  hasData: tasteHasData,\n'
    + '  key: tasteTitleKey,\n'
    + '  parts: tasteArtistParts,\n'
    + '  listenIndex: tasteBuildListenIndex,\n'
    + '  state: function () { return tasteProfileState; },\n'
    + `  setState: function (value) { tasteProfileState = value; ${freshView()} },\n`
    + `  setListen: function (value) { listenStatsState = value; ${freshView()} },\n`
    + '};\n';
  vm.runInNewContext(code, sandbox);
  return sandbox.api;
}

const PARSER_PRELUDE = `
var TASTE_IMPORT_ROW_LIMIT = 20000;
${topLevelArrayLiteral(tasteSource, 'TASTE_JSON_CONTAINER_KEYS')}
${topLevelArrayLiteral(tasteSource, 'TASTE_CSV_NAME_COLS')}
${topLevelArrayLiteral(tasteSource, 'TASTE_CSV_ARTIST_COLS')}
`;

const PARSER_FUNCTIONS = [
  'tastePlainObject', 'tasteNormalizeText', 'tasteIsNoiseArtist', 'tasteArtistParts', 'tasteCleanTitle',
  'tasteSplitLine', 'tasteStripExtinfPrefix', 'tasteFirstText',
  'tasteJoinArtistNames', 'tasteRowFromObject', 'tasteCollectJsonRows', 'tasteSplitCsvLine', 'tasteParseImportText',
];

function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function deepEqual(actual, expected, message) {
  if (message === undefined) assert.deepStrictEqual(plain(actual), plain(expected));
  else assert.deepStrictEqual(plain(actual), plain(expected), message);
}

function buildParserSandbox() {
  const sandbox = { console };
  const body = PARSER_FUNCTIONS.map((name) => namedFunctionSource(tasteSource, name)).join('\n');
  vm.runInNewContext(`${PARSER_PRELUDE}${body}\nthis.parse = tasteParseImportText;\n`, sandbox);
  return sandbox;
}

test('解析：TXT 一行一条「歌手 - 歌名」，只有名字的当歌手收', () => {
  const { parse } = buildParserSandbox();
  const out = parse('周杰伦 - 晴天\n莫文蔚 - 忽然之间\n汉斯·季姆\n# 注释行\n', '我的歌单.txt');
  assert.equal(out.format, 'text');
  assert.equal(out.rows.length, 3);
  deepEqual(out.rows[0], { name: '晴天', artist: '周杰伦', keyword: '' });
  assert.equal(out.rows[2].keyword, '汉斯·季姆');
  assert.equal(out.rows[2].name, '');
});

test('解析：CSV 认中英文表头，认不出歌手列就只记歌名，没表头就不导', () => {
  const { parse } = buildParserSandbox();
  const english = parse('Name,Artist,Album\nBohemian Rhapsody,Queen,A Night at the Opera\n', 'spotify.csv');
  assert.equal(english.format, 'csv');
  deepEqual(english.rows[0], { name: 'Bohemian Rhapsody', artist: 'Queen', keyword: '' });
  const chinese = parse('标题,歌手\n海阔天空,黄家驹\n', 'neteasemusic.csv');
  deepEqual(chinese.rows[0], { name: '海阔天空', artist: '黄家驹', keyword: '' });
  const onlyName = parse('歌名\n海阔天空\n喜欢你\n', 'only-title.csv');
  assert.equal(onlyName.rows.length, 2, '表头那一行不能被当成一首歌灌进来');
  deepEqual(onlyName.rows[0], { name: '海阔天空', artist: '', keyword: '' });
  const nameAlbum = parse('标题,专辑\n海阔天空,命运派对\n', 'album.csv');
  deepEqual(nameAlbum.rows[0], { name: '海阔天空', artist: '', keyword: '' }, '第二列是专辑也不能当歌手');
  const headerless = parse('晴天,周杰伦,1:20\n夜曲,周杰伦,3:20\n', '无表头.csv');
  assert.equal(headerless.format, 'csv-no-name', '认不出表头就不猜列位，宁可不导');
  assert.equal(headerless.rows.length, 0);
});

test('解析：JSON 收 Spotify SavedTracks 与网易云 songs 两种壳', () => {
  const { parse } = buildParserSandbox();
  const spotify = JSON.stringify({
    items: [
      { track: { name: 'Hero', artists: [{ name: 'Enrique Iglesias' }], album: { name: 'Escape' }, duration_ms: 195000 } },
      { track: { name: 'Immune', artists: [{ name: 'Imogen Heap' }] } },
    ],
  });
  const out = parse(spotify, 'SavedTracks.json');
  assert.equal(out.format, 'json');
  deepEqual(out.rows.map((row) => row.artist), ['Enrique Iglesias', 'Imogen Heap']);
  const netease = parse(JSON.stringify({ songs: [{ songName: '稻香', singerName: '周杰伦' }] }), 'cloud.json');
  deepEqual(netease.rows[0], { name: '稻香', artist: '周杰伦', keyword: '' });
  const shell = parse(JSON.stringify({
    id: 1, name: '我的歌单', songs: [{ name: '夜曲', artist: '周杰伦' }, { name: '一路向北', artist: '周杰伦' }],
  }), 'playlist.json');
  assert.equal(shell.rows.length, 2);
  assert.equal(shell.rows.map((row) => row.name).join(','), '夜曲,一路向北');
  const broken = parse('{"songs": [', 'broken.json');
  assert.equal(broken.format, 'json-broken');
  assert.equal(broken.rows.length, 0);
  const empty = parse(JSON.stringify({ ok: true }), 'no-song.json');
  assert.equal(empty.format, 'json-no-song');
});

test('解析：M3U 的 EXTINF 与裸路径都能出歌，路径只取文件名并去掉扩展名', () => {
  const { parse } = buildParserSandbox();
  const out = parse([
    '#EXTM3U',
    '#EXTINF:210,-,林俊杰 - 她说',
    '#EXTINF:355,Bohemian Rhapsody',
    'E:\\Music\\S.H.E - 恋爱节拍.mp3',
  ].join('\n'), 'list.m3u');
  assert.equal(out.format, 'm3u');
  deepEqual(out.rows[0], { name: '她说', artist: '林俊杰', keyword: '' });
  assert.equal(out.rows[1].name, 'Bohemian Rhapsody');
  assert.equal(out.rows[1].artist, '');
  assert.equal(out.rows[2].name, '恋爱节拍');
  assert.equal(out.rows[2].artist, 'S.H.E');
  assert.equal(out.skipped, 0);
});

test('入库：歌、歌手、来源三处一起记，来源种类决定基准权重', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  const result = api.ingest(doc, [
    { name: '晴天', artist: '周杰伦', keyword: '' },
    { name: '稻香', artist: '周杰伦', keyword: '' },
    { name: '', artist: '', keyword: '汉斯·季姆' },
  ], { id: 'file:a.txt:1', kind: 'file', label: 'a.txt', provider: '', count: 3 });
  assert.equal(result.addedSongs, 2);
  assert.equal(Object.keys(doc.songs).length, 2);
  assert.equal(doc.songs[api.key('晴天')].weight, 1.2);
  assert.equal(Object.keys(doc.artists).length, 2);
  assert.equal(doc.sources['file:a.txt:1'].kind, 'file');
  const playlistDoc = api.document();
  api.ingest(playlistDoc, [{ name: '晴天', artist: '周杰伦', keyword: '' }], { id: 'pl:netease:9', kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  assert.equal(playlistDoc.songs[api.key('晴天')].weight, 2);
});

test('匹配：song 命中优先于 artist，同名不同歌手只算 title 且权重封顶', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  for (let i = 0; i < 4; i++) {
    api.ingest(doc, [{ name: '晴天', artist: '周杰伦', keyword: '' }], { id: 'pl:netease:' + i, kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  }
  api.ingest(doc, [{ name: '兰亭序', artist: '周杰伦', keyword: '' }], { id: 'pl:netease:0', kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  api.setState(doc);
  const view = api.view();
  const resolved = {};
  const song = api.match({ name: '晴天', artist: '周杰伦' }, view, resolved);
  assert.equal(song.kind, 'song');
  assert.ok(song.weight > 6);
  const cover = api.match({ name: '晴天', artist: '某翻唱歌手' }, view, resolved);
  assert.equal(cover.kind, 'title');
  assert.equal(cover.weight, 6);
  const artist = api.match({ name: '烟花易冷', artist: '周杰伦' }, view, resolved);
  assert.equal(artist.kind, 'artist');
  assert.equal(api.match({ name: '无关歌', artist: '无关的人' }, view, resolved), null);
});

test('加分：有上限、不改原分数、三档单调递增', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  for (let i = 0; i < 30; i++) {
    api.ingest(doc, [{ name: 'Hi', artist: 'Power', keyword: '' }], { id: 'pl:netease:' + i, kind: 'playlist', label: 'x', provider: 'netease', count: 1 });
  }
  api.setState(Object.assign(doc, { strength: 'standard' }));
  const songs = [{ name: 'Hi', artist: 'Power', _searchScore: 100 }, { name: 'Yo', artist: 'Power', _searchScore: 100 }];
  api.boost(songs);
  assert.equal(songs[0].name, 'Hi');
  assert.ok(songs[0]._tasteBonus > 0 && songs[0]._tasteBonus <= STRENGTHS.standard.cap);
  assert.equal(songs[0]._searchScore, 100);
  const strong = [{ name: 'Hi', artist: 'Power', _searchScore: 100 }];
  const weak = [{ name: 'Hi', artist: 'Power', _searchScore: 100 }];
  api.setState(Object.assign(doc, { strength: 'strong' }));
  api.boost(strong);
  api.setState(Object.assign(doc, { strength: 'soft' }));
  api.boost(weak);
  assert.ok(weak[0]._tasteBonus <= strong[0]._tasteBonus);
  assert.ok(strong[0]._tasteBonus <= STRENGTHS.strong.cap);
  assert.ok(STRENGTHS.strong.cap < 170);
  assert.equal(strong[0]._tasteKind, 'song');
});

test('同名版本优先：song 命中版本继承同名组内非 song 最高分，不被高热度翻唱压制', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  api.ingest(doc, [{ name: '晴天', artist: '周杰伦', keyword: '' }], { id: 'pl:netease:1', kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  api.setState(doc);

  // 模拟搜索结果：翻唱版因为热度/播放量 searchScore 极高 (150)，周杰伦原版 searchScore 较低 (100)
  const songs = [
    { name: '晴天', artist: '某网红翻唱', _searchScore: 150 },
    { name: '晴天', artist: '周杰伦', _searchScore: 100 },
  ];
  api.boost(songs);

  // 翻唱只能拿到 title 级命中，原版拿到 song 级命中且 _tasteSortScore 提权至组内第一位
  assert.equal(songs[0].artist, '周杰伦', '原版必须排在翻唱前面');
  assert.equal(songs[0]._tasteKind, 'song');
  assert.ok(songs[0]._tasteSortScore > songs[1]._tasteSortScore);
});

test('可回退：关掉开关时清空标记也不重排，结果等于没做这个功能', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  api.ingest(doc, [{ name: 'B', artist: 'A', keyword: '' }], { id: 'pl:netease:1', kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  doc.enabled = false;
  api.setState(doc);
  const songs = [{ name: 'A', artist: 'Z', _searchScore: 10 }, { name: 'B', artist: 'A', _searchScore: 5 }];
  const out = api.boost(songs);
  assert.equal(out.map((song) => song.name).join(','), 'A,B');
  assert.equal(out[1]._tasteBonus, 0);
  assert.equal(out[1]._tasteReason, '');
  assert.equal(out[1]._tasteScore, 5);
});

test('本机聆听这一路不写档案：匹配现算，聆听统计变了立刻跟上', () => {
  const api = buildTasteSandbox();
  api.setState(api.document());
  assert.equal(api.hasData(), false);
  api.setListen({
    updatedAt: 1,
    songs: { 'netease:1': { name: 'Yesterday', artist: 'The Beatles', plays: 9, completed: 5, listenMs: 0, lastPlayedAt: 1 } },
    artists: { 'The Beatles': { name: 'The Beatles', plays: 9, listenMs: 0, lastPlayedAt: 1 } },
    history: [],
  });
  assert.equal(api.hasData(), true);
  const match = api.match({ name: 'Yesterday', artist: 'The Beatles' }, api.view(), {});
  assert.equal(match.kind, 'song');
  assert.equal(match.inListen, true);
  assert.equal(match.inProfile, false);
  assert.equal(match.hits, 9);
  assert.match(match.label, /听过 9 次/);
  assert.equal(Object.keys(api.state().songs).length, 0);
});

test('撤来源：只摘该来源的贡献，别的来源保留；摘干净的歌整条删', () => {
  const api = buildTasteSandbox();
  const doc = api.document();
  const fileSource = { id: 'file:a.txt:1', kind: 'file', label: 'a.txt', provider: '', count: 2 };
  api.ingest(doc, [{ name: 'Only File', artist: 'Someone', keyword: '' }], fileSource);
  api.ingest(doc, [{ name: 'Shared', artist: 'Someone', keyword: '' }], fileSource);
  api.setState(doc);
  api.ingest(api.state(), [{ name: 'Shared', artist: 'Someone', keyword: '' }], { id: 'pl:netease:9', kind: 'playlist', label: '收藏', provider: 'netease', count: 1 });
  const result = api.removeSource('file:a.txt:1');
  assert.equal(result.removedSongs, 1);
  const state = api.state();
  assert.ok(state.songs[api.key('Shared')]);
  assert.equal(state.songs[api.key('Shared')].sources['pl:netease:9'], 1);
  assert.equal(state.sources['file:a.txt:1'], undefined);
});

test('规范化：磁盘与 localStorage 都算不可信输入，坏条目在入口丢掉', () => {
  const api = buildTasteSandbox();
  const doc = api.normalize({
    enabled: false,
    strength: 'insane',
    songs: {
      good: { key: 'x', name: 'Keep', artist: 'A', weight: 3, hits: 2, sources: { 'file:a:1': '4' } },
      zero: { key: 'y', name: 'Drop', artist: 'A', weight: 0 },
      junk: 'not an object',
    },
    artists: { bad: { name: '', weight: 5 }, ok: { name: 'A', weight: 2 } },
    sources: { 'file:a:1': { id: 'file:a:1', kind: 'file', label: 'a', count: 1 }, bogus: { kind: 'unknown' } },
  });
  assert.equal(doc.enabled, false);
  assert.equal(doc.strength, 'standard');
  assert.ok(doc.songs[api.key('Keep')]);
  assert.equal(doc.songs[api.key('Drop')], undefined);
  assert.equal(doc.artists.a.weight, 2);
  assert.equal(doc.sources.bogus, undefined);
  assert.equal(doc.sources['file:a:1'].count, 1);
  deepEqual(api.normalize(null), api.document());
});

test('外挂架构自洽与运行时接线测试', () => {
  // 1. loader.js
  assert.match(fs.readFileSync(loaderPath, 'utf8'), /js\/mods\/60-taste-profile\.js/);
  // 2. mods.json
  const modsJson = JSON.parse(fs.readFileSync(modsJsonPath, 'utf8'));
  const tasteMod = modsJson.mods.find((m) => m.id === 'taste-profile');
  assert.ok(tasteMod, 'mods.json 必须登记 taste-profile');
  assert.equal(tasteMod.enabled, true);
  // 3. preload-main.js 桥接
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  assert.match(preloadSource, /readTasteProfile:/);
  assert.match(preloadSource, /saveTasteProfile:/);
  assert.match(preloadSource, /clearTasteProfile:/);
  // 4. mods-host.js IPC 监听
  const hostSource = fs.readFileSync(hostPath, 'utf8');
  assert.match(hostSource, /bindTasteProfileIpc/);
  assert.match(hostSource, /TASTE_CH\.read/);
  assert.match(hostSource, /TASTE_CH\.save/);
  assert.match(hostSource, /TASTE_CH\.clear/);
  // 5. quick-search.html 浮窗徽章
  const overlaySource = fs.readFileSync(overlayPath, 'utf8');
  assert.match(overlaySource, /\.qs-badge\.taste/);
  assert.match(overlaySource, /song\._tasteReason/);
  // 6. CSS
  const cssSource = fs.readFileSync(cssPath, 'utf8');
  assert.match(cssSource, /\.tag-taste/);
  assert.match(cssSource, /#taste-btn\.taste-search-chip/);
  assert.match(cssSource, /\.modal\.taste-modal/);
  // 7. 60-taste-profile.js 运行时注入与 hook
  assert.match(tasteSource, /tasteInjectModal/);
  assert.match(tasteSource, /tasteInjectButton/);
  assert.match(tasteSource, /tasteInjectStyle/);
  assert.match(tasteSource, /tasteHookSearch/);
  assert.match(tasteSource, /tasteEnsureMounted/);
});

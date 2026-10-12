'use strict';

// ============================================================
//  「状态存档」的落盘层（2026-10-09 加 · 2026-10-12 加 label 与 manual 种类）
//
//  mineradio-mods：这一份是从开发仓库 desktop/danger-archive-store.js 搬来的，
//  改了文件名前缀与下面的 kind/label；userDataPath 由宿主传 app.getPath('userData')，
//  所以文件落在 %APPDATA%\Mineradio\mineradio-danger-archive.json —— 不在安装目录里，更新冲不掉。
//
//  kind 有三种：manual（用户点「存一份当前状态」）、pre-restore（恢复之前自动留的退路）、
//  clear（2026-10-12 之前的版本里，点「一键清空」前留的那份 —— 那颗按钮已按用户要求删掉，
//  但旧文件里可能还有这种条目，读出来照常显示，不能因为种类不认识就把整条丢掉）。
//
//  label 是「改名」写的用户标注（最长 60 字，可空）。它只是显示用的附加信息，
//  不参与恢复：恢复读的永远是 state 里那三份原始字符串。
//
//  为什么存档放在 userData 的 JSON 文件里，而不是 localStorage：
//   1. 这个功能要存的正是 localStorage 里那三条记录。存档如果也住在 localStorage，
//      等于把备份和原件放在同一个会被清掉的地方。
//   2. 渲染层的 localStorage 落在 Chromium leveldb 里，外部改不动，
//      「清除缓存/换缓存目录」那套设置也有可能把它一起带走。
//      放在 userData 的一个普通 JSON 文件里，卸载重装、清缓存都动不到它。
//
//  存档记录的是**原始字符串**（localStorage.getItem 拿到的那种），不是解析后的对象。
//  恢复时按原样写回去，这样搜索历史的结构版本、播放存档里的每个字段都不会在
//  "解析—再序列化"的过程里被我们的猜测改动。要恢复的是那一刻的字节，不是我们的理解。
// ============================================================

const fs = require('fs');
const path = require('path');

const DANGER_ARCHIVE_FILE = 'mineradio-danger-archive.json';
// 单条存档 = 搜索历史（≤10 条词）+ 播放存档（队列最多 120 首，app 自己就这么截）
// + 聆听统计。20 条存档实测几百 KB 到 2 MB；留 12 MB 上限，超了就从最旧的开始丢。
const DANGER_ARCHIVE_MAX_BYTES = 12 * 1024 * 1024;
const DANGER_ARCHIVE_MAX_ITEMS = 20;
const DANGER_ARCHIVE_LABEL_MAX = 60;
// 认的三个种类。clear 是 2026-10-12 之前「一键清空」留下的旧条目，
// 只为准许显示与恢复而留着，新的存档不会再是它（那颗按钮删了，新入口是 manual）。
const DANGER_ARCHIVE_KINDS = ['manual', 'pre-restore', 'clear'];
// 存档捕获的三条记录。键名与渲染层 00-core-stores.js / 07-search.js 里的常量一致，
// 这里写成字面量是因为主进程不该去 require 浏览器模块。
// 口径（用户 2026-10-10 定）："回到从来没听过歌的状态，配置不变" —— 所以搜索记录、
// 播放队列、聆听统计三条都算"听过的痕迹"，一起存一起恢复。
const DANGER_ARCHIVE_STATE_KEYS = [
  'mineradio-search-history',
  'mineradio-last-playback-v1',
  'mineradio-listen-stats-v1',
];

function emptyDocument() {
  return { version: 1, archives: [] };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 状态字典（键 → 原始字符串）只收我们认的那两个键，值必须是字符串或 null。
// 任何别的东西（对象、数字、注入进来的第三个键）一律丢掉：这个文件是磁盘上的
// 不可信输入，恢复时会被原样写进 localStorage。
function normalizeState(value) {
  const state = {};
  if (!isPlainObject(value)) return state;
  DANGER_ARCHIVE_STATE_KEYS.forEach((key) => {
    const raw = value[key];
    if (typeof raw === 'string' && raw.length) state[key] = raw;
  });
  return state;
}

function normalizeSummary(value) {
  const src = isPlainObject(value) ? value : {};
  const text = (input, max) => String(input == null ? '' : input).slice(0, max);
  return {
    searchItems: Math.max(0, Number(src.searchItems) || 0),
    queueLength: Math.max(0, Number(src.queueLength) || 0),
    listenRecords: Math.max(0, Number(src.listenRecords) || 0),
    listenMinutes: Math.max(0, Number(src.listenMinutes) || 0),
    currentName: text(src.currentName, 80),
    currentArtist: text(src.currentArtist, 80),
    queueChangedAt: Math.max(0, Number(src.queueChangedAt) || 0),
    snapshotSavedAt: Math.max(0, Number(src.snapshotSavedAt) || 0),
  };
}

// 一条存档能不能被显示和恢复，全看这里；坏记录在入口就丢掉，不留到用的时候再炸。
function normalizeArchive(value, index) {
  if (!isPlainObject(value)) return null;
  const state = normalizeState(value.state);
  if (!Object.keys(state).length) return null;
  const createdAt = Math.max(0, Number(value.createdAt) || 0);
  // 种类不认识（旧文件、手改的文件、以后新增的）一律退回 clear，
  // 但条目本身要保住——它是用户唯一的备份，不能因为一个字段不在白名单就丢整条。
  const kind = DANGER_ARCHIVE_KINDS.indexOf(String(value.kind)) >= 0 ? String(value.kind) : 'clear';
  return {
    id: String(value.id || '').slice(0, 64) || ('archive-' + createdAt + '-' + index),
    createdAt,
    kind,
    // 「改名」写的标注，可空。只做显示，不参与恢复。
    label: String(value.label == null ? '' : value.label).trim().slice(0, DANGER_ARCHIVE_LABEL_MAX),
    reason: String(value.reason || '').slice(0, 48),
    summary: normalizeSummary(value.summary),
    state,
  };
}

function normalizeDocument(value) {
  const src = isPlainObject(value) ? value : null;
  if (!src || !Array.isArray(src.archives)) return null;
  const seen = {};
  const archives = [];
  src.archives.forEach((item, index) => {
    const record = normalizeArchive(item, index);
    if (!record || seen[record.id]) return;
    seen[record.id] = true;
    archives.push(record);
  });
  // 新在前。按创建时间兜底排一次，防着手改文件把顺序弄乱后界面时间跳来跳去
  archives.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { version: 1, updatedAt: Math.max(0, Number(src.updatedAt) || 0), archives };
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

class DangerArchiveStore {
  constructor(options) {
    const opts = options || {};
    this.userDataPath = String(opts.userDataPath || '');
    this.maxBytes = Number(opts.maxBytes) || DANGER_ARCHIVE_MAX_BYTES;
    this.maxItems = Number(opts.maxItems) || DANGER_ARCHIVE_MAX_ITEMS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    if (!this.userDataPath) throw new Error('DANGER_ARCHIVE_NEEDS_USER_DATA_PATH');
  }

  get filePath() {
    return path.join(this.userDataPath, DANGER_ARCHIVE_FILE);
  }

  // 读不出来分两种，必须区分对待：
  //   - 文件不存在 → 真的还没有存档，返回空文档（正常首次使用）
  //   - 文件在但读坏/超限 → 返回 error，让上层拒绝写入。
  //     绝不能"读不出来就当没有然后重新覆盖"，那等于把用户唯一的备份删了。
  read() {
    const file = this.filePath;
    try {
      if (!fs.existsSync(file)) return { ok: true, document: emptyDocument(), missing: true, file };
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { ok: false, error: 'DANGER_ARCHIVE_NOT_A_FILE', file };
      if (stat.size <= 0) return { ok: true, document: emptyDocument(), missing: true, file };
      if (stat.size > this.maxBytes) return { ok: false, error: 'DANGER_ARCHIVE_TOO_LARGE', file, size: stat.size };
      const raw = fs.readFileSync(file, 'utf8');
      // BOM 用运行时字符码判断，源码里不写那个不可见字符
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // 语法坏了和读不出来是两回事：前者说明"备份还在、只是我们看不懂"，
        // 报 CORRUPT 让上层拒绝覆盖，用户还能自己把文件捞出来
        return { ok: false, error: 'DANGER_ARCHIVE_CORRUPT', file };
      }
      const document = normalizeDocument(parsed);
      if (!document) return { ok: false, error: 'DANGER_ARCHIVE_CORRUPT', file };
      return { ok: true, document, file };
    } catch (e) {
      return { ok: false, error: 'DANGER_ARCHIVE_READ_FAILED', detail: (e && e.message) || String(e), file };
    }
  }

  // 原子写：tmp + rename，跟 current-fx-autosave / 原 night-clear 一个套路。
  // EBUSY/EPERM 是 Windows 上杀毒与索引器抢句柄的常见瞬态，重试一次就好。
  write(document) {
    const attempt = (waitMs) => {
      try {
        const normalized = normalizeDocument(document) || emptyDocument();
        const payload = Object.assign({}, normalized, { updatedAt: this.now() });
        let text = JSON.stringify(payload);
        const dropped = [];
        // 超字节上限就从最旧的开始丢，至少留最新那一条
        while (byteLength(text) > this.maxBytes && payload.archives.length > 1) {
          const removed = payload.archives.pop();
          dropped.push(removed && removed.id);
          text = JSON.stringify(Object.assign({}, payload, { updatedAt: this.now() }));
        }
        if (byteLength(text) > this.maxBytes) {
          return { ok: false, error: 'DANGER_ARCHIVE_SINGLE_ITEM_TOO_LARGE', bytes: byteLength(text) };
        }
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, this.filePath);
        return { ok: true, document: payload, dropped, file: this.filePath, bytes: byteLength(text) };
      } catch (e) {
        if (waitMs === 0 && (e.code === 'EBUSY' || e.code === 'EPERM')) return attempt(40);
        try { fs.unlinkSync(this.filePath + '.tmp'); } catch (_) { }
        return { ok: false, error: 'DANGER_ARCHIVE_WRITE_FAILED', detail: (e && e.message) || String(e) };
      }
    };
    return attempt(0);
  }

  // 追加一条。渲染层给 record（不含 id/createdAt 时这里补），我们负责顺序、条数上限与落盘。
  append(record) {
    const read = this.read();
    if (!read.ok) return read;
    const src = isPlainObject(record) ? record : {};
    const state = normalizeState(src.state);
    if (!Object.keys(state).length) return { ok: false, error: 'DANGER_ARCHIVE_EMPTY_STATE' };
    const createdAt = Math.max(0, Number(src.createdAt) || this.now());
    const draft = normalizeArchive(Object.assign({}, src, {
      createdAt,
      id: String(src.id || '') || ('archive-' + createdAt + '-' + Math.floor(Math.random() * 46656).toString(36)),
    }), 0);
    if (!draft) return { ok: false, error: 'DANGER_ARCHIVE_INVALID_RECORD' };
    const archives = [draft].concat(read.document.archives);
    while (archives.length > this.maxItems) archives.pop();
    return this.write({ version: 1, archives });
  }

  remove(id) {
    const read = this.read();
    if (!read.ok) return read;
    const target = String(id || '');
    const archives = read.document.archives.filter((item) => item.id !== target);
    if (archives.length === read.document.archives.length) {
      return { ok: false, error: 'DANGER_ARCHIVE_NOT_FOUND', id: target };
    }
    return this.write({ version: 1, archives });
  }

  // 「改名」只动 label：id / createdAt / kind / state 原样留着，顺序也不变。
  // 用 remove + append 代替会把这条挤到列表最前面，时间线就乱了，所以单独开一条通道。
  setLabel(id, label) {
    const read = this.read();
    if (!read.ok) return read;
    const target = String(id || '');
    const text = String(label == null ? '' : label).trim().slice(0, DANGER_ARCHIVE_LABEL_MAX);
    let hit = false;
    const archives = read.document.archives.map((item) => {
      if (item.id !== target) return item;
      hit = true;
      return Object.assign({}, item, { label: text });
    });
    if (!hit) return { ok: false, error: 'DANGER_ARCHIVE_NOT_FOUND', id: target };
    return this.write({ version: 1, archives });
  }

  clear() {
    return this.write({ version: 1, archives: [] });
  }
}

module.exports = {
  DangerArchiveStore,
  DANGER_ARCHIVE_FILE,
  DANGER_ARCHIVE_MAX_BYTES,
  DANGER_ARCHIVE_MAX_ITEMS,
  DANGER_ARCHIVE_LABEL_MAX,
  DANGER_ARCHIVE_KINDS,
  DANGER_ARCHIVE_STATE_KEYS,
  normalizeDocument,
  normalizeState,
};

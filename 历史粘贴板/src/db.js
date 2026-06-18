// 数据存储模块：负责剪贴板记录的存储、查询、置顶、删除和清理
// 采用纯 JSON 文件存储（零原生依赖、零编译，适合小数据量 ≤200 条，稳定易维护）
// 图片单独存为文件，JSON 里只存文件名，避免数据文件膨胀。
// 对外接口与原 SQLite 版本保持一致，便于未来替换底层实现。

const path = require('path');
const fs = require('fs');

let dataFile = null; // 记录数据 JSON 文件路径
let imageDir = null; // 图片目录
let clips = []; // 内存中的记录数组（每条：{id,type,content,preview,created_at,pinned}）
let nextId = 1; // 自增 id

/**
 * 初始化存储
 * @param {string} userDataDir Electron 的用户数据目录（如 %APPDATA%/剪贴历史）
 */
function init(userDataDir) {
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  imageDir = path.join(userDataDir, 'images');
  if (!fs.existsSync(imageDir)) {
    fs.mkdirSync(imageDir, { recursive: true });
  }

  dataFile = path.join(userDataDir, 'clips.json');
  load();
  return clips;
}

/** 从磁盘加载记录到内存 */
function load() {
  try {
    if (fs.existsSync(dataFile)) {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      clips = Array.isArray(raw.clips) ? raw.clips : [];
      nextId = raw.nextId || computeNextId();
    } else {
      clips = [];
      nextId = 1;
    }
  } catch (e) {
    console.error('读取数据文件失败，将以空数据启动:', e.message);
    clips = [];
    nextId = 1;
  }
}

function computeNextId() {
  return clips.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1;
}

/** 把内存记录写回磁盘 */
function persist() {
  try {
    fs.writeFileSync(
      dataFile,
      JSON.stringify({ nextId, clips }, null, 0),
      'utf-8'
    );
  } catch (e) {
    console.error('保存数据文件失败:', e.message);
  }
}

/** 获取图片存放目录 */
function getImageDir() {
  return imageDir;
}

/**
 * 插入一条记录
 * @param {{type:string, content:string, preview:string, created_at:number}} clip
 * @returns {number} 新记录的 id
 */
function insertClip(clip) {
  const row = {
    id: nextId++,
    type: clip.type,
    content: clip.content,
    preview: clip.preview || '',
    created_at: clip.created_at,
    pinned: 0,
  };
  clips.push(row);
  persist();
  return row.id;
}

/** 排序：置顶在前，其余按时间倒序 */
function sortClips(arr) {
  return arr.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    return b.created_at - a.created_at;
  });
}

/**
 * 查询所有记录（可选搜索关键字，匹配 preview）
 * @param {string} [keyword]
 */
function getClips(keyword) {
  let result = clips;
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase();
    result = clips.filter((c) => (c.preview || '').toLowerCase().includes(kw));
  }
  return sortClips(result);
}

/** 按 id 取单条记录 */
function getClipById(id) {
  return clips.find((c) => c.id === id) || null;
}

/** 切换置顶状态 */
function togglePin(id) {
  const row = getClipById(id);
  if (!row) return;
  row.pinned = row.pinned ? 0 : 1;
  persist();
}

/** 删除单条记录；如果是图片，连同图片文件一起删 */
function deleteClip(id) {
  const idx = clips.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const row = clips[idx];
  if (row.type === 'image') removeImageFile(row.content);
  clips.splice(idx, 1);
  persist();
}

/** 取最新一条记录的内容指纹，用于去重（保留接口，watcher 已自行去重） */
function getLatestFingerprint() {
  if (!clips.length) return null;
  const latest = sortClips(clips)[0];
  return latest ? `${latest.type}:${latest.content}` : null;
}

/**
 * 自动清理：
 *  1) 删除超过保存天数的记录（置顶的不删）
 *  2) 超过最大条数时删最旧的（置顶的不计入、也不删）
 * @param {number} retentionDays 保存天数；0 或负数表示永久保存
 * @param {number} maxItems 最大条数
 * @param {number} [nowTs] 当前时间戳（便于测试）
 */
function cleanup(retentionDays, maxItems, nowTs) {
  const now = nowTs || Date.now();
  let changed = false;

  // 1) 按天数清理（永久保存时跳过）
  if (retentionDays && retentionDays > 0) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const keep = [];
    for (const c of clips) {
      if (c.pinned === 0 && c.created_at < cutoff) {
        if (c.type === 'image') removeImageFile(c.content);
        changed = true;
      } else {
        keep.push(c);
      }
    }
    clips = keep;
  }

  // 2) 按条数清理（只数非置顶项，删最旧的非置顶项）
  if (maxItems && maxItems > 0) {
    const unpinned = clips.filter((c) => c.pinned === 0);
    if (unpinned.length > maxItems) {
      // 按时间升序，最旧的在前
      unpinned.sort((a, b) => a.created_at - b.created_at);
      const overflow = unpinned.length - maxItems;
      const toDelete = new Set(unpinned.slice(0, overflow).map((c) => c.id));
      clips = clips.filter((c) => {
        if (toDelete.has(c.id)) {
          if (c.type === 'image') removeImageFile(c.content);
          return false;
        }
        return true;
      });
      changed = true;
    }
  }

  if (changed) persist();
}

/** 删除磁盘上的图片文件 */
function removeImageFile(fileName) {
  try {
    const p = path.join(imageDir, fileName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error('删除图片文件失败:', e.message);
  }
}

module.exports = {
  init,
  getImageDir,
  insertClip,
  getClips,
  getClipById,
  togglePin,
  deleteClip,
  getLatestFingerprint,
  cleanup,
};

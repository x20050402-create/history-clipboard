// 剪贴板监听模块：定时轮询系统剪贴板，捕获文字 / 图片 / 文件
// 自动去重、跳过密码管理器标记的敏感内容
//
// 文件捕获说明（Windows）：复制文件时剪贴板里是 CF_HDROP 格式，Electron 会
// 把它报告为 'text/uri-list'，但 clipboard.read('text/uri-list') 在 Windows 上
// 返回空字符串（Electron 限制）。因此改用 PowerShell 的 Get-Clipboard -Format
// FileDropList 取真实路径。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { clipboard } = require('electron');
const db = require('./db');

const POLL_INTERVAL = 800; // 轮询间隔（毫秒）

let timer = null;
let lastFingerprint = null; // 上一次处理过的内容指纹，用于去重
let onChangeCallback = null;
let filesBusy = false; // PowerShell 取文件路径进行中标志，避免重复并发

/**
 * 判断当前剪贴板是否被标记为"敏感内容"。
 * 密码管理器（1Password、KeePass、Bitwarden 等）复制密码时会在剪贴板写入特定标记。
 */
function isSensitive() {
  const formats = clipboard.availableFormats();
  const sensitiveMarkers = [
    'ExcludeClipboardContentFromMonitorProcessing',
    'CanIncludeInClipboardHistory',
    'org.nspasteboard.ConcealedType',
  ];
  return formats.some((f) =>
    sensitiveMarkers.some((m) => f.toLowerCase().includes(m.toLowerCase()))
  );
}

/** 计算字符串/缓冲的指纹（用于去重） */
function hash(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function notifyChange() {
  if (typeof onChangeCallback === 'function') onChangeCallback();
}

/** 记录一组文件路径（已去重） */
function recordFiles(files) {
  const content = JSON.stringify(files);
  const fp = 'files:' + hash(content);
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  const preview = files.map((f) => f.split(/[\\/]/).pop()).join(', ');
  db.insertClip({ type: 'files', content, preview, created_at: Date.now() });
  notifyChange();
}

/**
 * Windows：用 PowerShell 读取剪贴板中的文件列表。
 * 仅在检测到 text/uri-list 格式时调用；异步执行，不阻塞轮询。
 */
function captureFilesWindows() {
  if (filesBusy) return;
  filesBusy = true;
  const psScript =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    { windowsHide: true, timeout: 4000, encoding: 'utf8' },
    (err, stdout) => {
      filesBusy = false;
      if (err || !stdout) return;
      const files = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (files.length) recordFiles(files);
    }
  );
}

/** 处理一次剪贴板内容；如有新内容则写库并触发回调 */
function processClipboard() {
  if (isSensitive()) {
    lastFingerprint = 'sensitive:' + Date.now();
    return;
  }

  // 1) 图片
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const buf = image.toPNG();
    const h = hash(buf);
    const fp = 'image:' + h;
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      const fileName = `${Date.now()}-${h.slice(0, 8)}.png`;
      const filePath = path.join(db.getImageDir(), fileName);
      try {
        fs.writeFileSync(filePath, buf);
        const size = image.getSize();
        db.insertClip({
          type: 'image',
          content: fileName,
          preview: `图片 ${size.width}×${size.height}`,
          created_at: Date.now(),
        });
        notifyChange();
      } catch (e) {
        console.error('保存图片失败:', e.message);
      }
    }
    return;
  }

  // 2) 文字
  const text = clipboard.readText();
  if (text && text.length) {
    const fp = 'text:' + hash(text);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      db.insertClip({
        type: 'text',
        content: text,
        preview: text,
        created_at: Date.now(),
      });
      notifyChange();
    }
    return;
  }

  // 3) 文件（无文字、无图片，但剪贴板含 text/uri-list → 复制的是文件）
  const formats = clipboard.availableFormats();
  if (formats.includes('text/uri-list')) {
    if (process.platform === 'win32') {
      captureFilesWindows();
    } else {
      // 其它平台尝试直接读取 uri-list
      const uriList = clipboard.read('text/uri-list');
      if (uriList) {
        const files = uriList
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((u) => decodeURIComponent(u.replace(/^file:\/+/, '/')));
        if (files.length) recordFiles(files);
      }
    }
  }
}

/** 受保护的轮询：捕获单次异常，避免拖垮主进程 */
function safeTick() {
  try {
    processClipboard();
  } catch (e) {
    console.error('[剪贴板监听] 单次处理出错（已忽略）:', e && e.message);
  }
}

/**
 * 开始监听
 * @param {Function} onChange 有新记录时的回调（用于通知界面刷新）
 */
function start(onChange) {
  onChangeCallback = onChange;
  // 启动时先记录当前剪贴板指纹，避免把启动前已有内容当成新复制
  try {
    const text = clipboard.readText();
    if (text) lastFingerprint = 'text:' + hash(text);
  } catch {}
  timer = setInterval(safeTick, POLL_INTERVAL);
}

/** 停止监听 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };

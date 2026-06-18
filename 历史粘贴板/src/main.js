// Electron 主进程：负责创建窗口、系统托盘、启动剪贴板监听、
// 处理界面发来的请求（复制/置顶/删除/搜索/读设置）、定时清理过期记录

const path = require('path');
const fs = require('fs');
const electronModule = require('electron');
console.log('[DEBUG] typeof electronModule:', typeof electronModule);
console.log('[DEBUG] electronModule keys:', typeof electronModule === 'object' ? Object.keys(electronModule).join(', ') : String(electronModule).slice(0, 80));

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  nativeImage,
  shell,
} = electronModule;

console.log('[DEBUG] typeof app:', typeof app);

const db = require('./db');
const watcher = require('./clipboard-watcher');

// ---- 常量 ----
const MAX_ITEMS = 200; // 最大保存条数（固定）
const RETENTION_OPTIONS = [1, 3, 5, 7, 30, 0]; // 保存天数档位，0 = 永久
const DEFAULT_RETENTION = 3;

let mainWindow = null;
let tray = null;
let userDataDir = null;
let settingsPath = null;
let isQuitting = false;

// ---- 运行 / 崩溃日志 ----
// 写到项目根目录的 app.log（路径确定、便于排查闪退问题）
const logPath = path.join(__dirname, '..', 'app.log');

function writeLog(line) {
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch (_) {
    // 记录日志本身失败时不再抛出
  }
}
function logInfo(msg) {
  writeLog('INFO  ' + msg);
  console.log(msg);
}
function logError(label, err) {
  const msg = err && err.stack ? err.stack : String(err);
  writeLog(`ERROR ${label}: ${msg}`);
  console.error(label, msg);
}

// 兜底：任何未捕获异常都记录下来，绝不让程序静默闪退
process.on('uncaughtException', (err) => logError('uncaughtException', err));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));

// 关闭 GPU 硬件加速：规避部分 Windows 显卡驱动导致的"窗口闪退"
app.disableHardwareAcceleration();

// ---- 设置读写（存为简单的 JSON 文件）----
function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (e) {
    console.error('读取设置失败:', e.message);
  }
  return { retentionDays: DEFAULT_RETENTION };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存设置失败:', e.message);
  }
}

// ---- 定时清理 ----
function runCleanup() {
  const settings = loadSettings();
  db.cleanup(settings.retentionDays, MAX_ITEMS);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clips-updated');
  }
}

// ---- 创建主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    title: '剪贴历史',
    icon: getIconPath(),
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // 关闭窗口 = 隐藏到托盘，而非退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function getIconPath() {
  // 优先用 .ico（打包用），其次用占位的 .png，都没有则返回 undefined
  const buildDir = path.join(__dirname, '..', 'build');
  const icoPath = path.join(buildDir, 'icon.ico');
  if (fs.existsSync(icoPath)) return icoPath;
  const pngPath = path.join(buildDir, 'icon.png');
  if (fs.existsSync(pngPath)) return pngPath;
  return undefined;
}

// ---- 创建系统托盘 ----
function createTray() {
  let trayIcon = getIconPath();
  // 如果没有 ico 文件，用一个内置的简单图标兜底
  let image;
  if (trayIcon) {
    image = nativeImage.createFromPath(trayIcon);
  } else {
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('剪贴历史');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开剪贴历史',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // 左键点击托盘图标：切换窗口显示/隐藏
  tray.on('click', () => {
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

// ---- IPC：界面 <-> 主进程 ----
function registerIpc() {
  // 获取记录列表（可带搜索关键字）
  ipcMain.handle('get-clips', (_e, keyword) => {
    const clips = db.getClips(keyword);
    // 给图片类型补上完整磁盘路径，方便界面显示缩略图
    return clips.map((c) => {
      if (c.type === 'image') {
        return { ...c, imagePath: path.join(db.getImageDir(), c.content) };
      }
      return c;
    });
  });

  // 点击卡片：把内容写回系统剪贴板
  ipcMain.handle('copy-clip', (_e, id) => {
    const row = db.getClipById(id);
    if (!row) return false;
    try {
      if (row.type === 'text') {
        clipboard.writeText(row.content);
      } else if (row.type === 'image') {
        const imgPath = path.join(db.getImageDir(), row.content);
        const img = nativeImage.createFromPath(imgPath);
        clipboard.writeImage(img);
      } else if (row.type === 'files') {
        // 文件类型：把路径列表作为文本写回（便于粘贴路径）
        const files = JSON.parse(row.content);
        clipboard.writeText(files.join('\n'));
      }
      return true;
    } catch (e) {
      console.error('复制失败:', e.message);
      return false;
    }
  });

  // 置顶 / 取消置顶
  ipcMain.handle('toggle-pin', (_e, id) => {
    db.togglePin(id);
    return true;
  });

  // 删除单条
  ipcMain.handle('delete-clip', (_e, id) => {
    db.deleteClip(id);
    return true;
  });

  // 读取设置
  ipcMain.handle('get-settings', () => {
    const s = loadSettings();
    return { ...s, maxItems: MAX_ITEMS, retentionOptions: RETENTION_OPTIONS };
  });

  // 保存设置（目前只有保存天数）
  ipcMain.handle('set-retention', (_e, days) => {
    const s = loadSettings();
    s.retentionDays = days;
    saveSettings(s);
    runCleanup(); // 改设置后立即清理一次
    return true;
  });

  // 在文件夹中显示某个文件（文件类型卡片用）
  ipcMain.handle('show-in-folder', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });
}

// ---- 应用生命周期 ----

// 保证单实例：再次启动时只是唤起已有窗口
const gotLock = app.requestSingleInstanceLock();
logInfo('启动：gotLock = ' + gotLock);
if (!gotLock) {
  logInfo('已有实例在运行，本次启动退出（单实例）');
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  // 记录可能导致闪退的进程级事件
  app.on('render-process-gone', (_e, _wc, details) =>
    logError('render-process-gone', JSON.stringify(details))
  );
  app.on('child-process-gone', (_e, details) =>
    logError('child-process-gone', JSON.stringify(details))
  );
  app.on('will-quit', () => logInfo('will-quit（程序即将退出）'));
  app.on('quit', () => logInfo('quit（程序已退出）'));

  app.whenReady().then(() => {
    logInfo('===== 应用启动 whenReady =====');
    userDataDir = app.getPath('userData');
    settingsPath = path.join(userDataDir, 'settings.json');
    logInfo('userData 目录: ' + userDataDir);

    try {
      db.init(userDataDir);
      logInfo('数据库初始化完成');
      registerIpc();
      createWindow();
      logInfo('窗口已创建');
      createTray();
      logInfo('托盘已创建');

      // 启动时清理一次
      runCleanup();

      // 开始监听剪贴板；有新内容就通知界面刷新
      watcher.start(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clips-updated');
        }
      });

      // 每小时自动清理一次过期记录
      setInterval(runCleanup, 60 * 60 * 1000);

      // 首次启动直接显示窗口
      showWindow();
      logInfo('启动流程全部完成，窗口已显示');
    } catch (err) {
      // 启动过程中任何错误都记录下来，便于定位闪退原因
      logError('启动失败', err);
    }
  });

  app.on('window-all-closed', () => {
    // 不退出（常驻托盘）。仅当用户主动退出时才走 quit。
  });

  app.on('before-quit', () => {
    isQuitting = true;
    watcher.stop();
  });
}

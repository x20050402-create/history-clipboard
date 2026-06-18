// 预加载脚本：通过 contextBridge 把主进程能力以白名单方式暴露给界面
// 界面（renderer）不能直接访问 Node / 文件系统，只能调用这里列出的 API

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipAPI', {
  // 获取记录列表（可带搜索关键字）
  getClips: (keyword) => ipcRenderer.invoke('get-clips', keyword),
  // 点击卡片：把内容写回系统剪贴板
  copyClip: (id) => ipcRenderer.invoke('copy-clip', id),
  // 置顶 / 取消置顶
  togglePin: (id) => ipcRenderer.invoke('toggle-pin', id),
  // 删除单条
  deleteClip: (id) => ipcRenderer.invoke('delete-clip', id),
  // 读取设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  // 设置保存天数
  setRetention: (days) => ipcRenderer.invoke('set-retention', days),
  // 在文件夹中显示文件
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  // 监听"记录已更新"事件，界面据此刷新列表
  onClipsUpdated: (callback) => {
    ipcRenderer.on('clips-updated', () => callback());
  },
});

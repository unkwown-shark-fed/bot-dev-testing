const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botGui', {
  loadEnv: () => ipcRenderer.invoke('env:load'),
  saveEnv: values => ipcRenderer.invoke('env:save', values),
  getStatus: () => ipcRenderer.invoke('status:get'),
  installDependencies: () => ipcRenderer.invoke('deps:install'),
  deployCommands: () => ipcRenderer.invoke('commands:deploy'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  startDashboard: () => ipcRenderer.invoke('dashboard:start'),
  stopDashboard: () => ipcRenderer.invoke('dashboard:stop'),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  onLog: callback => ipcRenderer.on('log:entry', (_event, entry) => callback(entry)),
  onStatus: callback => ipcRenderer.on('status:update', (_event, status) => callback(status)),
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize:      ()   => ipcRenderer.send('win-minimize'),
  maximize:      ()   => ipcRenderer.send('win-maximize'),
  close:         ()   => ipcRenderer.send('win-close'),
  pickZip:       ()   => ipcRenderer.invoke('pick-zip'),
  pickSaveDir:   ()   => ipcRenderer.invoke('pick-save-dir'),
  loadSettings:  ()   => ipcRenderer.invoke('load-settings'),
  saveSettings:  (d)  => ipcRenderer.invoke('save-settings', d),
  startConvert:  (o)  => ipcRenderer.invoke('start-convert', o),
  cancelConvert: ()   => ipcRenderer.send('cancel-convert'),
  showInFolder:  (p)  => ipcRenderer.send('show-in-folder', p),
  installUpdate: ()   => ipcRenderer.send('install-update'),
  onLog:         (fn) => ipcRenderer.on('converter-log',  (_e, v) => fn(v)),
  onMsg:         (fn) => ipcRenderer.on('converter-msg',  (_e, v) => fn(v)),
  onDone:        (fn) => ipcRenderer.on('converter-done', (_e, v) => fn(v)),
  onUpdateStatus:(fn) => ipcRenderer.on('update-status',  (_e, v) => fn(v)),
  offAll: () => {
    ['converter-log','converter-msg','converter-done','update-status']
      .forEach(ch => ipcRenderer.removeAllListeners(ch));
  },
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // window
  minimize:      ()    => ipcRenderer.send('win-minimize'),
  maximize:      ()    => ipcRenderer.send('win-maximize'),
  close:         ()    => ipcRenderer.send('win-close'),
  // dialogs
  pickZip:       ()    => ipcRenderer.invoke('pick-zip'),
  pickOutputDir: ()    => ipcRenderer.invoke('pick-output-dir'),
  // settings
  loadSettings:  ()    => ipcRenderer.invoke('load-settings'),
  saveSettings:  (d)   => ipcRenderer.invoke('save-settings', d),
  // converter
  startConvert:  (o)   => ipcRenderer.invoke('start-convert', o),
  cancelConvert: ()    => ipcRenderer.send('cancel-convert'),
  showInFolder:  (p)   => ipcRenderer.send('show-in-folder', p),
  // events
  onLog:         (fn)  => ipcRenderer.on('converter-log',  (_e, v) => fn(v)),
  onMsg:         (fn)  => ipcRenderer.on('converter-msg',  (_e, v) => fn(v)),
  onDone:        (fn)  => ipcRenderer.on('converter-done', (_e, v) => fn(v)),
  offAll: () => {
    ipcRenderer.removeAllListeners('converter-log');
    ipcRenderer.removeAllListeners('converter-msg');
    ipcRenderer.removeAllListeners('converter-done');
  },
});

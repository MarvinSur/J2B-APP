'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#0f1923',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  // Check for updates silently on launch (only in packaged app)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Auto updater events ───────────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  win.webContents.send('update-status', 'downloading');
});
autoUpdater.on('update-downloaded', () => {
  win.webContents.send('update-status', 'ready');
});
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win.minimize());
ipcMain.on('win-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('win-close',    () => win.close());

// ── File picker ───────────────────────────────────────────────────────────────
ipcMain.handle('pick-zip', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select Java Resource Pack',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ── Output folder save dialog ─────────────────────────────────────────────────
ipcMain.handle('pick-save-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the converted pack',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ── Settings persistence ──────────────────────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
ipcMain.handle('load-settings', () => {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
});
ipcMain.handle('save-settings', (_e, data) => {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
  return true;
});

// ── Open in explorer ──────────────────────────────────────────────────────────
ipcMain.on('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// ── Converter ─────────────────────────────────────────────────────────────────
const { fork } = require('child_process');
let converterProc = null;

ipcMain.handle('start-convert', async (_e, opts) => {
  if (converterProc) return { error: 'Already running' };
  const workerPath = path.join(__dirname, 'src', 'converter-worker.js');
  converterProc = fork(workerPath, [], { silent: true });
  converterProc.stdout.on('data', d => win.webContents.send('converter-log', d.toString()));
  converterProc.stderr.on('data', d => win.webContents.send('converter-log', d.toString()));
  converterProc.on('message', msg => win.webContents.send('converter-msg', msg));
  converterProc.on('exit', code => {
    win.webContents.send('converter-done', { code });
    converterProc = null;
  });
  converterProc.send({ type: 'start', opts });
  return { started: true };
});

ipcMain.on('cancel-convert', () => {
  if (converterProc) { converterProc.kill(); converterProc = null; }
});

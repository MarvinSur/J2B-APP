'use strict';

let selectedZip = null;
let outputDir   = null;
let settings    = { mappingVersion: '1', resolution: '64', attachableMat: 'entity_alphatest_one_sided', blockMat: 'alpha_test' };

const $ = id => document.getElementById(id);
const btnPick         = $('btn-pick');
const btnConvert      = $('btn-convert');
const btnCancel       = $('btn-cancel');
const btnSettings     = $('btn-settings');
const btnSaveSettings = $('btn-save-settings');
const btnOpenFolder   = $('btn-open-folder');
const modalBackdrop   = $('modal-backdrop');
const modalClose      = $('modal-close');
const filepathDisplay = $('filepath-display');
const logBox          = $('log-box');
const previewImg      = $('preview-img');
const previewLabel    = $('preview-label');
const progressWrap    = $('progress-wrap');
const progressFill    = $('progress-fill');
const progressText    = $('progress-text');
const currentItem     = $('current-item');
const ciText          = $('ci-text');
const outputBtns      = $('output-btns');
const updateBanner    = $('update-banner');
const chkTransparent  = $('chk-transparent');

(async () => {
  const saved = await window.api.loadSettings();
  if (saved && Object.keys(saved).length) { settings = { ...settings, ...saved }; applySettings(); }
  window.api.onLog(handleLog);
  window.api.onMsg(handleMsg);
  window.api.onDone(handleDone);
  window.api.onUpdateStatus(handleUpdateStatus);
})();

function applySettings() {
  $('sel-mapping-version').value = settings.mappingVersion || '1';
  $('sel-resolution').value      = settings.resolution     || '64';
  $('sel-attachable-mat').value  = settings.attachableMat  || 'entity_alphatest_one_sided';
  $('sel-block-mat').value       = settings.blockMat       || 'alpha_test';
}

// Window controls
$('btn-min').addEventListener('click',   () => window.api.minimize());
$('btn-max').addEventListener('click',   () => window.api.maximize());
$('btn-close').addEventListener('click', () => window.api.close());

// File picker
btnPick.addEventListener('click', async () => {
  const p = await window.api.pickZip();
  if (!p) return;
  selectedZip = p;
  filepathDisplay.textContent = p.split(/[\\/]/).pop();
  filepathDisplay.title = p;
  btnConvert.disabled = false;
  log('Selected: ' + p.split(/[\\/]/).pop(), 'info');
  previewLabel.textContent = 'ready to convert';
});

// Settings modal
btnSettings.addEventListener('click', () => { applySettings(); modalBackdrop.classList.remove('hidden'); });
modalClose.addEventListener('click', () => modalBackdrop.classList.add('hidden'));
modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) modalBackdrop.classList.add('hidden'); });
btnSaveSettings.addEventListener('click', async () => {
  settings.mappingVersion = $('sel-mapping-version').value;
  settings.resolution     = $('sel-resolution').value;
  settings.attachableMat  = $('sel-attachable-mat').value;
  settings.blockMat       = $('sel-block-mat').value;
  await window.api.saveSettings(settings);
  modalBackdrop.classList.add('hidden');
  log('Settings saved.', 'info');
});

// Convert — ask for save location first
btnConvert.addEventListener('click', async () => {
  if (!selectedZip) return;

  // Ask user where to save
  const saveDir = await window.api.pickSaveDir();
  if (!saveDir) return; // user cancelled
  outputDir = saveDir;

  setRunning(true);
  clearLog();
  progressFill.style.width = '0%';
  progressText.textContent = '0 / 0';
  outputBtns.classList.add('hidden');

  const res = await window.api.startConvert({
    zipPath:        selectedZip,
    outputDir:      saveDir,
    mappingVersion: settings.mappingVersion,
    resolution:     parseInt(settings.resolution),
    attachableMat:  settings.attachableMat,
    blockMat:       settings.blockMat,
  });
  if (res.error) { log(res.error, 'err'); setRunning(false); }
});

btnCancel.addEventListener('click', () => {
  window.api.cancelConvert();
  setRunning(false);
  log('Cancelled.', 'err');
});

btnOpenFolder.addEventListener('click', () => {
  if (outputDir) window.api.showInFolder(outputDir);
});

// Update banner
$('btn-install-update').addEventListener('click', () => window.api.installUpdate());

function handleUpdateStatus(status) {
  if (status === 'downloading') {
    updateBanner.querySelector('#update-msg').textContent = 'Downloading update…';
    updateBanner.classList.remove('hidden');
    $('btn-install-update').classList.add('hidden');
  } else if (status === 'ready') {
    updateBanner.querySelector('#update-msg').textContent = 'Update ready!';
    updateBanner.classList.remove('hidden');
    $('btn-install-update').classList.remove('hidden');
  }
}

function handleLog(text) {
  for (const l of text.split('\n').filter(Boolean)) {
    const type = l.startsWith('[+]') ? 'ok' : l.startsWith('[ERROR]') || l.startsWith('[X]') ? 'err' : l.startsWith('[•]') ? 'info' : '';
    log(l.replace(/^\[[+•X]\] ?/, '').replace(/^\[ERROR\] ?/, ''), type);
  }
}

function handleMsg(msg) {
  if (msg.type === 'progress') {
    const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = `${msg.done} / ${msg.total}`;
    ciText.textContent = msg.current || '…';
  }
  if (msg.type === 'preview' && msg.dataUrl) setPreview(msg.dataUrl, msg.name);
  if (msg.type === 'output-dir') outputDir = msg.path;
}

function handleDone({ code }) {
  setRunning(false);
  if (code === 0) {
    log('Conversion complete! ✅', 'ok');
    outputBtns.classList.remove('hidden');
    previewLabel.textContent = 'done!';
  } else {
    log('Converter exited with code ' + code, 'err');
  }
}

function setRunning(v) {
  btnConvert.classList.toggle('hidden', v);
  btnCancel.classList.toggle('hidden', !v);
  progressWrap.classList.toggle('hidden', !v);
  currentItem.classList.toggle('hidden', !v);
}

function log(text, type = '') {
  const line = document.createElement('div');
  if (type) line.classList.add('log-' + type);
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}
function clearLog() { logBox.innerHTML = ''; }
function setPreview(dataUrl, name) {
  previewImg.classList.add('fade');
  setTimeout(() => { previewImg.src = dataUrl; previewImg.classList.remove('fade'); if (name) previewLabel.textContent = name; }, 200);
}

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let selectedZip = null;
let outputDir   = null;
let settings    = { mappingVersion: '1', resolution: '64', attachableMat: 'entity_alphatest_one_sided', blockMat: 'alpha_test', transparentBg: false };
let running     = false;

// ── Elements ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const btnPick         = $('btn-pick');
const btnConvert      = $('btn-convert');
const btnCancel       = $('btn-cancel');
const btnSettings     = $('btn-settings');
const btnSaveSettings = $('btn-save-settings');
const btnOpenFolder   = $('btn-open-folder');
const btnMin          = $('btn-min');
const btnMax          = $('btn-max');
const btnClose        = $('btn-close');
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
const chkTransparent  = $('chk-transparent');

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const saved = await window.api.loadSettings();
  if (saved && Object.keys(saved).length) {
    settings = { ...settings, ...saved };
    applySettings();
  }
  window.api.onLog(handleLog);
  window.api.onMsg(handleMsg);
  window.api.onDone(handleDone);
})();

function applySettings() {
  $('sel-mapping-version').value = settings.mappingVersion || '1';
  $('sel-resolution').value      = settings.resolution     || '64';
  $('sel-attachable-mat').value  = settings.attachableMat  || 'entity_alphatest_one_sided';
  $('sel-block-mat').value       = settings.blockMat       || 'alpha_test';
  chkTransparent.checked         = !!settings.transparentBg;
}

// ── Window controls ──────────────────────────────────────────────────────────
btnMin.addEventListener('click',   () => window.api.minimize());
btnMax.addEventListener('click',   () => window.api.maximize());
btnClose.addEventListener('click', () => window.api.close());

// ── File picker ──────────────────────────────────────────────────────────────
btnPick.addEventListener('click', async () => {
  const p = await window.api.pickZip();
  if (!p) return;
  selectedZip = p;
  const name = p.split(/[\\/]/).pop();
  filepathDisplay.textContent = name;
  filepathDisplay.title = p;
  btnConvert.disabled = false;
  log(`Selected: ${name}`, 'info');
  previewLabel.textContent = 'ready to convert';
});

// ── Settings modal ────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  applySettings();
  modalBackdrop.classList.remove('hidden');
});
modalClose.addEventListener('click', () => modalBackdrop.classList.add('hidden'));
modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) modalBackdrop.classList.add('hidden'); });

btnSaveSettings.addEventListener('click', async () => {
  settings.mappingVersion = $('sel-mapping-version').value;
  settings.resolution     = $('sel-resolution').value;
  settings.attachableMat  = $('sel-attachable-mat').value;
  settings.blockMat       = $('sel-block-mat').value;
  settings.transparentBg  = chkTransparent.checked;
  await window.api.saveSettings(settings);
  modalBackdrop.classList.add('hidden');
  log('Settings saved.', 'info');
});

// ── Convert ───────────────────────────────────────────────────────────────────
btnConvert.addEventListener('click', async () => {
  if (!selectedZip) return;
  setRunning(true);
  clearLog();
  progressFill.style.width = '0%';
  progressText.textContent  = '0 / 0';
  outputBtns.classList.add('hidden');

  const res = await window.api.startConvert({
    zipPath:        selectedZip,
    mappingVersion: settings.mappingVersion,
    resolution:     parseInt(settings.resolution),
    attachableMat:  settings.attachableMat,
    blockMat:       settings.blockMat,
    transparentBg:  settings.transparentBg,
  });
  if (res.error) {
    log(res.error, 'err');
    setRunning(false);
  }
});

btnCancel.addEventListener('click', () => {
  window.api.cancelConvert();
  setRunning(false);
  log('Cancelled.', 'err');
});

// ── Open folder ───────────────────────────────────────────────────────────────
btnOpenFolder.addEventListener('click', () => {
  if (outputDir) window.api.showInFolder(outputDir);
});

// ── IPC handlers ──────────────────────────────────────────────────────────────
function handleLog(text) {
  const lines = text.split('\n').filter(Boolean);
  for (const l of lines) {
    const type = l.startsWith('[+]') ? 'ok' : l.startsWith('[ERROR]') || l.startsWith('[X]') ? 'err' : l.startsWith('[•]') ? 'info' : '';
    log(l.replace(/\[[+•X]\] ?/, '').replace(/\[ERROR\] ?/, ''), type);
  }
}

function handleMsg(msg) {
  if (msg.type === 'progress') {
    const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent  = `${msg.done} / ${msg.total}`;
    ciText.textContent = msg.current || '…';
  }
  if (msg.type === 'preview' && msg.dataUrl) {
    setPreview(msg.dataUrl, msg.name);
  }
  if (msg.type === 'output-dir') {
    outputDir = msg.path;
  }
}

function handleDone({ code }) {
  setRunning(false);
  if (code === 0) {
    log('Conversion complete! ✅', 'ok');
    outputBtns.classList.remove('hidden');
    previewLabel.textContent = 'done!';
  } else {
    log(`Converter exited with code ${code}`, 'err');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setRunning(v) {
  running = v;
  btnConvert.classList.toggle('hidden', v);
  btnCancel.classList.toggle('hidden', !v);
  progressWrap.classList.toggle('hidden', !v);
  currentItem.classList.toggle('hidden', !v);
  if (!v) ciText.textContent = 'Idle';
}

function log(text, type = '') {
  const line = document.createElement('div');
  if (type) line.classList.add('log-' + type);
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
  logBox.innerHTML = '';
}

function setPreview(dataUrl, name) {
  previewImg.classList.add('fade');
  setTimeout(() => {
    previewImg.src = dataUrl;
    previewImg.classList.remove('fade');
    if (name) previewLabel.textContent = name;
  }, 200);
}

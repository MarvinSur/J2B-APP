'use strict';
const { execFile, spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

// ── Receive start command from main process ───────────────────────────────────
process.on('message', async msg => {
  if (msg.type !== 'start') return;
  const { opts } = msg;
  try {
    await runConverter(opts);
  } catch (e) {
    process.stderr.write('[ERROR] ' + e.message + '\n');
    process.exit(1);
  }
});

async function runConverter(opts) {
  const { zipPath, mappingVersion, resolution, attachableMat, blockMat, transparentBg } = opts;

  // ── Determine script root (works in dev and packaged)
  const scriptRoot = path.join(__dirname, '..', '..');  // app/src/ → J2B/
  const converterSh = path.join(scriptRoot, 'converter.sh');

  // ── Work in a temp staging dir next to the zip
  const zipDir  = path.dirname(zipPath);
  const zipBase = path.basename(zipPath, '.zip');
  const staging = path.join(os.tmpdir(), `j2b_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true });

  // Copy converter files into staging
  const filesToCopy = [
    'converter.sh','manager.py','render_icon.js','sound.py','meg3.py',
    'blocks.py','blocks_util.py','bow.py','bow_util.py',
    'shield.py','font.py','font_sprite.py','blank256.png',
  ];
  for (const f of filesToCopy) {
    const src = path.join(scriptRoot, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, f));
  }
  // Copy node_modules (needed for puppeteer / three)
  const nmSrc = path.join(scriptRoot, 'node_modules');
  if (fs.existsSync(nmSrc)) {
    fs.cpSync(nmSrc, path.join(staging, 'node_modules'), { recursive: true });
  }

  // Copy input zip into staging
  const stagingZip = path.join(staging, path.basename(zipPath));
  fs.copyFileSync(zipPath, stagingZip);

  // Report output dir
  process.send({ type: 'output-dir', path: zipDir });

  // ── Build converter args
  const args = [
    path.basename(zipPath),
    '-w', 'false',
    '-a', attachableMat || 'entity_alphatest_one_sided',
    '-b', blockMat      || 'alpha_test',
    '-u', 'true',
  ];

  process.stderr.write('[•] Starting converter…\n');
  process.send({ type: 'progress', done: 0, total: 0, current: 'Starting…' });

  // ── Spawn bash (WSL on Windows, bash on Linux/Mac)
  const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
  const child = spawn(shell, ['-c', `cd "${staging}" && chmod +x converter.sh && ./converter.sh ${args.map(a => `"${a}"`).join(' ')}`], {
    cwd: staging,
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: path.join(staging, 'node_modules', 'puppeteer', '.cache'),
      SOUNDS_CONVERSION: 'true',
      ARMOR_CONVERSION:  'true',
      FONT_CONVERSION:   'true',
      BOW_CONVERSION:    'true',
      SHIELD_CONVERSION: 'true',
      BLOCK_CONVERSION:  'true',
    },
  });

  let totalItems = 0;
  let doneItems  = 0;
  let currentName = '';

  // ── Parse stdout for progress info
  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    process.stdout.write(text);

    // detect total item count from converter log
    const mTotal = text.match(/(\d+)\s+items?\s+to\s+(render|convert|process)/i);
    if (mTotal) totalItems = parseInt(mTotal[1]);

    // detect "ok: textures/zicon/..." lines from render_icon.js
    const mOk = text.match(/^ok: .+\/zicon\/([^/]+\/[^/\n]+)\.png/m);
    if (mOk) {
      doneItems++;
      currentName = mOk[1];
      process.send({ type: 'progress', done: doneItems, total: totalItems || doneItems, current: currentName });

      // Send preview of this icon
      const iconPath = text.match(/^ok: (.+)/m)?.[1]?.trim();
      if (iconPath && fs.existsSync(iconPath)) {
        try {
          const buf = fs.readFileSync(iconPath);
          const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
          process.send({ type: 'preview', dataUrl, name: currentName });
        } catch {}
      }
    }

    // general progress from converter "Locating parental info" lines
    const mParent = text.match(/(\d+)％/);
    if (mParent) {
      const pct = parseInt(mParent[1]);
      process.send({ type: 'progress', done: pct, total: 100, current: currentName || 'Processing models…' });
    }
  });

  child.stderr.on('data', chunk => {
    process.stderr.write(chunk.toString());
  });

  await new Promise((resolve, reject) => {
    child.on('close', async code => {
      if (code !== 0) { reject(new Error(`Converter exited ${code}`)); return; }

      // ── Copy outputs back to zip's directory
      try {
        const packOut    = path.join(staging, 'target', 'packaged', 'geyser_resources.mcpack');
        const mappingOut = path.join(staging, 'target', 'geyser_mappings.json');

        if (fs.existsSync(packOut))    fs.copyFileSync(packOut,    path.join(zipDir, 'geyser_resources.mcpack'));
        if (fs.existsSync(mappingOut)) fs.copyFileSync(mappingOut, path.join(zipDir, 'geyser_mappings.json'));

        // ── Apply mapping version rewrite if V2
        if (mappingVersion === '2') {
          await rewriteMappingV2(path.join(zipDir, 'geyser_mappings.json'));
        }

        process.stderr.write('[+] Output files copied to: ' + zipDir + '\n');
        process.send({ type: 'output-dir', path: zipDir });
      } catch (e) {
        process.stderr.write('[ERROR] Copy output failed: ' + e.message + '\n');
      }

      // Cleanup staging
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      resolve();
    });
    child.on('error', reject);
  });
}

// ── Rewrite geyser_mappings.json from V1 → V2 format ─────────────────────────
async function rewriteMappingV2(mappingPath) {
  if (!fs.existsSync(mappingPath)) return;
  const v1 = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

  const v2 = { format_version: 2, items: {} };

  for (const [javaItem, defs] of Object.entries(v1)) {
    if (!Array.isArray(defs)) continue;
    v2.items[javaItem] = defs.map(d => {
      const entry = {
        type: 'legacy',
        custom_model_data: d.custom_model_data,
        bedrock_identifier: d.name,
      };
      if (d.display_name) entry.display_name = d.display_name;
      if (d.icon) entry.bedrock_options = { icon: d.icon };
      return entry;
    });
  }

  // Write alongside original
  const v2Path = mappingPath.replace('geyser_mappings.json', 'geyser_mappings_v2.json');
  fs.writeFileSync(v2Path, JSON.stringify(v2, null, 2));
  process.stderr.write('[+] V2 mapping written: ' + v2Path + '\n');
}

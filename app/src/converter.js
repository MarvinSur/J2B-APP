'use strict';
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const AdmZip = require('adm-zip');
const fetch  = require('node-fetch');
const sharp  = require('sharp');
const { v4: uuidv4 } = require('uuid');

let _emit = () => {};
function setEmit(fn) { _emit = fn; }
function log(type, msg) { _emit({ type: 'log', logType: type, msg }); process.stdout.write(`[${type}] ${msg}\n`); }

async function fetchFile(url, destPath) {
  if (!url || url === 'null') return false;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  fs.writeFileSync(destPath, await res.buffer());
  return true;
}
function nsOf(ref)   { return ref && ref.includes(':') ? ref.split(':')[0] : 'minecraft'; }
function pathOf(ref) { return ref && ref.includes(':') ? ref.split(':')[1] : (ref || ''); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function hash7(s)    { return crypto.createHash('md5').update(s).digest('hex').slice(0, 7); }
function mkdirp(p)   { fs.mkdirSync(p, { recursive: true }); }

async function cropAnimated(pngPath) {
  try {
    const m = await sharp(pngPath).metadata();
    if (m.height > m.width) {
      const tmp = pngPath + '._tmp';
      await sharp(pngPath).extract({ left:0, top:0, width:m.width, height:m.width }).toFile(tmp);
      fs.renameSync(tmp, pngPath);
    }
  } catch {}
}

// Walk parent chain → { elements, textures, display, isGenerated }
// textures is ALWAYS kept as original namespace refs (e.g. "arcanistset:item/axe")
// so render_icon.js can resolve them against assetsDir
function resolveParent(modelJson, assetsDir, maxDepth = 30) {
  let elements = modelJson.elements  || null;
  let textures = modelJson.textures  ? { ...modelJson.textures } : null;
  let display  = modelJson.display   || null;
  let parent   = modelJson.parent    || null;
  let isGenerated = false;

  for (let d = 0; d < maxDepth; d++) {
    if (elements && textures && display) break;
    if (!parent) break;
    if (parent === 'builtin/generated' || parent === 'minecraft:builtin/generated') { isGenerated = true; break; }
    const pp = path.join(assetsDir, nsOf(parent), 'models', pathOf(parent) + '.json');
    const pj = readJson(pp);
    if (!pj) break;
    if (!elements && pj.elements) elements = pj.elements;
    // child textures override parent — merge parent UNDER child
    if (pj.textures) textures = { ...pj.textures, ...(textures || {}) };
    if (!display  && pj.display)  display  = pj.display;
    parent = pj.parent || null;
  }
  return { elements, textures, display, isGenerated };
}

// Namespaces to skip — ModelEngine internals, sound-only packs, etc.
const SKIP_NAMESPACES = new Set([
  'modelengine', '_iainternal',
]);

function buildConfigOld(itemDir, itemTexture) {
  const config = {};
  let idx = 0;
  for (const file of fs.readdirSync(itemDir).filter(f => f.endsWith('.json'))) {
    const itemName = path.basename(file, '.json');
    const json = readJson(path.join(itemDir, file));
    if (!json?.overrides) continue;
    for (const ov of json.overrides) {
      const pred = ov.predicate || {};
      const cmd  = pred.custom_model_data ?? null;
      const dmg  = pred.damage            ?? null;
      const unb  = pred.damaged === 0 ? true : null;
      if (cmd == null && dmg == null && !unb) continue;
      if (!ov.model) continue;
      const ns = nsOf(ov.model), mp = pathOf(ov.model);
      if (SKIP_NAMESPACES.has(ns)) continue;  // skip ModelEngine etc.
      const gid = `gmdl_${++idx}`;
      config[gid] = {
        geyserID: gid, item: itemName,
        bedrock_icon: itemTexture[itemName] || { icon: 'camera' },
        nbt: { CustomModelData: cmd, Damage: dmg, Unbreakable: unb },
        relPath: path.join('assets', ns, 'models', mp + '.json'),
        namespace: ns, model_path: mp.split('/').slice(0,-1).join('/'), model_name: mp.split('/').pop(),
      };
    }
  }
  return config;
}

function buildConfigNew(itemsDir) {
  const config = {};
  let idx = 0;
  if (!fs.existsSync(itemsDir)) return config;
  for (const file of fs.readdirSync(itemsDir).filter(f => f.endsWith('.json'))) {
    const itemName = path.basename(file, '.json');
    const json = readJson(path.join(itemsDir, file));
    const mdl  = json?.model;
    if (!mdl || mdl.type !== 'minecraft:range_dispatch' || mdl.property !== 'minecraft:custom_model_data') continue;
    for (const entry of (mdl.entries || [])) {
      if (!entry.model?.model) continue;
      const ref = entry.model.model, ns = nsOf(ref), mp = pathOf(ref);
      const gid = `gmdl_new_${++idx}`;
      config[gid] = {
        geyserID: gid, item: itemName,
        nbt: { CustomModelData: Math.floor(entry.threshold), Damage: null, Unbreakable: null },
        relPath: path.join('assets', ns, 'models', mp + '.json'),
        namespace: ns, model_path: mp.split('/').slice(0,-1).join('/'), model_name: mp.split('/').pop(),
      };
    }
  }
  return config;
}

function genManifest(packDesc) {
  return {
    format_version: 2,
    header: { description: 'Adds 3D items for use with a Geyser proxy', name: packDesc, uuid: uuidv4(), version:[1,0,0], min_engine_version:[1,18,3] },
    modules: [{ description: 'Adds 3D items', type: 'resources', uuid: uuidv4(), version:[1,0,0] }],
  };
}

function genMappings(config, ver) {
  if (ver === '2') {
    const out = { format_version: 2, items: {} };
    for (const e of Object.values(config)) {
      const k = 'minecraft:' + e.item;
      if (!out.items[k]) out.items[k] = [];
      const def = { type: 'legacy', custom_model_data: e.nbt.CustomModelData, bedrock_identifier: e.path_hash };
      if (e.bedrock_icon?.icon) def.bedrock_options = { icon: e.path_hash };
      out.items[k].push(def);
    }
    return out;
  }
  const out = {};
  for (const e of Object.values(config)) {
    const k = 'minecraft:' + e.item;
    if (!out[k]) out[k] = [];
    out[k].push({ name: e.path_hash, custom_model_data: e.nbt.CustomModelData, damage_predicate: e.nbt.Damage, unbreakable: e.nbt.Unbreakable, icon: e.path_hash });
  }
  return out;
}

// Render zicons — pass ORIGINAL model files + assetsDir so render_icon can resolve textures
async function renderZicons(jobs, renderScript, assetsDir, resolution, emitFn) {
  if (!jobs.length) return;

  // Deduplicate: same model file → same icon, only render once
  const seen = new Map(); // modelFile → outFile
  const dedupJobs = [];
  for (const j of jobs) {
    if (!seen.has(j.modelFile)) {
      seen.set(j.modelFile, j.outFile);
      dedupJobs.push(j);
    }
  }

  const tmpCsv = path.join(os.tmpdir(), `j2b_jobs_${Date.now()}.csv`);
  // render_icon.js expects: modelFile,outFile  (no extra args — resolution not supported, always 64px internally)
  fs.writeFileSync(tmpCsv, dedupJobs.map(j => `${j.modelFile},${j.outFile}`).join('\n'));

  const { fork } = require('child_process');
  let done = 0;
  const total = dedupJobs.length;

  await new Promise((resolve, reject) => {
    const child = fork(renderScript, [tmpCsv, assetsDir], {
      silent: true,
      env: { ...process.env, PUPPETEER_CACHE_DIR: path.join(path.dirname(renderScript), 'node_modules', 'puppeteer', '.cache') },
    });
    child.stdout.on('data', d => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        process.stdout.write(line + '\n');
        if (line.startsWith('ok:')) {
          done++;
          const outPath = line.slice(4).trim();
          const name = outPath.split(/[/\\]/).pop().replace('.png', '');
          emitFn({ type: 'progress', done, total, current: name });
          try {
            const buf = fs.readFileSync(outPath);
            emitFn({ type: 'preview', dataUrl: 'data:image/png;base64,' + buf.toString('base64'), name });
          } catch {}
        }
      }
    });
    child.stderr.on('data', d => process.stderr.write(d.toString()));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('render_icon exited ' + code)));
    child.on('error', reject);
  });

  // Copy icon to all path_hash aliases that share the same model
  for (const j of jobs) {
    if (j.outFile !== seen.get(j.modelFile)) {
      const src = seen.get(j.modelFile);
      if (src && fs.existsSync(src)) { mkdirp(path.dirname(j.outFile)); fs.copyFileSync(src, j.outFile); }
    }
  }

  try { fs.unlinkSync(tmpCsv); } catch {}
}

async function convert(opts, emitFn) {
  setEmit(emitFn);
  const { zipPath, outputDir, mappingVersion='1', resolution=64, attachableMat='entity_alphatest_one_sided', blockMat='alpha_test' } = opts;

  const resourceRoot = process.resourcesPath || path.join(__dirname, '..', '..');
  const renderScript = path.join(resourceRoot, 'render_icon.js');

  const work = path.join(os.tmpdir(), `j2b_${crypto.randomBytes(4).toString('hex')}`);
  mkdirp(work);
  log('process', `Work dir: ${work}`);

  // ── Extract
  log('process', 'Extracting input pack…');
  new AdmZip(zipPath).extractAllTo(work, true);
  const assetsDir = path.join(work, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error('Invalid pack: no assets/ folder');

  // ── Geyser mappings
  log('process', 'Downloading Geyser item mappings…');
  const scratchDir = path.join(work, '_scratch'); mkdirp(scratchDir);
  const itemTexturePath = path.join(scratchDir, 'item_texture.json');
  await fetchFile('https://raw.githubusercontent.com/Kas-tle/java2bedrockMappings/main/item_texture.json', itemTexturePath);
  const itemTexture = readJson(itemTexturePath) || {};

  // ── Build config
  log('process', 'Building predicate config…');
  let config = {};
  const oldDir = path.join(assetsDir, 'minecraft', 'models', 'item');
  const newDir = path.join(assetsDir, 'minecraft', 'items');
  if (fs.existsSync(oldDir)) { Object.assign(config, buildConfigOld(oldDir, itemTexture)); log('completion', 'OLD format (models/item) processed'); }
  if (fs.existsSync(newDir)) { Object.assign(config, buildConfigNew(newDir));               log('completion', 'NEW format (items/ 1.21.4+) processed'); }
  if (!Object.keys(config).length) throw new Error('No item models found in pack');
  log('completion', `Config: ${Object.keys(config).length} entries`);

  // ── Validate model files exist
  for (const [gid, e] of Object.entries(config)) {
    e.absPath = path.join(work, e.relPath);
    if (!fs.existsSync(e.absPath)) delete config[gid];
  }
  log('critical', `After validation: ${Object.keys(config).length} entries`);

  // ── Fallback vanilla assets — cache in userData to avoid re-downloading
  log('process', 'Loading fallback vanilla assets…');
  try {
    // userData path passed via env from main process
    const userDataDir = process.env.J2B_USER_DATA || scratchDir;
    const cacheDir    = path.join(userDataDir, 'cache');
    mkdirp(cacheDir);
    const cachedZip   = path.join(cacheDir, 'fallback_1.20.4.zip');

    if (!fs.existsSync(cachedZip)) {
      log('process', 'Downloading fallback vanilla assets (first time only)…');
      await fetchFile('https://github.com/InventivetalentDev/minecraft-assets/archive/refs/heads/1.20.4.zip', cachedZip);
      log('completion', 'Fallback downloaded and cached');
    } else {
      log('completion', 'Using cached fallback assets');
    }

    log('process', 'Merging fallback assets…');
    const fzip = new AdmZip(cachedZip);
    for (const e of fzip.getEntries()) {
      if (!e.entryName.includes('assets/minecraft/textures/') && !e.entryName.includes('assets/minecraft/models/')) continue;
      const rel  = e.entryName.replace(/^[^/]+\//, '');
      const dest = path.join(work, rel);
      if (!fs.existsSync(dest)) {
        try { mkdirp(path.dirname(dest)); fs.writeFileSync(dest, e.getData()); } catch {}
      }
    }
    log('completion', 'Fallback assets merged');
  } catch (e) { log('error', 'Fallback failed (continuing): ' + e.message); }

  // ── Crop animated textures
  log('process', 'Cropping animated textures…');
  const walkMcmeta = (d) => { if (!fs.existsSync(d)) return []; const r=[]; const w=(dir)=>{ for(const f of fs.readdirSync(dir,{withFileTypes:true})){ const fp=path.join(dir,f.name); if(f.isDirectory())w(fp); else if(f.name.endsWith('.mcmeta'))r.push(fp.replace('.mcmeta','')); } }; w(d); return r; };
  for (const p of walkMcmeta(assetsDir)) if (fs.existsSync(p)) await cropAnimated(p);

  // ── Resolve parentals + hashes
  log('process', 'Resolving model parents…');
  const total = Object.keys(config).length; let idx = 0;
  for (const [gid, e] of Object.entries(config)) {
    idx++;
    emitFn({ type: 'progress', done: idx, total, current: e.model_name });
    const mj = readJson(e.absPath);
    if (!mj) { delete config[gid]; continue; }
    const resolved = resolveParent(mj, assetsDir);
    if (!resolved.elements && !resolved.isGenerated) { delete config[gid]; continue; }
    e.resolved  = resolved;
    e.path_hash = 'gmdl_' + hash7(e.item + '_c' + e.nbt.CustomModelData + '_d' + e.nbt.Damage);
  }
  log('completion', `After resolve: ${Object.keys(config).length} entries`);

  // ── RP structure
  const rpDir = path.join(work, 'target', 'rp');
  ['models/blocks','textures/zicon','attachables','animations'].forEach(d => mkdirp(path.join(rpDir, d)));
  const packIconSrc = path.join(work, 'pack.png');
  if (fs.existsSync(packIconSrc)) fs.copyFileSync(packIconSrc, path.join(rpDir, 'pack_icon.png'));
  const packDesc = readJson(path.join(work, 'pack.mcmeta'))?.pack?.description || 'Geyser 3D Items Resource Pack';
  fs.writeFileSync(path.join(rpDir, 'manifest.json'), JSON.stringify(genManifest(packDesc), null, 2));
  fs.writeFileSync(path.join(rpDir, 'textures', 'terrain_texture.json'), JSON.stringify({ resource_pack_name:'geyser_custom', texture_name:'atlas.terrain', texture_data:{} }, null, 2));
  fs.writeFileSync(path.join(rpDir, 'animations', 'animation.geyser_custom.disable.json'), JSON.stringify({ format_version:'1.8.0', animations:{ 'animation.geyser_custom.disable':{ loop:true, override_previous_animation:true, bones:{geyser_custom:{scale:0}} } } }, null, 2));
  const itemTextureOut = { resource_pack_name:'geyser_custom', texture_name:'atlas.items', texture_data:{} };

  // ── Queue zicon render jobs
  // Key bug fix: pass ORIGINAL absPath (not resolved copy) so render_icon.js
  // can resolve texture namespace refs against assetsDir
  log('process', 'Queuing render jobs…');
  const zIconJobs = [];
  const seenModelFile = new Map(); // absPath → outFile (dedup same physical model)

  for (const e of Object.values(config)) {
    if (!e.resolved) continue;

    if (e.resolved.isGenerated) {
      // 2D item — copy texture directly, no render needed
      const textures = e.resolved.textures || {};
      const firstRef = Object.values(textures)[0];
      if (!firstRef) continue;
      // Find texture file by searching assetsDir
      const resolvedRef = (function resolveRef(r) {
        const seen = new Set();
        while (r && r.startsWith('#')) {
          const k = r.slice(1); if (seen.has(k)) break; seen.add(k); r = textures[k];
        }
        return r;
      })(firstRef);
      if (!resolvedRef) continue;
      const ns = nsOf(resolvedRef), p = pathOf(resolvedRef);
      let texFile = null;
      for (const c of [
        path.join(assetsDir, ns, 'textures', p + '.png'),
        path.join(assetsDir, ns, 'textures', 'item', p + '.png'),
        path.join(assetsDir, ns, 'textures', 'block', p + '.png'),
      ]) { if (fs.existsSync(c)) { texFile = c; break; } }
      if (!texFile) continue;
      const destDir = path.join(rpDir, 'textures', e.namespace, e.model_path);
      mkdirp(destDir);
      fs.copyFileSync(texFile, path.join(destDir, e.model_name + '.png'));
      itemTextureOut.texture_data[e.path_hash] = { textures: [`textures/${e.namespace}/${e.model_path}/${e.model_name}`] };

    } else if (e.resolved.elements) {
      // 3D item — needs zicon render
      // CRITICAL: use ORIGINAL absPath as model input so textures stay as namespace refs
      const outIcon = path.join(rpDir, 'textures', 'zicon', e.namespace, `${e.path_hash}.png`);
      mkdirp(path.dirname(outIcon));

      if (seenModelFile.has(e.absPath)) {
        // Same physical model already queued — reuse output
        const existing = seenModelFile.get(e.absPath);
        if (existing !== outIcon) {
          // Will copy after render
          zIconJobs.push({ modelFile: e.absPath, outFile: outIcon, copyFrom: existing });
        }
      } else {
        seenModelFile.set(e.absPath, outIcon);
        zIconJobs.push({ modelFile: e.absPath, outFile: outIcon });
      }
      itemTextureOut.texture_data[e.path_hash] = { textures: [`textures/zicon/${e.namespace}/${e.path_hash}`] };
    }
  }

  const renderJobs  = zIconJobs.filter(j => !j.copyFrom);
  const copyJobs    = zIconJobs.filter(j =>  j.copyFrom);
  log('completion', `Render jobs: ${renderJobs.length} unique, ${copyJobs.length} reused`);

  // ── Render
  if (renderJobs.length > 0) {
    log('process', `Rendering ${renderJobs.length} zicons…`);

    const tmpCsv = path.join(os.tmpdir(), `j2b_jobs_${Date.now()}.csv`);
    // render_icon.js CSV format: modelFile,outFile  — assetsDir is 2nd argv
    fs.writeFileSync(tmpCsv, renderJobs.map(j => `${j.modelFile},${j.outFile}`).join('\n'));

    const { fork } = require('child_process');
    let done = 0;
    const total2 = renderJobs.length;
    await new Promise((resolve, reject) => {
      const child = fork(renderScript, [tmpCsv, assetsDir], {
        silent: true,
        env: { ...process.env },
      });
      child.stdout.on('data', d => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          process.stdout.write(line + '\n');
          if (line.startsWith('ok:')) {
            done++;
            const outPath = line.slice(4).trim();
            const name = outPath.split(/[/\\]/).pop().replace('.png','');
            emitFn({ type: 'progress', done, total: total2, current: name });
            try {
              emitFn({ type: 'preview', dataUrl: 'data:image/png;base64,' + fs.readFileSync(outPath).toString('base64'), name });
            } catch {}
          }
        }
      });
      child.stderr.on('data', d => process.stderr.write(d.toString()));
      child.on('close', code => code === 0 ? resolve() : reject(new Error('render_icon exited ' + code)));
      child.on('error', reject);
    });
    try { fs.unlinkSync(tmpCsv); } catch {}

    // Copy reused icons
    for (const j of copyJobs) {
      if (fs.existsSync(j.copyFrom)) { mkdirp(path.dirname(j.outFile)); fs.copyFileSync(j.copyFrom, j.outFile); }
    }
    log('completion', 'Zicons rendered');
  }

  // ── Write item_texture.json
  fs.writeFileSync(path.join(rpDir, 'textures', 'item_texture.json'), JSON.stringify(itemTextureOut, null, 2));

  // ── Mappings
  const mappings = genMappings(config, mappingVersion);
  const mappingsPath = path.join(work, 'target', 'geyser_mappings.json');
  fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

  // ── Package → .mcpack
  log('process', 'Packaging output…');
  mkdirp(path.join(work, 'target', 'packaged'));
  const outZip = new AdmZip();
  const addDir = (dir, zBase) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, f.name), zp = zBase + '/' + f.name;
      if (f.isDirectory()) addDir(fp, zp);
      else outZip.addFile(zp, fs.readFileSync(fp));
    }
  };
  addDir(rpDir, '');
  const mcpackPath = path.join(work, 'target', 'packaged', 'geyser_resources.mcpack');
  outZip.writeZip(mcpackPath);

  // ── Copy to output dir
  mkdirp(outputDir);
  fs.copyFileSync(mcpackPath,  path.join(outputDir, 'geyser_resources.mcpack'));
  fs.copyFileSync(mappingsPath, path.join(outputDir, 'geyser_mappings.json'));

  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  log('completion', 'Done! Output: ' + outputDir);
  emitFn({ type: 'output-dir', path: outputDir });
}

module.exports = { convert };

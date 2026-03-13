'use strict';
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const AdmZip   = require('adm-zip');
const fetch    = require('node-fetch');
const sharp    = require('sharp');
const { v4: uuidv4 } = require('uuid');

// ── emit helper (sends structured messages to worker → main → renderer) ───────
let _emit = () => {};
function setEmit(fn) { _emit = fn; }

function log(type, msg)   { _emit({ type: 'log', logType: type, msg }); }
function progress(done, total, current) { _emit({ type: 'progress', done, total, current }); }
function preview(dataUrl, name) { _emit({ type: 'preview', dataUrl, name }); }


// ── URL fetch with retry ──────────────────────────────────────────────────────
async function fetchFile(url, destPath) {
  if (url === 'null' || !url) return false;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = await res.buffer();
  fs.writeFileSync(destPath, buf);
  return true;
}

// ── Resolve namespace from model ref ─────────────────────────────────────────
function nsOf(ref) {
  return ref && ref.includes(':') ? ref.split(':')[0] : 'minecraft';
}
function pathOf(ref) {
  return ref && ref.includes(':') ? ref.split(':')[1] : ref;
}

// ── Read JSON safely ──────────────────────────────────────────────────────────
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// ── MD5 7-char hash ───────────────────────────────────────────────────────────
function hash7(s) {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 7);
}


// ── Crop animated texture (square crop via sharp) ─────────────────────────────
async function cropAnimated(pngPath) {
  try {
    const meta = await sharp(pngPath).metadata();
    if (meta.height > meta.width) {
      const side = meta.width;
      await sharp(pngPath)
        .extract({ left: 0, top: 0, width: side, height: side })
        .toFile(pngPath + '.tmp.png');
      fs.renameSync(pngPath + '.tmp.png', pngPath);
    }
  } catch {}
}

// ── Resolve texture reference → absolute file path ────────────────────────────
function resolveTexture(ref, texMap, assetsDir) {
  let r = ref;
  const seen = new Set();
  while (r && r.startsWith('#')) {
    const k = r.slice(1);
    if (seen.has(k)) break;
    seen.add(k);
    r = texMap[k];
  }
  if (!r) return null;
  const ns = nsOf(r);
  const p  = pathOf(r);
  for (const candidate of [
    path.join(assetsDir, ns, 'textures', p + '.png'),
    path.join(assetsDir, ns, 'textures', 'item',   p + '.png'),
    path.join(assetsDir, ns, 'textures', 'block',  p + '.png'),
    path.join(assetsDir, ns, 'textures', 'items',  p + '.png'),
    path.join(assetsDir, ns, 'textures', 'blocks', p + '.png'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}


// ── Walk parent chain to resolve elements + textures + display ────────────────
function resolveParent(modelJson, assetsDir, maxDepth = 20) {
  let elements = modelJson.elements || null;
  let textures = modelJson.textures || null;
  let display  = modelJson.display  || null;
  let parent   = modelJson.parent   || null;
  let isGenerated = false;
  let depth = 0;

  while (depth++ < maxDepth) {
    if (elements && textures && display) break;
    if (!parent) break;
    if (parent === 'builtin/generated' || parent === 'minecraft:builtin/generated') {
      isGenerated = true;
      break;
    }
    const parentPath = path.join(assetsDir, nsOf(parent), 'models', pathOf(parent) + '.json');
    const pj = readJson(parentPath);
    if (!pj) break;
    if (!elements && pj.elements) elements = pj.elements;
    if (!textures && pj.textures) textures = { ...pj.textures, ...textures };
    if (!display  && pj.display)  display  = pj.display;
    parent = pj.parent || null;
  }

  return { elements, textures, display, isGenerated };
}

// ── Build predicate config from OLD format (models/item) ─────────────────────
function buildConfigOldFormat(itemDir, scratchDir, itemMappings, itemTexture) {
  const config = {};
  let idx = 0;
  const files = fs.readdirSync(itemDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const itemName = path.basename(file, '.json');
    const json = readJson(path.join(itemDir, file));
    if (!json || !json.overrides) continue;
    for (const ov of json.overrides) {
      const pred = ov.predicate || {};
      const cmd  = pred.custom_model_data;
      const dmg  = pred.damage;
      const unbreakable = pred.damaged === 0 ? true : null;
      if (cmd == null && dmg == null && !unbreakable) continue;
      if (!ov.model) continue;
      const ns   = nsOf(ov.model);
      const mp   = pathOf(ov.model);
      const gid  = `gmdl_${++idx}`;
      const bedrockIcon = itemTexture[itemName] || { icon: 'camera', frame: 0 };
      config[gid] = {
        geyserID: gid,
        item: itemName,
        bedrock_icon: bedrockIcon,
        nbt: { CustomModelData: cmd ?? null, Damage: dmg ?? null, Unbreakable: unbreakable },
        path: path.join('.', 'assets', ns, 'models', mp + '.json'),
        namespace: ns,
        model_path: mp.split('/').slice(0, -1).join('/'),
        model_name: mp.split('/').pop(),
        generated: false,
      };
    }
  }
  return config;
}


// ── Build predicate config from NEW format (items/ 1.21.4+) ──────────────────
function buildConfigNewFormat(itemsDir) {
  const config = {};
  let idx = 0;
  if (!fs.existsSync(itemsDir)) return config;
  const files = fs.readdirSync(itemsDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const itemName = path.basename(file, '.json');
    const json = readJson(path.join(itemsDir, file));
    if (!json) continue;
    const model = json.model;
    if (!model || model.type !== 'minecraft:range_dispatch' || model.property !== 'minecraft:custom_model_data') continue;
    for (const entry of (model.entries || [])) {
      if (!entry.model?.model) continue;
      const ref = entry.model.model;
      const ns  = nsOf(ref);
      const mp  = pathOf(ref);
      const gid = `gmdl_new_${++idx}`;
      config[gid] = {
        geyserID: gid,
        item: itemName,
        nbt: { CustomModelData: Math.floor(entry.threshold) },
        path: path.join('.', 'assets', ns, 'models', mp + '.json'),
        namespace: ns,
        model_path: mp.split('/').slice(0, -1).join('/'),
        model_name: mp.split('/').pop(),
        generated: false,
      };
    }
  }
  return config;
}

// ── Generate RP manifest ──────────────────────────────────────────────────────
function genManifest(packDesc) {
  return {
    format_version: 2,
    header: {
      description: 'Adds 3D items for use with a Geyser proxy',
      name: packDesc,
      uuid: uuidv4(),
      version: [1, 0, 0],
      min_engine_version: [1, 18, 3],
    },
    modules: [{
      description: 'Adds 3D items for use with a Geyser proxy',
      type: 'resources',
      uuid: uuidv4(),
      version: [1, 0, 0],
    }],
  };
}


// ── Generate geyser_mappings.json (V1 or V2) ──────────────────────────────────
function genMappings(config, mappingVersion) {
  if (mappingVersion === '2') {
    const out = { format_version: 2, items: {} };
    for (const entry of Object.values(config)) {
      const jItem = 'minecraft:' + entry.item;
      if (!out.items[jItem]) out.items[jItem] = [];
      const def = {
        type: 'legacy',
        custom_model_data: entry.nbt.CustomModelData,
        bedrock_identifier: entry.path_hash,
      };
      if (entry.bedrock_icon?.icon) def.bedrock_options = { icon: entry.path_hash };
      out.items[jItem].push(def);
    }
    return out;
  }
  // V1 format
  const out = {};
  for (const entry of Object.values(config)) {
    const jItem = 'minecraft:' + entry.item;
    if (!out[jItem]) out[jItem] = [];
    out[jItem].push({
      name: entry.path_hash,
      custom_model_data: entry.nbt.CustomModelData,
      damage_predicate: entry.nbt.Damage,
      unbreakable: entry.nbt.Unbreakable,
      icon: entry.path_hash,
      bedrock_icon: entry.bedrock_icon?.icon || 'camera',
    });
  }
  return out;
}

// ── Render zicons via render_icon.js ──────────────────────────────────────────
async function renderZicons(jobs, renderScript, assetsDir, resolution, emit) {
  if (!jobs.length) return;
  const tmpCsv = path.join(os.tmpdir(), `j2b_jobs_${Date.now()}.csv`);
  fs.writeFileSync(tmpCsv, jobs.map(j => `${j.modelFile},${j.outFile}`).join('\n'));

  const { fork } = require('child_process');
  let done = 0;
  const total = jobs.length;

  await new Promise((resolve, reject) => {
    const child = fork(renderScript, [tmpCsv, assetsDir, '--resolution', String(resolution)], { silent: true });
    child.stdout.on('data', d => {
      const text = d.toString();
      for (const line of text.split('\n').filter(Boolean)) {
        if (line.startsWith('ok:')) {
          done++;
          const name = line.replace('ok:', '').trim().split(/[/\\]/).pop().replace('.png','');
          emit({ type: 'progress', done, total, current: name });
          try {
            const buf = fs.readFileSync(line.replace('ok: ','').trim());
            emit({ type: 'preview', dataUrl: 'data:image/png;base64,' + buf.toString('base64'), name });
          } catch {}
        }
        process.stdout.write(line + '\n');
      }
    });
    child.stderr.on('data', d => process.stderr.write(d.toString()));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('render_icon exited ' + code)));
    child.on('error', reject);
  });

  try { fs.unlinkSync(tmpCsv); } catch {}
}


// ── MAIN CONVERT FUNCTION ─────────────────────────────────────────────────────
async function convert(opts, emitFn) {
  setEmit(emitFn);
  const {
    zipPath, outputDir, mappingVersion = '1', resolution = 64,
    attachableMat = 'entity_alphatest_one_sided', blockMat = 'alpha_test',
  } = opts;

  // ── resourceRoot: where converter scripts live (packaged = resources/, dev = J2B/)
  const resourceRoot = process.resourcesPath
    ? process.resourcesPath
    : path.join(__dirname, '..', '..');

  const renderScript = path.join(resourceRoot, 'render_icon.js');

  // ── Create temp work dir
  const work = path.join(os.tmpdir(), `j2b_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  log('process', `Work dir: ${work}`);

  // ── Extract input pack
  log('process', 'Extracting input pack…');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(work, true);

  const assetsDir = path.join(work, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error('Invalid pack: no assets/ folder found');

  // ── Download Geyser mappings
  log('process', 'Downloading Geyser item mappings…');
  const scratchDir = path.join(work, 'scratch_files');
  fs.mkdirSync(scratchDir, { recursive: true });
  const itemMappingsPath = path.join(scratchDir, 'item_mappings.json');
  const itemTexturePath  = path.join(scratchDir, 'item_texture.json');
  await fetchFile('https://raw.githubusercontent.com/GeyserMC/mappings/master/items.json', itemMappingsPath);
  await fetchFile('https://raw.githubusercontent.com/Kas-tle/java2bedrockMappings/main/item_texture.json', itemTexturePath);
  const itemTexture = readJson(itemTexturePath) || {};

  // ── Build predicate config
  log('process', 'Building predicate config…');
  const oldDir = path.join(assetsDir, 'minecraft', 'models', 'item');
  const newDir = path.join(assetsDir, 'minecraft', 'items');
  let config = {};
  if (fs.existsSync(oldDir)) {
    log('completion', 'Found OLD format (models/item)');
    config = { ...config, ...buildConfigOldFormat(oldDir, scratchDir, {}, itemTexture) };
  }
  if (fs.existsSync(newDir)) {
    log('completion', 'Found NEW format (items/ 1.21.4+)');
    config = { ...config, ...buildConfigNewFormat(newDir) };
  }
  if (!Object.keys(config).length) throw new Error('No item models found in pack');
  log('completion', `Config built: ${Object.keys(config).length} entries`);

  // ── Validate: remove entries missing their model file
  for (const [gid, entry] of Object.entries(config)) {
    const absPath = path.join(work, entry.path.replace(/^\.\//, '').replace(/^\.\\/, ''));
    if (!fs.existsSync(absPath)) { delete config[gid]; }
    else entry.absPath = absPath;
  }
  log('critical', `After file validation: ${Object.keys(config).length} entries`);


  // ── Resolve parentals + assign hashes
  log('process', 'Resolving model parents…');
  let parentIdx = 0;
  const total = Object.keys(config).length;
  for (const [gid, entry] of Object.entries(config)) {
    parentIdx++;
    progress(parentIdx, total, entry.model_name);
    const modelJson = readJson(entry.absPath);
    if (!modelJson) { delete config[gid]; continue; }
    const resolved = resolveParent(modelJson, assetsDir);
    if (!resolved.elements && !resolved.isGenerated) { delete config[gid]; continue; }
    entry.resolved  = resolved;
    entry.path_hash = 'gmdl_' + hash7(entry.item + '_c' + entry.nbt.CustomModelData + '_d' + entry.nbt.Damage);
    entry.geometry  = 'geo_' + hash7(entry.path);
  }
  log('completion', `After parental resolve: ${Object.keys(config).length} entries`);

  // ── Setup RP directory structure
  const rpDir = path.join(work, 'target', 'rp');
  fs.mkdirSync(path.join(rpDir, 'models', 'blocks'), { recursive: true });
  fs.mkdirSync(path.join(rpDir, 'textures', 'zicon'),{ recursive: true });
  fs.mkdirSync(path.join(rpDir, 'attachables'),       { recursive: true });
  fs.mkdirSync(path.join(rpDir, 'animations'),        { recursive: true });

  // pack icon
  const packIconSrc = path.join(work, 'pack.png');
  if (fs.existsSync(packIconSrc)) fs.copyFileSync(packIconSrc, path.join(rpDir, 'pack_icon.png'));

  // pack description
  const mcmeta = readJson(path.join(work, 'pack.mcmeta'));
  const packDesc = mcmeta?.pack?.description || 'Geyser 3D Items Resource Pack';

  // manifest
  fs.writeFileSync(path.join(rpDir, 'manifest.json'), JSON.stringify(genManifest(packDesc), null, 2));

  // terrain_texture + item_texture
  fs.writeFileSync(path.join(rpDir, 'textures', 'terrain_texture.json'), JSON.stringify({
    resource_pack_name: 'geyser_custom', texture_name: 'atlas.terrain', texture_data: {}
  }, null, 2));
  const itemTextureOut = { resource_pack_name: 'geyser_custom', texture_name: 'atlas.items', texture_data: {} };

  // disable animation
  fs.writeFileSync(path.join(rpDir, 'animations', 'animation.geyser_custom.disable.json'), JSON.stringify({
    format_version: '1.8.0',
    animations: {
      'animation.geyser_custom.disable': {
        loop: true, override_previous_animation: true,
        bones: { geyser_custom: { scale: 0 } }
      }
    }
  }, null, 2));

  // ── Download fallback assets
  log('process', 'Downloading fallback vanilla assets…');
  try {
    const fallbackZipPath = path.join(scratchDir, 'default_assets.zip');
    await fetchFile('https://github.com/InventivetalentDev/minecraft-assets/archive/refs/heads/1.20.4.zip', fallbackZipPath);
    const fzip = new AdmZip(fallbackZipPath);
    const entries = fzip.getEntries();
    for (const e of entries) {
      if (e.entryName.includes('assets/minecraft/textures/') || e.entryName.includes('assets/minecraft/models/')) {
        const rel = e.entryName.replace(/^[^/]+\//, '');
        const dest = path.join(work, rel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, e.getData());
        }
      }
    }
    log('completion', 'Fallback assets merged');
  } catch (e) { log('error', 'Fallback download failed (continuing): ' + e.message); }


  // ── Crop animated textures
  log('process', 'Cropping animated textures…');
  const findPngsWithMcmeta = (dir) => {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name);
        if (f.isDirectory()) walk(fp);
        else if (f.name.endsWith('.mcmeta')) results.push(fp.replace('.mcmeta', ''));
      }
    };
    walk(dir);
    return results;
  };
  const animatedPngs = findPngsWithMcmeta(assetsDir);
  for (const p of animatedPngs) if (fs.existsSync(p)) await cropAnimated(p);

  // ── Copy 2D textures + generate attachables + geometry
  log('process', 'Generating RP files…');
  const zIconJobs = [];

  for (const [gid, entry] of Object.entries(config)) {
    const { resolved, path_hash, geometry, namespace, model_path, model_name } = entry;
    if (!resolved) continue;

    if (resolved.isGenerated && resolved.textures) {
      // 2D item — copy texture directly
      const tex0 = Object.values(resolved.textures)[0];
      const texFile = resolveTexture(tex0, resolved.textures, assetsDir);
      if (texFile) {
        const destDir = path.join(rpDir, 'textures', namespace, model_path);
        fs.mkdirSync(destDir, { recursive: true });
        const destFile = path.join(destDir, model_name + '.png');
        fs.copyFileSync(texFile, destFile);
        itemTextureOut.texture_data[path_hash] = {
          textures: [`textures/${namespace}/${model_path}/${model_name}`]
        };
      }
    } else if (resolved.elements) {
      // 3D item — queue for zicon render
      const modelOutPath = path.join(rpDir, 'models', 'items', namespace, `${path_hash}.json`);
      fs.mkdirSync(path.dirname(modelOutPath), { recursive: true });
      // Write resolved model for renderer
      const resolvedModel = {
        textures: resolved.textures || {},
        elements: resolved.elements,
        display:  resolved.display  || {},
      };
      fs.writeFileSync(modelOutPath, JSON.stringify(resolvedModel, null, 2));
      const outIcon = path.join(rpDir, 'textures', 'zicon', namespace, `${path_hash}.png`);
      fs.mkdirSync(path.dirname(outIcon), { recursive: true });
      zIconJobs.push({ modelFile: modelOutPath, outFile: outIcon, name: model_name });
      itemTextureOut.texture_data[path_hash] = {
        textures: [`textures/zicon/${namespace}/${path_hash}`]
      };
    }
  }

  // ── Render zicons
  if (zIconJobs.length > 0) {
    log('process', `Rendering ${zIconJobs.length} zicons…`);
    await renderZicons(zIconJobs, renderScript, assetsDir, resolution, emitFn);
    log('completion', 'Zicons rendered');
  }

  // ── Write item_texture.json
  fs.writeFileSync(path.join(rpDir, 'textures', 'item_texture.json'), JSON.stringify(itemTextureOut, null, 2));

  // ── Write geyser_mappings.json
  const mappings = genMappings(config, mappingVersion);
  const mappingsPath = path.join(work, 'target', 'geyser_mappings.json');
  fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

  // ── Package → mcpack
  log('process', 'Packaging output…');
  const packedDir = path.join(work, 'target', 'packaged');
  fs.mkdirSync(packedDir, { recursive: true });
  const outZip = new AdmZip();
  const addDirToZip = (dir, zipBase) => {
    const walk = (d, zb) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name);
        if (f.isDirectory()) walk(fp, zb + '/' + f.name);
        else outZip.addFile(zb + '/' + f.name, fs.readFileSync(fp));
      }
    };
    walk(dir, zipBase);
  };
  addDirToZip(rpDir, '');
  const mcpackPath = path.join(packedDir, 'geyser_resources.mcpack');
  outZip.writeZip(mcpackPath);

  // ── Copy to output dir
  const finalMcpack  = path.join(outputDir, 'geyser_resources.mcpack');
  const finalMapping = path.join(outputDir, 'geyser_mappings.json');
  fs.copyFileSync(mcpackPath, finalMcpack);
  fs.copyFileSync(mappingsPath, finalMapping);

  // ── Cleanup
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

  log('completion', `Done! Output: ${outputDir}`);
  emitFn({ type: 'output-dir', path: outputDir });
}

module.exports = { convert };


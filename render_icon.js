#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ─── Read bundled Three.js once at startup
const THREE_JS_PATH = path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js');
const THREE_JS_SRC  = fs.readFileSync(THREE_JS_PATH, 'utf8');

// ─── Resolve texture file path from model textures map
function resolveFile(ref, texMap, assetsDir) {
  let r = ref;
  const seen = new Set();
  while (r && r.startsWith('#')) {
    const k = r.slice(1);
    if (seen.has(k)) break;
    seen.add(k);
    r = texMap[k];
  }
  if (!r) return null;
  const [ns, p] = r.includes(':') ? r.split(':', 2) : ['minecraft', r];
  for (const c of [
    path.join(assetsDir, ns, 'textures', p + '.png'),
    path.join(assetsDir, ns, 'textures', 'item',   p + '.png'),
    path.join(assetsDir, ns, 'textures', 'block',  p + '.png'),
    path.join(assetsDir, ns, 'textures', 'items',  p + '.png'),
    path.join(assetsDir, ns, 'textures', 'blocks', p + '.png'),
  ]) if (fs.existsSync(c)) return c;
  return null;
}

// ─── Build texture map: key → base64 data URI
function buildTexDataMap(texMap, assetsDir) {
  const out = {};
  for (const k of Object.keys(texMap)) {
    if (k === 'particle') continue;
    const fp = resolveFile('#' + k, texMap, assetsDir);
    if (!fp) continue;
    out[k] = `data:image/png;base64,${fs.readFileSync(fp).toString('base64')}`;
  }
  return out;
}

// ─── Build self-contained HTML with Three.js inlined
function buildHTML(model, texDataMap) {
  const modelJson = JSON.stringify(model);
  const texJson   = JSON.stringify(texDataMap);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;}canvas{display:block;}</style>
</head><body>
<canvas id="c" width="256" height="256"></canvas>
<script>${THREE_JS_SRC}</script>
<script>
(async function() {
  const W = 256, H = 256;
  const model   = ${modelJson};
  const texData = ${texJson};

  const canvas   = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);

  const CAM = 9;
  const camera = new THREE.OrthographicCamera(-CAM, CAM, CAM, -CAM, -200, 200);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);

  const scene = new THREE.Scene();

  const BOX_FACE_ORDER = ['east','west','up','down','south','north'];
  const SIDE_SHADE     = { up:1.0, down:0.5, east:0.8, west:0.8, south:0.9, north:0.7 };

  const texMap   = model.textures     || {};
  const texSize  = model.texture_size || [16, 16];
  const [TSW, TSH] = texSize;
  const guiLight = model.gui_light || 'side';
  const elements = model.elements  || [];

  // Load all textures from base64
  const loadedTex = {};
  await Promise.all(Object.entries(texData).map(([k, uri]) => new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.magFilter = THREE.NearestFilter;
      t.minFilter  = THREE.NearestFilter;
      t.needsUpdate = true;
      loadedTex[k] = { tex: t, img };
      res();
    };
    img.onerror = res;
    img.src = uri;
  })));

  function resolveRef(ref) {
    let r = ref;
    const seen = new Set();
    while (r && r.startsWith('#')) {
      const k = r.slice(1);
      if (seen.has(k)) break;
      seen.add(k);
      r = texMap[k];
    }
    return r || null;
  }

  function findKey(texRef) {
    const bare = texRef.includes(':') ? texRef.split(':')[1] : texRef;
    for (const k of Object.keys(loadedTex)) {
      const v  = texMap[k] || '';
      const vb = v.includes(':') ? v.split(':')[1] : v;
      if (v === texRef || vb === bare || vb === texRef) return k;
    }
    return Object.keys(loadedTex)[0] || null;
  }

  function buildFaceMats(el) {
    const faceDefs = el.faces || {};
    return BOX_FACE_ORDER.map(faceName => {
      const fd = faceDefs[faceName];
      if (!fd || !fd.texture) return new THREE.MeshBasicMaterial({ visible: false });

      const texRef = resolveRef(fd.texture);
      if (!texRef) return new THREE.MeshBasicMaterial({ visible: false });
      const k = findKey(texRef);
      if (!k || !loadedTex[k]) return new THREE.MeshBasicMaterial({ visible: false });

      const { img } = loadedTex[k];
      const uv  = fd.uv || [0, 0, TSW, TSH];
      const px0 = (uv[0]/TSW)*img.width,  py0 = (uv[1]/TSH)*img.height;
      const px1 = (uv[2]/TSW)*img.width,  py1 = (uv[3]/TSH)*img.height;
      const pw  = Math.abs(px1-px0), ph = Math.abs(py1-py0);
      if (pw < 0.5 || ph < 0.5) return new THREE.MeshBasicMaterial({ visible: false });

      const crop = document.createElement('canvas');
      crop.width  = Math.max(1, Math.round(pw));
      crop.height = Math.max(1, Math.round(ph));
      crop.getContext('2d').drawImage(img, Math.min(px0,px1), Math.min(py0,py1), pw, ph, 0, 0, crop.width, crop.height);

      const rot = (((fd.rotation || 0) / 90) % 4 + 4) % 4;
      let final = crop;
      if (rot) {
        const rw = rot%2===0 ? crop.width : crop.height;
        const rh = rot%2===0 ? crop.height : crop.width;
        final = document.createElement('canvas');
        final.width = rw; final.height = rh;
        const rc = final.getContext('2d');
        rc.translate(rw/2, rh/2);
        rc.rotate(rot * Math.PI/2);
        rc.drawImage(crop, -crop.width/2, -crop.height/2);
      }

      const tex = new THREE.CanvasTexture(final);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter  = THREE.NearestFilter;
      tex.needsUpdate = true;

      const shade = guiLight === 'front' ? 1.0 : (SIDE_SHADE[faceName] || 0.8);
      return new THREE.MeshBasicMaterial({
        map: tex, transparent: true, alphaTest: 0.05,
        color: new THREE.Color(shade, shade, shade),
        side: THREE.FrontSide, depthWrite: true,
      });
    });
  }

  // Build geometry
  const gui  = (model.display || {}).gui || {};
  const gRot = gui.rotation    || [30, 225, 0];
  const gScl = gui.scale       || [0.625, 0.625, 0.625];
  const gTrn = gui.translation || [0, 0, 0];

  const group = new THREE.Group();
  group.rotation.order = 'XYZ';
  group.rotation.set(
    THREE.MathUtils.degToRad(gRot[0]),
    THREE.MathUtils.degToRad(gRot[1]),
    THREE.MathUtils.degToRad(gRot[2]),
  );
  group.scale.set(gScl[0], gScl[1], gScl[2]);
  group.position.set(gTrn[0]/16, gTrn[1]/16, gTrn[2]/16);

  for (const el of elements) {
    const sx = el.to[0]-el.from[0], sy = el.to[1]-el.from[1], sz = el.to[2]-el.from[2];
    if (!sx && !sy) continue;
    if (!sx && !sz) continue;
    if (!sy && !sz) continue;
    const gsx = sx || 0.01, gsy = sy || 0.01, gsz = sz || 0.01;

    const cx = (el.from[0]+el.to[0])/2 - 8;
    const cy = (el.from[1]+el.to[1])/2 - 8;
    const cz = (el.from[2]+el.to[2])/2 - 8;

    const mats = buildFaceMats(el);
    const geo  = new THREE.BoxGeometry(gsx, gsy, gsz);
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(cx, cy, cz);
    mesh.renderOrder = -el.from[2];

    if (el.rotation) {
      const { angle, axis, origin } = el.rotation;
      const ox = origin[0]-8, oy = origin[1]-8, oz = origin[2]-8;
      const pivot = new THREE.Group();
      pivot.position.set(ox, oy, oz);
      const rad = THREE.MathUtils.degToRad(angle);
      if (axis === 'x')      pivot.rotation.x = rad;
      else if (axis === 'y') pivot.rotation.y = rad;
      else                   pivot.rotation.z = rad;
      mesh.position.sub(new THREE.Vector3(ox, oy, oz));
      pivot.add(mesh);
      group.add(pivot);
    } else {
      group.add(mesh);
    }
  }

  scene.add(group);
  renderer.render(scene, camera);

  window.__renderDone = true;
})();
</script>
</body></html>`;
}

// ─── Main
async function main() {
  const [,,jobsCsv, assetsArg] = process.argv;
  if (!jobsCsv || !assetsArg) {
    process.stderr.write('Usage: node render_icon.js <jobs.csv> <assets_dir>\n');
    process.exit(1);
  }
  const assetsDir = path.resolve(assetsArg);
  const lines = fs.readFileSync(jobsCsv, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) process.exit(0);

  // In packaged Electron app, chromium lives in resources/node_modules/puppeteer/.local-chromium
  const chromiumOverride = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromiumOverride || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let ok = 0, skip = 0;
  const t0 = Date.now();

  for (const line of lines) {
    const comma = line.indexOf(',');
    if (comma < 0) { skip++; continue; }
    const modelFile = line.slice(0, comma).trim();
    const outFile   = line.slice(comma + 1).trim();

    let model;
    try { model = JSON.parse(fs.readFileSync(modelFile, 'utf8')); }
    catch (_) { process.stderr.write(`skip: ${modelFile} (parse error)\n`); skip++; continue; }

    if (!model.elements?.length) {
      process.stderr.write(`skip: ${modelFile} (no elements)\n`);
      skip++; continue;
    }

    const texDataMap = buildTexDataMap(model.textures || {}, assetsDir);
    if (!Object.keys(texDataMap).length) {
      process.stderr.write(`skip: ${modelFile} (no textures)\n`);
      skip++; continue;
    }

    const page = await browser.newPage();
    try {
      await page.setContent(buildHTML(model, texDataMap), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__renderDone === true', { timeout: 10000 });

      // Check not blank then export 64x64
      const result = await page.evaluate(() => {
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let hasPixel = false;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 10) { hasPixel = true; break; }
        if (!hasPixel) return null;
        const dst = document.createElement('canvas');
        dst.width = 64; dst.height = 64;
        dst.getContext('2d').drawImage(c, 0, 0, 64, 64);
        return dst.toDataURL('image/png').split(',')[1];
      });

      if (!result) {
        process.stderr.write(`skip: ${modelFile} (blank)\n`);
        skip++;
      } else {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, Buffer.from(result, 'base64'));
        process.stdout.write(`ok: ${outFile}\n`);
        ok++;
      }
    } catch (e) {
      process.stderr.write(`err: ${modelFile}: ${e.message}\n`);
      skip++;
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`Done: ${ok} ok, ${skip} skip, ${elapsed}s\n`);
  process.exit(0);
}

main().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });

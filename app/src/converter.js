'use strict';
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch  = require('node-fetch');
const sharp  = require('sharp');
const { v4: uuidv4 } = require('uuid');

// ── Emit ──────────────────────────────────────────────────────────────────────
let _emit = () => {};
function setEmit(fn) { _emit = fn; }
function log(type, msg) { _emit({ type:'log', logType:type, msg }); process.stdout.write(`[${type}] ${msg}\n`); }

// ── Utilities ─────────────────────────────────────────────────────────────────
async function fetchFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  fs.writeFileSync(dest, await res.buffer());
}
function nsOf(ref)   { return ref && ref.includes(':') ? ref.split(':')[0] : 'minecraft'; }
function pathOf(ref) { return ref && ref.includes(':') ? ref.split(':')[1] : (ref || ''); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function mkdirp(p)   { fs.mkdirSync(p, { recursive: true }); }
function round4(n)   { return Math.round(n * 10000) / 10000; }
function hash7(s)    { return crypto.createHash('md5').update(s).digest('hex').slice(0, 7); }
const SKIP_NS = new Set(['modelengine','_iainternal','betterhud','nameplates']);

// ── Crop animated textures ────────────────────────────────────────────────────
async function cropAnimated(p) {
  try {
    const m = await sharp(p).metadata();
    if (m.height > m.width) {
      const tmp = p + '._tmp';
      await sharp(p).extract({ left:0, top:0, width:m.width, height:m.width }).toFile(tmp);
      fs.renameSync(tmp, p);
    }
  } catch {}
}
function findMcmetaPngs(dir) {
  const r = [];
  if (!fs.existsSync(dir)) return r;
  const w = d => { for (const f of fs.readdirSync(d,{withFileTypes:true})) { const fp=path.join(d,f.name); if(f.isDirectory()) w(fp); else if(f.name.endsWith('.mcmeta')) r.push(fp.slice(0,-7)); } };
  w(dir); return r;
}

// ── Resolve texture ref → absolute path ──────────────────────────────────────
function resolveTexPath(ref, texMap, assetsDir) {
  let r = ref; const seen = new Set();
  while (r && r.startsWith('#')) { const k=r.slice(1); if(seen.has(k)) break; seen.add(k); r=texMap[k]; }
  if (!r) return null;
  const ns=nsOf(r), p=pathOf(r);
  for (const c of [
    path.join(assetsDir,ns,'textures',p+'.png'),
    path.join(assetsDir,ns,'textures','item',p+'.png'),
    path.join(assetsDir,ns,'textures','block',p+'.png'),
    path.join(assetsDir,ns,'textures','items',p+'.png'),
    path.join(assetsDir,ns,'textures','blocks',p+'.png'),
  ]) if (fs.existsSync(c)) return c;
  return null;
}

// ── Walk parent chain ─────────────────────────────────────────────────────────
function resolveParent(mj, assetsDir, depth=30) {
  let elements=mj.elements||null, textures=mj.textures?{...mj.textures}:null;
  let display=mj.display||null, parent=mj.parent||null, isGenerated=false;
  for (let d=0; d<depth; d++) {
    if (elements && textures && display) break;
    if (!parent) break;
    if (parent==='builtin/generated'||parent==='minecraft:builtin/generated') { isGenerated=true; break; }
    const pp=path.join(assetsDir,nsOf(parent),'models',pathOf(parent)+'.json');
    const pj=readJson(pp); if(!pj) break;
    if (!elements && pj.elements) elements=pj.elements;
    if (pj.textures) textures={...pj.textures,...(textures||{})};
    if (!display && pj.display) display=pj.display;
    parent=pj.parent||null;
  }
  return { elements, textures, display, isGenerated };
}

// ── Build config OLD format ───────────────────────────────────────────────────
function buildConfigOld(itemDir, itemTexture) {
  const config={}; let idx=0;
  for (const file of fs.readdirSync(itemDir).filter(f=>f.endsWith('.json'))) {
    const itemName=path.basename(file,'.json');
    const json=readJson(path.join(itemDir,file));
    if (!json?.overrides) continue;
    for (const ov of json.overrides) {
      const pred=ov.predicate||{};
      const cmd=pred.custom_model_data??null, dmg=pred.damage??null, unb=pred.damaged===0?true:null;
      if (cmd==null&&dmg==null&&!unb) continue;
      if (!ov.model) continue;
      const ns=nsOf(ov.model), mp=pathOf(ov.model);
      if (SKIP_NS.has(ns)) continue;
      config[`gmdl_${++idx}`] = {
        geyserID:`gmdl_${idx}`, item:itemName,
        bedrock_icon:itemTexture[itemName]||{icon:'camera',frame:0},
        nbt:{CustomModelData:cmd,Damage:dmg,Unbreakable:unb},
        relPath:path.join('assets',ns,'models',mp+'.json'),
        namespace:ns, model_path:mp.split('/').slice(0,-1).join('/'), model_name:mp.split('/').pop(), generated:false,
      };
    }
  }
  return config;
}

// ── Build config NEW format (1.21.4+) ────────────────────────────────────────
function buildConfigNew(itemsDir) {
  const config={}; let idx=0;
  if (!fs.existsSync(itemsDir)) return config;
  for (const file of fs.readdirSync(itemsDir).filter(f=>f.endsWith('.json'))) {
    const itemName=path.basename(file,'.json');
    const json=readJson(path.join(itemsDir,file));
    const mdl=json?.model;
    if (!mdl||mdl.type!=='minecraft:range_dispatch'||mdl.property!=='minecraft:custom_model_data') continue;
    for (const entry of (mdl.entries||[])) {
      if (!entry.model?.model) continue;
      const ref=entry.model.model, ns=nsOf(ref), mp=pathOf(ref);
      if (SKIP_NS.has(ns)) continue;
      config[`gmdl_new_${++idx}`] = {
        geyserID:`gmdl_new_${idx}`, item:itemName,
        bedrock_icon:{icon:'camera',frame:0},
        nbt:{CustomModelData:Math.floor(entry.threshold),Damage:null,Unbreakable:null},
        relPath:path.join('assets',ns,'models',mp+'.json'),
        namespace:ns, model_path:mp.split('/').slice(0,-1).join('/'), model_name:mp.split('/').pop(), generated:false,
      };
    }
  }
  return config;
}

// ── Texture Atlas (pure Node/sharp, no spritesheet-js needed) ────────────────
async function buildAtlas(texPaths) {
  const SIDE = 16;
  const images = [];
  for (const tp of texPaths) {
    try {
      const m = await sharp(tp).metadata();
      images.push({ path:tp, w:m.width||SIDE, h:Math.min(m.width||SIDE,m.height||SIDE) });
    } catch { images.push({ path:tp, w:SIDE, h:SIDE }); }
  }
  if (!images.length) {
    const buf = await sharp({create:{width:16,height:16,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
    return { image:buf, frames:{}, size:{w:16,h:16} };
  }

  // Pack into rows
  images.sort((a,b)=>b.h-a.h);
  const MAX_W=2048; let cx=0,cy=0,rowH=0,tw=0,th=0;
  const placed=[];
  for (const img of images) {
    if (cx+img.w>MAX_W) { cy+=rowH; cx=0; rowH=0; }
    placed.push({...img,x:cx,y:cy});
    cx+=img.w; rowH=Math.max(rowH,img.h); tw=Math.max(tw,cx); th=cy+rowH;
  }
  const np2=n=>{let p=1;while(p<n)p<<=1;return p;};
  const aw=np2(tw), ah=np2(th);
  const frames={};
  const composites=[];
  for (const p of placed) {
    frames[p.path]={x:p.x,y:p.y,w:p.w,h:p.h};
    try {
      const buf=await sharp(p.path).extract({left:0,top:0,width:p.w,height:p.h}).ensureAlpha().toBuffer();
      composites.push({input:buf,left:p.x,top:p.y});
    } catch {}
  }
  const image=await sharp({create:{width:aw,height:ah,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite(composites).png().toBuffer();
  return { image, frames, size:{w:aw,h:ah} };
}

// ── Collect all texture abs paths referenced by a model entry ─────────────────
function collectEntryTextures(e, assetsDir) {
  const s=new Set();
  if (!e.resolved?.textures) return [];
  for (const ref of Object.values(e.resolved.textures)) {
    const fp=resolveTexPath(ref,e.resolved.textures,assetsDir);
    if (fp) s.add(fp);
  }
  return [...s];
}

// ── UV remap: Java face UV → Bedrock atlas UV ─────────────────────────────────
// Mirrors converter.sh's jq UV calc logic exactly
function calcUV(face, texKey, textures, frames, atlasSize, texSize) {
  if (!face||!face.texture) return null;
  const fp = resolveTexPath(face.texture, textures, null); // already resolved key
  // find frame by matching texture key to frames map
  let frame = null;
  // frames keyed by abs path — we need to look up by the resolved ref
  if (fp && frames[fp]) frame = frames[fp];
  if (!frame) {
    // fallback to first frame
    const vals = Object.values(frames);
    if (vals.length) frame = vals[0];
    else return null;
  }

  const [TSW, TSH] = texSize || [16, 16];
  const AW = atlasSize.w, AH = atlasSize.h;
  const uv = face.uv || [0, 0, TSW, TSH];

  const fn0 = (uv[0]/TSW * frame.w + frame.x) * (16/AW);
  const fn1 = (uv[1]/TSH * frame.h + frame.y) * (16/AH);
  const fn2 = (uv[2]/TSW * frame.w + frame.x) * (16/AW);
  const fn3 = (uv[3]/TSH * frame.h + frame.y) * (16/AH);

  const xSign = Math.max(-1, Math.min(1, fn2-fn0)) || 1;
  const ySign = Math.max(-1, Math.min(1, fn3-fn1)) || 1;

  const faceName = texKey; // passed as faceName from caller
  if (faceName==='up'||faceName==='down') {
    return {
      uv:     [round4(fn2-(0.016*xSign)), round4(fn3-(0.016*ySign))],
      uv_size:[round4((fn0-fn2)+(0.016*xSign)), round4((fn1-fn3)+(0.016*ySign))],
    };
  }
  return {
    uv:     [round4(fn0+(0.016*xSign)), round4(fn1+(0.016*ySign))],
    uv_size:[round4((fn2-fn0)-(0.016*xSign)), round4((fn3-fn1)-(0.016*ySign))],
  };
}

// ── Generate Bedrock geometry JSON ────────────────────────────────────────────
function genGeometry(entry, frames, atlasSize) {
  const { resolved, geometry, generated } = entry;
  const textures = resolved.textures || {};
  const elements = resolved.elements || [];
  const display  = resolved.display  || {};
  const texSize  = resolved.texture_size || [16, 16];

  const binding = "c.item_slot == 'head' ? 'head' : q.item_slot_to_bone_name(c.item_slot)";

  // Build element array with remapped UVs
  const elementArray = elements.map(el => {
    const origin = [round4(-el.to[0]+8), round4(el.from[1]), round4(el.from[2]-8)];
    const size   = [round4(el.to[0]-el.from[0]), round4(el.to[1]-el.from[1]), round4(el.to[2]-el.from[2])];
    let rotation = null, pivot = null;
    if (el.rotation?.axis) {
      const a = el.rotation.angle;
      rotation = el.rotation.axis==='x'?[-a,0,0]:el.rotation.axis==='y'?[0,-a,0]:[0,0,a];
      pivot = [round4(-el.rotation.origin[0]+8), round4(el.rotation.origin[1]), round4(el.rotation.origin[2]-8)];
    }
    const uv = {};
    const FACES = ['north','south','east','west','up','down'];
    for (const fn of FACES) {
      const face = el.faces?.[fn];
      if (!face?.texture) continue;
      // resolve the texture key to abs path
      const absPath = resolveTexPath(face.texture, textures, null);
      // find frame — frames keyed by abs path but we stored them that way only if resolved
      // Pass frame lookup differently: search frames by the resolved path
      let frame = null;
      if (absPath && frames[absPath]) frame = frames[absPath];
      else { const v=Object.values(frames); if(v.length) frame=v[0]; }
      if (!frame) continue;
      const [TSW,TSH] = texSize;
      const AW=atlasSize.w, AH=atlasSize.h;
      const jUv = face.uv||[0,0,TSW,TSH];
      const fn0=(jUv[0]/TSW*frame.w+frame.x)*(16/AW);
      const fn1=(jUv[1]/TSH*frame.h+frame.y)*(16/AH);
      const fn2=(jUv[2]/TSW*frame.w+frame.x)*(16/AW);
      const fn3=(jUv[3]/TSH*frame.h+frame.y)*(16/AH);
      const xs=Math.max(-1,Math.min(1,fn2-fn0))||1;
      const ys=Math.max(-1,Math.min(1,fn3-fn1))||1;
      if (fn==='up'||fn==='down') {
        uv[fn]={ uv:[round4(fn2-0.016*xs),round4(fn3-0.016*ys)], uv_size:[round4((fn0-fn2)+0.016*xs),round4((fn1-fn3)+0.016*ys)] };
      } else {
        uv[fn]={ uv:[round4(fn0+0.016*xs),round4(fn1+0.016*ys)], uv_size:[round4((fn2-fn0)-0.016*xs),round4((fn3-fn1)-0.016*ys)] };
      }
    }
    const out = { origin, size, uv };
    if (rotation) out.rotation = rotation;
    if (pivot)    out.pivot    = pivot;
    return out;
  }).filter(Boolean);

  // Group elements by rotation for pivot_groups (elements with rotation get their own bone)
  const rotKey = el => el.rotation ? JSON.stringify(el.rotation)+'|'+JSON.stringify(el.pivot) : null;
  const pivotMap = new Map();
  for (const el of elementArray) {
    const k = rotKey(el);
    if (!k) continue;
    if (!pivotMap.has(k)) pivotMap.set(k, { rotation:el.rotation, pivot:el.pivot, cubes:[] });
    const cube = { origin:el.origin, size:el.size, uv:el.uv };
    pivotMap.get(k).cubes.push(cube);
  }
  const flatCubes = elementArray.filter(el => !rotKey(el)).map(el => ({ origin:el.origin, size:el.size, uv:el.uv }));
  const pivotBones = [...pivotMap.values()].map((pg, i) => ({
    name: `rot_${i+1}`, parent:'geyser_custom_z',
    pivot: pg.pivot, rotation: pg.rotation, cubes: pg.cubes,
  }));

  const gzBone = generated ? {
    name:'geyser_custom_z', parent:'geyser_custom_y', pivot:[0,8,0],
    texture_meshes:[{ texture:'default', position:[0,8,0], rotation:[90,0,-180], local_pivot:[8,0.5,8] }],
  } : {
    name:'geyser_custom_z', parent:'geyser_custom_y', pivot:[0,8,0],
    cubes: flatCubes,
  };

  return {
    format_version:'1.21.0',
    'minecraft:geometry': [{
      description: {
        identifier:`geometry.geyser_custom.${geometry}`,
        texture_width:16, texture_height:16,
        visible_bounds_width:4, visible_bounds_height:4.5, visible_bounds_offset:[0,0.75,0],
      },
      bones: [
        { name:'geyser_custom', binding, pivot:[0,8,0] },
        { name:'geyser_custom_x', parent:'geyser_custom', pivot:[0,8,0] },
        { name:'geyser_custom_y', parent:'geyser_custom_x', pivot:[0,8,0] },
        gzBone,
        ...pivotBones,
      ],
    }],
  };
}

// ── Generate animations JSON ──────────────────────────────────────────────────
function genAnimations(entry) {
  const { resolved, geometry } = entry;
  const d = resolved.display || {};
  const g = geometry;
  const nn = v => (v == null ? undefined : v);

  const tpr = d.thirdperson_righthand || {};
  const tpl = d.thirdperson_lefthand  || {};
  const hd  = d.head                  || {};
  const fpr = d.firstperson_righthand || {};
  const fpl = d.firstperson_lefthand  || {};

  const anim = {
    format_version:'1.8.0',
    animations: {
      [`animation.geyser_custom.${g}.thirdperson_main_hand`]: {
        loop:true, bones: {
          geyser_custom:{ rotation:[90,0,0], position:[0,13,-3] },
          geyser_custom_x: tpr.rotation||tpr.translation||tpr.scale ? Object.fromEntries([
            tpr.rotation    && ['rotation',    [-(tpr.rotation[0]||0),0,0]],
            tpr.translation && ['position',    [-(tpr.translation[0]||0),tpr.translation[1]||0,tpr.translation[2]||0]],
            tpr.scale       && ['scale',        tpr.scale],
          ].filter(Boolean)) : undefined,
          geyser_custom_y: tpr.rotation ? { rotation:[0,-(tpr.rotation[1]||0),0] } : undefined,
          geyser_custom_z: tpr.rotation ? { rotation:[0,0,tpr.rotation[2]||0]   } : undefined,
        },
      },
      [`animation.geyser_custom.${g}.thirdperson_off_hand`]: {
        loop:true, bones: {
          geyser_custom:{ rotation:[90,0,0], position:[0,13,-3] },
          geyser_custom_x: tpl.rotation||tpl.translation||tpl.scale ? Object.fromEntries([
            tpl.rotation    && ['rotation',    [-(tpl.rotation[0]||0),0,0]],
            tpl.translation && ['position',    [tpl.translation[0]||0,tpl.translation[1]||0,tpl.translation[2]||0]],
            tpl.scale       && ['scale',        tpl.scale],
          ].filter(Boolean)) : undefined,
          geyser_custom_y: tpl.rotation ? { rotation:[0,-(tpl.rotation[1]||0),0] } : undefined,
          geyser_custom_z: tpl.rotation ? { rotation:[0,0,tpl.rotation[2]||0]   } : undefined,
        },
      },
      [`animation.geyser_custom.${g}.head`]: {
        loop:true, bones: {
          geyser_custom:{ position:[0,19.9,0] },
          geyser_custom_x:{
            rotation:  hd.rotation    ? [-(hd.rotation[0]||0),0,0] : undefined,
            position:  hd.translation ? [-(hd.translation[0]||0)*0.625,(hd.translation[1]||0)*0.625,(hd.translation[2]||0)*0.625] : undefined,
            scale:     hd.scale       ? hd.scale.map(v=>v*0.625) : 0.625,
          },
          geyser_custom_y: hd.rotation ? { rotation:[0,-(hd.rotation[1]||0),0] } : undefined,
          geyser_custom_z: hd.rotation ? { rotation:[0,0,hd.rotation[2]||0]   } : undefined,
        },
      },
      [`animation.geyser_custom.${g}.firstperson_main_hand`]: {
        loop:true, bones: {
          geyser_custom:{ rotation:[90,60,-40], position:[4,10,4], scale:1.5 },
          geyser_custom_x:{ position:[-1.5,3.25,0.5], rotation:[-9,0,0] },
          geyser_custom_y: fpr.rotation ? { rotation:[0,-(fpr.rotation[1]||0),0] } : undefined,
          geyser_custom_z: fpr.rotation ? { rotation:[0,0,fpr.rotation[2]||0]   } : undefined,
        },
      },
      [`animation.geyser_custom.${g}.firstperson_off_hand`]: {
        loop:true, bones: {
          geyser_custom:{ rotation:[0,180,0], position:[-16,14,14], scale:1.1 },
          geyser_custom_x:{ rotation:[9.47,0,0], position:[5.5,10.0,-3.75] },
          geyser_custom_y: fpl.rotation ? { rotation:[0,-(fpl.rotation[1]||0),0] } : undefined,
          geyser_custom_z: fpl.rotation ? { rotation:[0,0,fpl.rotation[2]||0]   } : undefined,
        },
      },
    },
  };

  // Strip undefined values recursively
  return JSON.parse(JSON.stringify(anim));
}

// ── Generate attachable JSON ──────────────────────────────────────────────────
function genAttachable(entry, atlasIndex, attachableMat) {
  const { path_hash, namespace, model_path, model_name, geometry, generated } = entry;
  const texturePath = generated
    ? `textures/${namespace}/${model_path}/${model_name}`
    : `textures/${atlasIndex}`;
  return {
    format_version:'1.10.0',
    'minecraft:attachable': { description: {
      identifier: `geyser_custom:${path_hash}`,
      materials:{ default:attachableMat, enchanted:attachableMat },
      textures:{ default:texturePath, enchanted:'textures/misc/enchanted_item_glint' },
      geometry:{ default:`geometry.geyser_custom.${geometry}` },
      scripts:{
        pre_animation:['v.main_hand = c.item_slot == \'main_hand\';','v.off_hand = c.item_slot == \'off_hand\';','v.head = c.item_slot == \'head\';'],
        animate:[
          { thirdperson_main_hand:'v.main_hand && !c.is_first_person' },
          { thirdperson_off_hand:'v.off_hand && !c.is_first_person' },
          { thirdperson_head:'v.head && !c.is_first_person' },
          { firstperson_main_hand:'v.main_hand && c.is_first_person' },
          { firstperson_off_hand:'v.off_hand && c.is_first_person' },
          { firstperson_head:'c.is_first_person && v.head' },
        ],
      },
      animations:{
        thirdperson_main_hand:`animation.geyser_custom.${geometry}.thirdperson_main_hand`,
        thirdperson_off_hand:`animation.geyser_custom.${geometry}.thirdperson_off_hand`,
        thirdperson_head:`animation.geyser_custom.${geometry}.head`,
        firstperson_main_hand:`animation.geyser_custom.${geometry}.firstperson_main_hand`,
        firstperson_off_hand:`animation.geyser_custom.${geometry}.firstperson_off_hand`,
        firstperson_head:'animation.geyser_custom.disable',
      },
      render_controllers:['controller.render.item_default'],
    }},
  };
}

// ── Generate geyser_mappings.json ─────────────────────────────────────────────
function genMappings(config, ver) {
  if (ver === '2') {
    const out = { format_version:2, items:{} };
    for (const e of Object.values(config)) {
      const k = 'minecraft:'+e.item;
      if (!out.items[k]) out.items[k]=[];
      const def = { type:'legacy', custom_model_data:e.nbt.CustomModelData, bedrock_identifier:e.path_hash };
      if (e.bedrock_icon?.icon) def.bedrock_options={ icon:e.path_hash };
      out.items[k].push(def);
    }
    return out;
  }
  const out = {};
  for (const e of Object.values(config)) {
    const k = 'minecraft:'+e.item;
    if (!out[k]) out[k]=[];
    const entry = { name:e.path_hash, allow_offhand:true, icon:e.path_hash };
    if (e.nbt.CustomModelData!=null) entry.custom_model_data = e.nbt.CustomModelData;
    if (e.nbt.Damage!=null)          entry.damage_predicate  = e.nbt.Damage;
    if (e.nbt.Unbreakable)           entry.unbreakable       = e.nbt.Unbreakable;
    if (!e.generated && e.bedrock_icon?.frame!=null) entry.frame = e.bedrock_icon.frame;
    out[k].push(entry);
  }
  return { format_version:'1', items:out };
}

// ── Texture atlas builder (pure Node/sharp) ───────────────────────────────────
async function buildAtlas(texPaths) {
  const SIDE=16; const images=[];
  for (const tp of texPaths) {
    try { const m=await sharp(tp).metadata(); images.push({path:tp,w:m.width||SIDE,h:Math.min(m.width||SIDE,m.height||SIDE)}); }
    catch { images.push({path:tp,w:SIDE,h:SIDE}); }
  }
  if (!images.length) {
    const buf=await sharp({create:{width:16,height:16,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
    return {image:buf,frames:{},size:{w:16,h:16}};
  }
  images.sort((a,b)=>b.h-a.h);
  const MAX_W=2048; let cx=0,cy=0,rowH=0,tw=0,th=0; const placed=[];
  for (const img of images) {
    if (cx+img.w>MAX_W){cy+=rowH;cx=0;rowH=0;}
    placed.push({...img,x:cx,y:cy}); cx+=img.w; rowH=Math.max(rowH,img.h); tw=Math.max(tw,cx); th=cy+rowH;
  }
  const np2=n=>{let p=1;while(p<n)p<<=1;return p;};
  const aw=np2(Math.max(tw,1)), ah=np2(Math.max(th,1));
  const frames={}, composites=[];
  for (const p of placed) {
    frames[p.path]={x:p.x,y:p.y,w:p.w,h:p.h};
    try { const buf=await sharp(p.path).extract({left:0,top:0,width:p.w,height:p.h}).ensureAlpha().toBuffer(); composites.push({input:buf,left:p.x,top:p.y}); } catch {}
  }
  const image=await sharp({create:{width:aw,height:ah,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(composites).png().toBuffer();
  return {image,frames,size:{w:aw,h:ah}};
}

// ── Main convert function ─────────────────────────────────────────────────────
async function convert(opts, emitFn) {
  setEmit(emitFn);
  const {
    zipPath, outputDir,
    mappingVersion='1', resolution=64,
    attachableMat='entity_alphatest_one_sided',
    blockMat='alpha_test',
  } = opts;

  const resourceRoot = process.resourcesPath || path.join(__dirname,'..', '..');
  const renderScript = path.join(resourceRoot, 'render_icon.js');

  const work = path.join(os.tmpdir(), `j2b_${crypto.randomBytes(4).toString('hex')}`);
  mkdirp(work);
  log('process', `Work dir: ${work}`);

  // ── Extract pack
  log('process', 'Extracting input pack…');
  new AdmZip(zipPath).extractAllTo(work, true);
  const assetsDir = path.join(work, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error('Invalid pack: no assets/ folder');
  if (!fs.existsSync(path.join(work, 'pack.mcmeta'))) throw new Error('Invalid pack: no pack.mcmeta');

  // ── Geyser item texture mapping
  log('process', 'Downloading Geyser item mappings…');
  const scratch = path.join(work, '_scratch'); mkdirp(scratch);
  const itPath  = path.join(scratch, 'item_texture.json');
  await fetchFile('https://raw.githubusercontent.com/Kas-tle/java2bedrockMappings/main/item_texture.json', itPath);
  const itemTexture = readJson(itPath) || {};

  // ── Build predicate config
  log('process', 'Building predicate config…');
  let config = {};
  const oldDir = path.join(assetsDir, 'minecraft', 'models', 'item');
  const newDir = path.join(assetsDir, 'minecraft', 'items');
  if (fs.existsSync(oldDir)) { Object.assign(config, buildConfigOld(oldDir, itemTexture)); log('completion', `OLD format: ${Object.keys(config).length} entries`); }
  if (fs.existsSync(newDir)) { const nc=buildConfigNew(newDir); Object.assign(config,nc); log('completion', `NEW format: ${Object.keys(nc).length} entries`); }
  if (!Object.keys(config).length) throw new Error('No item models found in pack');

  // Validate model files exist
  for (const [gid, e] of Object.entries(config)) {
    e.absPath = path.join(work, e.relPath);
    if (!fs.existsSync(e.absPath)) { delete config[gid]; }
  }
  log('critical', `After file validation: ${Object.keys(config).length} entries`);

  // ── Fallback vanilla assets (cached)
  log('process', 'Loading fallback vanilla assets…');
  try {
    // J2B_USER_DATA set by main.js; fallback to platform appdata
    const appData = process.env.APPDATA || process.env.HOME || os.homedir();
    const userDataDir = process.env.J2B_USER_DATA || path.join(appData, 'j2b-converter');
    const cacheDir = path.join(userDataDir, 'cache'); mkdirp(cacheDir);
    const cachedZip = path.join(cacheDir, 'fallback_1.20.4.zip');
    if (!fs.existsSync(cachedZip)) {
      log('process', 'Downloading fallback assets (first time only, ~50MB)…');
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
      if (!fs.existsSync(dest)) { try { mkdirp(path.dirname(dest)); fs.writeFileSync(dest, e.getData()); } catch {} }
    }
    log('completion', 'Fallback assets merged');
  } catch (e) { log('error', 'Fallback failed (continuing): '+e.message); }

  // ── Crop animated textures
  log('process', 'Cropping animated textures…');
  for (const p of findMcmetaPngs(assetsDir)) if (fs.existsSync(p)) await cropAnimated(p);

  // ── Resolve parents + assign hashes
  log('process', 'Resolving model parents…');
  const totalEntries = Object.keys(config).length; let resolveIdx=0;
  for (const [gid, e] of Object.entries(config)) {
    resolveIdx++;
    emitFn({ type:'progress', done:resolveIdx, total:totalEntries, current:e.model_name });
    const mj = readJson(e.absPath);
    if (!mj) { delete config[gid]; continue; }
    const resolved = resolveParent(mj, assetsDir);
    if (!resolved.elements && !resolved.isGenerated) { delete config[gid]; continue; }
    e.resolved  = resolved;
    e.generated = resolved.isGenerated;
    // Hash matches converter.sh: item_c{cmd}_d{dmg}_u{unb}
    const predStr = e.item + '_c' + e.nbt.CustomModelData + '_d' + e.nbt.Damage + '_u' + e.nbt.Unbreakable;
    e.path_hash = 'gmdl_' + hash7(predStr);
    e.geometry  = 'geo_'  + hash7(e.relPath);
  }
  log('completion', `After resolve: ${Object.keys(config).length} entries`);

  // ── RP directory structure
  const rpDir = path.join(work, 'target', 'rp');
  ['models/blocks','textures/zicon','attachables','animations'].forEach(d => mkdirp(path.join(rpDir,d)));
  const packIconSrc = path.join(work, 'pack.png');
  if (fs.existsSync(packIconSrc)) fs.copyFileSync(packIconSrc, path.join(rpDir,'pack_icon.png'));
  const packDesc = readJson(path.join(work,'pack.mcmeta'))?.pack?.description || 'Geyser 3D Items Resource Pack';
  fs.writeFileSync(path.join(rpDir,'manifest.json'), JSON.stringify({
    format_version:2,
    header:{ description:'Adds 3D items for use with a Geyser proxy', name:packDesc, uuid:uuidv4(), version:[1,0,0], min_engine_version:[1,18,3] },
    modules:[{ description:'Adds 3D items', type:'resources', uuid:uuidv4(), version:[1,0,0] }],
  }, null, 2));
  fs.writeFileSync(path.join(rpDir,'textures','terrain_texture.json'), JSON.stringify({
    resource_pack_name:'geyser_custom', texture_name:'atlas.terrain', texture_data:{},
  }, null, 2));
  fs.writeFileSync(path.join(rpDir,'animations','animation.geyser_custom.disable.json'), JSON.stringify({
    format_version:'1.8.0',
    animations:{ 'animation.geyser_custom.disable':{ loop:true, override_previous_animation:true, bones:{ geyser_custom:{ scale:0 } } } },
  }, null, 2));

  const itemTextureOut = { resource_pack_name:'geyser_custom', texture_name:'atlas.items', texture_data:{} };
  const terrainTextureOut = readJson(path.join(rpDir,'textures','terrain_texture.json'));

  // ── Group entries by which textures they use → atlas groups
  // Same approach as converter.sh union atlas: entries sharing textures share an atlas
  log('process', 'Building texture atlases…');
  const entries3d  = Object.values(config).filter(e => e.resolved && !e.generated && e.resolved.elements);
  const entries2d  = Object.values(config).filter(e => e.resolved && e.generated);

  // Collect texture paths per entry
  for (const e of entries3d) {
    e._texPaths = [];
    if (!e.resolved?.textures) continue;
    for (const ref of Object.values(e.resolved.textures)) {
      const fp = resolveTexPath(ref, e.resolved.textures, assetsDir);
      if (fp) e._texPaths.push(fp);
    }
  }

  // Union-find grouping: entries sharing any texture go into same atlas
  const parent2 = new Map();
  const find = x => { let r=x; while(parent2.get(r)!==r) r=parent2.get(r); while(x!==r){const n=parent2.get(x);parent2.set(x,r);x=n;} return r; };
  const union = (a,b) => { a=find(a);b=find(b); if(a!==b) parent2.set(a,b); };
  for (const e of entries3d) parent2.set(e.geyserID, e.geyserID);
  const texToGid = new Map();
  for (const e of entries3d) {
    for (const tp of (e._texPaths||[])) {
      if (texToGid.has(tp)) union(e.geyserID, texToGid.get(tp));
      else texToGid.set(tp, e.geyserID);
    }
  }

  // Collect atlas groups
  const atlasGroups = new Map();
  for (const e of entries3d) {
    const root = find(e.geyserID);
    if (!atlasGroups.has(root)) atlasGroups.set(root, []);
    atlasGroups.get(root).push(e);
  }

  log('completion', `Building ${atlasGroups.size} atlas(es)…`);
  const atlasIndexMap = new Map(); // geyserID → atlas index string
  let atlasIdx = 0;

  for (const [, group] of atlasGroups) {
    const texSet = new Set();
    for (const e of group) for (const tp of (e._texPaths||[])) texSet.add(tp);
    const texList = [...texSet];
    const aIdx    = String(atlasIdx++);

    const atlas = await buildAtlas(texList);
    const atlasName = aIdx;
    const atlasPngPath = path.join(rpDir, 'textures', atlasName+'.png');
    fs.writeFileSync(atlasPngPath, atlas.image);
    terrainTextureOut.texture_data[`gmdl_atlas_${atlasName}`] = { textures:`textures/${atlasName}` };

    for (const e of group) {
      atlasIndexMap.set(e.geyserID, { index:atlasName, frames:atlas.frames, size:atlas.size });
    }
  }
  fs.writeFileSync(path.join(rpDir,'textures','terrain_texture.json'), JSON.stringify(terrainTextureOut,null,2));

  // ── Generate geometry, animation, attachable for 3D entries
  log('process', `Generating geometry + animation + attachable for ${entries3d.length} 3D models…`);
  let convertIdx=0;
  for (const e of entries3d) {
    convertIdx++;
    emitFn({ type:'progress', done:convertIdx, total:entries3d.length, current:e.model_name });

    const atlasInfo = atlasIndexMap.get(e.geyserID);
    if (!atlasInfo) { log('error', `No atlas for ${e.geyserID}`); continue; }

    // Resolve texture abs paths for UV calc (store on resolved)
    e.resolved._absTexMap = {};
    for (const [k,ref] of Object.entries(e.resolved.textures||{})) {
      const fp = resolveTexPath(ref, e.resolved.textures, assetsDir);
      if (fp) e.resolved._absTexMap[k] = fp;
    }

    // Geometry
    const geoJson = genGeometry(e, atlasInfo.frames, atlasInfo.size);
    const geoParts = [rpDir,'models','blocks',e.namespace,e.model_path].filter(Boolean);
    const geoDir   = path.join(...geoParts);
    mkdirp(geoDir);
    fs.writeFileSync(path.join(geoDir, e.model_name+'.json'), JSON.stringify(geoJson,null,2));

    // Animation
    const animJson = genAnimations(e);
    const animParts = [rpDir,'animations',e.namespace,e.model_path].filter(Boolean);
    const animDir   = path.join(...animParts);
    mkdirp(animDir);
    fs.writeFileSync(path.join(animDir, `animation.${e.model_name}.json`), JSON.stringify(animJson,null,2));

    // Attachable
    const attJson = genAttachable(e, atlasInfo.index, attachableMat);
    const attParts = [rpDir,'attachables',e.namespace,e.model_path].filter(Boolean);
    const attDir   = path.join(...attParts);
    mkdirp(attDir);
    fs.writeFileSync(path.join(attDir, `${e.model_name}.${e.path_hash}.attachable.json`), JSON.stringify(attJson,null,2));
  }

  // ── 2D entries: copy texture
  log('process', `Processing ${entries2d.length} 2D (generated) items…`);
  for (const e of entries2d) {
    if (!e.resolved?.textures) continue;
    const firstRef = Object.values(e.resolved.textures)[0];
    if (!firstRef) continue;
    const texFile = resolveTexPath(firstRef, e.resolved.textures, assetsDir);
    if (!texFile) continue;
    const destParts2d = [rpDir,'textures',e.namespace,e.model_path].filter(Boolean);
    const destDir2d   = path.join(...destParts2d);
    mkdirp(destDir2d);
    fs.copyFileSync(texFile, path.join(destDir2d, e.model_name+'.png'));
    const texRef2d = e.model_path
      ? `textures/${e.namespace}/${e.model_path}/${e.model_name}`
      : `textures/${e.namespace}/${e.model_name}`;
    itemTextureOut.texture_data[e.path_hash] = { textures: texRef2d };

    // Geometry + animation + attachable for 2D items
    const geoJson2d  = genGeometry(e, {}, { w:16,h:16 });
    const geoParts2d = [rpDir,'models','blocks',e.namespace,e.model_path].filter(Boolean);
    mkdirp(path.join(...geoParts2d));
    fs.writeFileSync(path.join(...geoParts2d, e.model_name+'.json'), JSON.stringify(geoJson2d,null,2));
    const animJson2d = genAnimations(e);
    const animParts2d = [rpDir,'animations',e.namespace,e.model_path].filter(Boolean);
    mkdirp(path.join(...animParts2d));
    fs.writeFileSync(path.join(...animParts2d, `animation.${e.model_name}.json`), JSON.stringify(animJson2d,null,2));
    const attJson2d  = genAttachable(e, null, attachableMat);
    const attParts2d = [rpDir,'attachables',e.namespace,e.model_path].filter(Boolean);
    mkdirp(path.join(...attParts2d));
    fs.writeFileSync(path.join(...attParts2d, `${e.model_name}.${e.path_hash}.attachable.json`), JSON.stringify(attJson2d,null,2));
  }

  // ── Zicons (render_icon.js for 3D, texture copy for 2D)
  log('process', 'Rendering zicons…');
  const zIconJobs=[], seenModel=new Map();

  for (const e of [...entries3d, ...entries2d]) {
    const iconParts = [rpDir,'textures','zicon',e.namespace,e.model_path].filter(Boolean);
    const iconDir   = path.join(...iconParts);
    mkdirp(iconDir);
    const outIcon = path.join(iconDir, e.path_hash+'.png');
    const iconRef = e.model_path
      ? `textures/zicon/${e.namespace}/${e.model_path}/${e.path_hash}`
      : `textures/zicon/${e.namespace}/${e.path_hash}`;

    if (e.generated) {
      // 2D: copy texture
      const texFile = e.resolved?.textures ? resolveTexPath(Object.values(e.resolved.textures)[0], e.resolved.textures||{}, assetsDir) : null;
      if (texFile && !fs.existsSync(outIcon)) fs.copyFileSync(texFile, outIcon);
      if (fs.existsSync(outIcon)) itemTextureOut.texture_data[e.path_hash] = { textures:iconRef };
      continue;
    }

    if (seenModel.has(e.absPath)) {
      zIconJobs.push({ modelFile:e.absPath, outFile:outIcon, copyFrom:seenModel.get(e.absPath) });
    } else {
      seenModel.set(e.absPath, outIcon);
      zIconJobs.push({ modelFile:e.absPath, outFile:outIcon });
    }
    itemTextureOut.texture_data[e.path_hash] = { textures:iconRef };
  }

  const renderJobs = zIconJobs.filter(j=>!j.copyFrom);
  log('completion', `Render jobs: ${renderJobs.length} unique, ${zIconJobs.length-renderJobs.length} reused`);

  if (renderJobs.length > 0) {
    const tmpCsv = path.join(os.tmpdir(), `j2b_jobs_${Date.now()}.csv`);
    fs.writeFileSync(tmpCsv, renderJobs.map(j=>`${j.modelFile},${j.outFile}`).join('\n'));
    const { fork } = require('child_process');
    let doneR=0; const totalR=renderJobs.length;
    await new Promise((resolve,reject) => {
      const child = fork(renderScript, [tmpCsv, assetsDir], { silent:true, env:{...process.env} });
      child.stdout.on('data', d => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          process.stdout.write(line+'\n');
          if (line.startsWith('ok:')) {
            doneR++;
            const outPath=line.slice(4).trim();
            const name=outPath.split(/[/\\]/).pop().replace('.png','');
            emitFn({ type:'progress', done:doneR, total:totalR, current:name });
            try { emitFn({ type:'preview', dataUrl:'data:image/png;base64,'+fs.readFileSync(outPath).toString('base64'), name }); } catch {}
          }
        }
      });
      child.stderr.on('data', d=>process.stderr.write(d.toString()));
      child.on('close', code=>code===0?resolve():reject(new Error('render_icon exited '+code)));
      child.on('error', reject);
    });
    try { fs.unlinkSync(tmpCsv); } catch {}
    for (const j of zIconJobs.filter(j=>j.copyFrom)) {
      if (fs.existsSync(j.copyFrom)) { mkdirp(path.dirname(j.outFile)); fs.copyFileSync(j.copyFrom, j.outFile); }
    }
  }

  // ── item_texture.json
  fs.writeFileSync(path.join(rpDir,'textures','item_texture.json'), JSON.stringify(itemTextureOut,null,2));

  // ── Lang files
  log('process', 'Writing lang files…');
  mkdirp(path.join(rpDir,'texts'));
  const fmt = s => s.charAt(0).toUpperCase() + s.slice(1).replace(/_([a-z])/g,(m,c)=>' '+c.toUpperCase());
  const langLines = Object.values(config).map(e=>`item.geyser_custom:${e.path_hash}.name=${fmt(e.item)}`).join('\n');
  fs.writeFileSync(path.join(rpDir,'texts','en_US.lang'), langLines);
  fs.writeFileSync(path.join(rpDir,'texts','en_GB.lang'), langLines);
  fs.writeFileSync(path.join(rpDir,'texts','languages.json'), JSON.stringify(['en_US','en_GB'],null,2));

  // ── geyser_mappings.json
  log('process', 'Writing geyser_mappings.json…');
  const mappings = genMappings(config, mappingVersion);
  const mappingsPath = path.join(work,'target','geyser_mappings.json');
  mkdirp(path.dirname(mappingsPath));
  fs.writeFileSync(mappingsPath, JSON.stringify(mappings,null,2));

  // ── Package → .mcpack
  log('process', 'Packaging output…');
  mkdirp(path.join(work,'target','packaged'));
  const outZip = new AdmZip();
  const addDir = (dir, zBase) => {
    for (const f of fs.readdirSync(dir,{withFileTypes:true})) {
      const fp=path.join(dir,f.name), zp=zBase+'/'+f.name;
      if (f.isDirectory()) addDir(fp,zp); else outZip.addFile(zp, fs.readFileSync(fp));
    }
  };
  addDir(rpDir, '');
  const mcpackPath = path.join(work,'target','packaged','geyser_resources.mcpack');
  outZip.writeZip(mcpackPath);

  // ── Copy outputs
  mkdirp(outputDir);
  fs.copyFileSync(mcpackPath,  path.join(outputDir,'geyser_resources.mcpack'));
  fs.copyFileSync(mappingsPath, path.join(outputDir,'geyser_mappings.json'));

  try { fs.rmSync(work,{recursive:true,force:true}); } catch {}
  log('completion', 'Done! Output: '+outputDir);
  emitFn({ type:'output-dir', path:outputDir });
}

module.exports = { convert };

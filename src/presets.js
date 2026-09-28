'use strict';
/**
 * 相纸方案：内置（各尺寸拍立得/宝丽来/胶片的比例与输出分辨率）+ 用户自建。
 * 持久化到 DATA_DIR/presets.json —— 「扫描相纸对应的方案固定下来」就是这个文件；
 * 首次启动播种内置方案，之后的编辑/新增/删除都落盘。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 内置方案：ratio 为「框选比例」[宽,高]（手动框选时锁定），outLong 固定输出长边 */
const BUILT_INS = [
  { name: 'Instax Mini · 整张相纸', ratio: [54, 86], outLong: 1600, tolerance: 28, minAreaPct: 0.4, expandPct: 1, format: 'jpeg', quality: 92 },
  { name: 'Instax Mini · 画面区', ratio: [46, 62], outLong: 1600, tolerance: 28, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
  { name: 'Instax Square', ratio: [62, 62], outLong: 1800, tolerance: 28, minAreaPct: 0.4, expandPct: 1, format: 'jpeg', quality: 92 },
  { name: 'Instax Wide · 整张相纸', ratio: [108, 86], outLong: 2000, tolerance: 28, minAreaPct: 0.4, expandPct: 1, format: 'jpeg', quality: 92 },
  { name: 'Instax Wide · 画面区', ratio: [99, 62], outLong: 2000, tolerance: 28, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
  { name: 'Polaroid 600 · 整张相纸', ratio: [88, 107], outLong: 2000, tolerance: 28, minAreaPct: 0.4, expandPct: 1, format: 'jpeg', quality: 92 },
  { name: 'Polaroid 600 · 画面区', ratio: [79, 79], outLong: 2000, tolerance: 28, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
  { name: 'Polaroid Go · 整张相纸', ratio: [53, 71], outLong: 1600, tolerance: 28, minAreaPct: 0.4, expandPct: 1, format: 'jpeg', quality: 92 },
  { name: 'Polaroid Go · 画面区', ratio: [34, 42], outLong: 1600, tolerance: 28, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
  { name: '135 胶片单帧（横）', ratio: [3, 2], outLong: 2400, tolerance: 20, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
  { name: '135 胶片单帧（竖）', ratio: [2, 3], outLong: 2400, tolerance: 20, minAreaPct: 0.4, expandPct: 0, format: 'jpeg', quality: 92 },
];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };

/** 字段校验/归一（服务端入口统一走这里，防脏数据落盘） */
function normalizePreset(raw, keepId) {
  const r = raw || {};
  const ratio = Array.isArray(r.ratio) && r.ratio.length === 2
    ? [clamp(numOr(r.ratio[0], 1), 0.1, 200), clamp(numOr(r.ratio[1], 1), 0.1, 200)] // 比例分量是毫米量级（54/86/108…），上限放宽
    : null;
  if (!ratio) return null;
  const name = String(r.name || '').trim();
  if (!name) return null;
  return {
    id: keepId || crypto.randomUUID(),
    name,
    ratio,
    outLong: clamp(Math.round(numOr(r.outLong, 1600)), 64, 8000),
    tolerance: clamp(Math.round(numOr(r.tolerance, 28)), 1, 128),
    minAreaPct: clamp(numOr(r.minAreaPct, 0.4), 0.05, 10),   // 百分比，引擎内 /100
    expandPct: clamp(numOr(r.expandPct, 1), 0, 20),
    format: r.format === 'png' ? 'png' : 'jpeg',
    quality: clamp(Math.round(numOr(r.quality, 92)), 50, 100),
    builtIn: !!r.builtIn,
    time: Date.now(),
  };
}

class PresetStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const [id, p] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
        if (p && p.id && p.name) this.map.set(id, p);
      }
    } catch { /* 首次无文件 */ }
    let seeded = false;
    for (const b of BUILT_INS) {
      if ([...this.map.values()].some((p) => p.name === b.name)) continue;
      const p = normalizePreset({ ...b, builtIn: true });
      if (p) { this.map.set(p.id, p); seeded = true; }
    }
    if (seeded) this.flushNow();
  }

  list() {
    return [...this.map.values()].sort((a, b) =>
      (b.builtIn - a.builtIn) || (b.time - a.time));
  }

  get(id) { return this.map.get(id) || null; }

  /** 按名称取（CLI 用） */
  getByName(name) { return this.list().find((p) => p.name === name) || null; }

  upsert(raw, id) {
    const p = normalizePreset(raw, id);
    if (!p) return null;
    const prev = id ? this.map.get(id) : null;
    if (prev) p.builtIn = prev.builtIn; // 内置标记不随编辑丢失
    this.map.set(p.id, p);
    this.flushNow();
    return p;
  }

  remove(id) {
    if (!this.map.has(id)) return false;
    this.map.delete(id);
    this.flushNow();
    return true;
  }

  flushNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[presets] 保存失败:', e.message); }
  }
}

module.exports = { PresetStore, normalizePreset, BUILT_INS };

#!/usr/bin/env node
'use strict';
/**
 * FilmCut CLI
 *   filmcut presets                          列出相纸方案
 *   filmcut cut <扫描目录|单文件> -o <输出目录>
 *       [--preset "Instax Mini · 整张相纸"]   按名称选方案（比例/输出分辨率随方案固定）
 *       [--tolerance 28] [--out-long 1600] [--expand 1] [--format jpeg]
 *       [--min-area 0.4] [--recursive] [--skip-done]
 *
 * 无扫描参数时用默认值（容差 28 / 输出长边 1600）。
 */
const fs = require('fs');
const path = require('path');
const { detectPrints } = require('../src/core/detect');
const { cropPrint, IMAGE_EXTS } = require('../src/core/crop');
const { PresetStore } = require('../src/presets');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true, i++;
  else args._ = (args._ || []).concat(a);
}

async function main() {
  const dataDir = process.env.FILMCUT_DATA_DIR || path.join(__dirname, '..', 'data');
  const store = new PresetStore(path.join(dataDir, 'presets.json'));

  if (args._ && args._[0] === 'presets') {
    for (const p of store.list()) {
      console.log(`${p.builtIn ? '*' : ' '} ${p.name}  比例 ${p.ratio.join(':')}  输出长边 ${p.outLong}px  容差 ${p.tolerance}`);
    }
    console.log('（* = 内置方案；方案保存在 ' + path.join(dataDir, 'presets.json') + '）');
    return;
  }

  const target = args._ && args._[0];
  if (!target) {
    console.log('用法: filmcut cut <扫描目录|单文件> -o <输出目录> [--preset 名称] [--tolerance 28] [--out-long 1600]\n      filmcut presets');
    process.exit(args._ ? 1 : 0);
  }

  const preset = args.preset ? store.getByName(String(args.preset)) : null;
  if (args.preset && !preset) { console.error(`✗ 找不到方案「${args.preset}」，先 filmcut presets 查看`); process.exit(1); }
  const opts = preset ? {
    tolerance: preset.tolerance, minAreaPct: preset.minAreaPct / 100,
    expandPct: preset.expandPct, outLong: preset.outLong, format: preset.format, quality: preset.quality,
  } : {};
  if (args.tolerance) opts.tolerance = Number(args.tolerance);
  if (args['out-long']) opts.outLong = Number(args['out-long']);
  if (args.expand !== undefined) opts.expandPct = Number(args.expand);
  if (args['min-area']) opts.minAreaPct = Number(args['min-area']) / 100;
  if (args.format) opts.format = String(args.format);

  const inPath = path.resolve(String(target));
  let files;
  if (fs.statSync(inPath).isFile()) files = [inPath];
  else {
    files = [];
    const scan = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (args.recursive) scan(full); }
        else if (IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) files.push(full);
      }
    };
    scan(inPath);
  }
  const outDir = path.resolve(String(args.o || path.join(path.dirname(files[0] || inPath), 'filmcut')));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`扫描件 ${files.length} 个 → ${outDir}${preset ? `（方案：${preset.name}）` : '（默认参数）'}`);

  let crops = 0, failed = 0;
  for (const file of files) {
    const stem = path.basename(file, path.extname(file));
    const skipName = `${stem}-1${opts.format === 'png' ? '.png' : '.jpg'}`;
    if (args['skip-done'] && fs.existsSync(path.join(outDir, skipName))) { console.log(`↷ ${path.basename(file)} 已处理过`); continue; }
    try {
      const buf = fs.readFileSync(file);
      const det = await detectPrints(buf, { tolerance: opts.tolerance ?? 28, minAreaPct: opts.minAreaPct ?? 0.004, ratio: preset ? preset.ratio : null });
      if (!det.boxes.length) { console.log(`✗ ${path.basename(file)}：未检测到相纸`); failed++; continue; }
      for (let i = 0; i < det.boxes.length; i++) {
        const r = await cropPrint(buf, det.boxes[i], opts);
        const out = path.join(outDir, `${stem}-${i + 1}${r.ext}`);
        fs.writeFileSync(out, r.buffer);
        console.log(`✓ ${path.basename(file)} → ${path.basename(out)}  ${r.width}×${r.height}${det.boxes[i].angle ? `（摆正 ${det.boxes[i].angle}°）` : ''}`);
        crops++;
      }
    } catch (e) {
      console.log(`✗ ${path.basename(file)}：${e.message}`);
      failed++;
    }
  }
  console.log(`\n完成：裁出 ${crops} 张，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });

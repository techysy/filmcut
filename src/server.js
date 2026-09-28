'use strict';
/**
 * FilmCut 裁片 — 胶片/拍立得/宝丽来扫描件裁剪服务。
 * 架构与 ImgMark 同款：Express + sharp，无鉴权只绑本机；方案（相纸预设）持久化在数据目录。
 *
 * 数据目录：IMGMARK 风格 —— 环境变量 FILMCUT_DATA_DIR，默认项目内 data/
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { detectPrints } = require('./core/detect');
const { cropPrint, IMAGE_EXTS } = require('./core/crop');
const { PresetStore } = require('./presets');

const PORT = Number(process.env.PORT || 28210);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.FILMCUT_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const presets = new PresetStore(path.join(DATA_DIR, 'presets.json'));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/** 方案的引擎参数（detect/crop 共用；ratio 同时用于检测的比例亲和过滤） */
function engineOpts(preset) {
  return {
    tolerance: preset.tolerance,
    minAreaPct: preset.minAreaPct / 100,
    ratio: preset.ratio,
    expandPct: preset.expandPct,
    outLong: preset.outLong,
    format: preset.format,
    quality: preset.quality,
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'filmcut', dataDir: DATA_DIR }));

// ---- 相纸方案 ----
app.get('/api/presets', (req, res) => res.json(presets.list()));

app.post('/api/presets', (req, res) => {
  const p = presets.upsert(req.body || {}, req.body && req.body.id);
  if (!p) return res.status(400).json({ error: '方案不合法：需要名称与比例 [宽,高]' });
  res.json(p);
});

app.delete('/api/presets/:id', (req, res) => {
  const p = presets.get(req.params.id);
  if (!p) return res.status(404).json({ error: '方案不存在' });
  presets.remove(req.params.id);
  res.json({ ok: true });
});

// ---- 扫描图访问（画布显示用）----
const extOf = (name) => path.extname(name || '').toLowerCase();
function resolveScanPath(rawPath) {
  const p = String(rawPath || '');
  if (!path.isAbsolute(p) || !IMAGE_EXTS.has(extOf(p))) return null;
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return p;
}

app.get('/api/file', (req, res) => {
  const p = resolveScanPath(req.query.path);
  if (!p) return res.status(404).json({ error: '文件不存在或不是图片' });
  res.sendFile(p);
});

// ---- 检测 ----
app.post('/api/detect', express.json(), async (req, res) => {
  try {
    const p = resolveScanPath(req.body && req.body.path);
    if (!p) return res.status(400).json({ error: '文件路径无效' });
    const preset = presets.get(req.body && req.body.presetId);
    const opts = preset ? engineOpts(preset) : {};
    // 混合扫描（一张纸上多种相纸）时不按方案比例过滤，全部矩形区域都报出来
    const result = await detectPrints(fs.readFileSync(p), {
      tolerance: opts.tolerance,
      minAreaPct: opts.minAreaPct,
      ratio: (req.body && req.body.ignoreRatio) ? null : opts.ratio,
    });
    res.json(result);
  } catch (e) {
    console.error('[detect]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 单框裁剪（save=false 返回预览 dataURL；save=true 写文件）----
app.post('/api/crop', express.json(), async (req, res) => {
  try {
    const { path: rawPath, box, presetId, save, outDir, name } = req.body || {};
    const p = resolveScanPath(rawPath);
    if (!p) return res.status(400).json({ error: '文件路径无效' });
    if (!box || ![box.cx, box.cy, box.w, box.h].every((n) => Number.isFinite(n) && n > 0)) {
      return res.status(400).json({ error: '框不合法' });
    }
    const preset = presets.get(presetId);
    const opts = engineOpts(preset || {});
    const result = await cropPrint(fs.readFileSync(p), box, opts);
    if (save) {
      const dir = String(outDir || '').trim() || path.join(path.dirname(p), 'filmcut');
      if (!path.isAbsolute(dir)) return res.status(400).json({ error: '输出目录需为绝对路径' });
      fs.mkdirSync(dir, { recursive: true });
      const stem = path.basename(p, extOf(p));
      const used = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
      let file = `${stem}${result.ext}`;
      for (let n = 2; used.has(file.toLowerCase()); n++) file = `${stem}(${n})${result.ext}`;
      const target = path.join(dir, name ? String(name) + result.ext : file);
      fs.writeFileSync(target, result.buffer);
      return res.json({ output: target, width: result.width, height: result.height });
    }
    res.json({
      preview: `data:image/${result.ext === '.png' ? 'png' : 'jpeg'};base64,${result.buffer.toString('base64')}`,
      width: result.width, height: result.height,
    });
  } catch (e) {
    console.error('[crop]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 本地目录浏览（选扫描目录用，与 ImgMark 的 /api/browse 同款）----
app.post('/api/browse', express.json(), async (req, res) => {
  try {
    const dir = String((req.body && req.body.path) || '').trim() || path.parse(process.cwd()).root;
    if (!path.isAbsolute(dir)) return res.status(400).json({ error: '请输入绝对路径' });
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const dirs = [], images = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (d.isDirectory()) dirs.push(d.name);
      else if (IMAGE_EXTS.has(extOf(d.name))) images.push(d.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    images.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    res.json({ path: dir, parent: path.dirname(dir), dirs: dirs.slice(0, 300), imageCount: images.length, images: images.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 批量处理（目录 → 自动检测 → 逐相纸摆正裁剪 → 输出目录）----
const jobs = new Map(); // id -> {status,total,done,ok,failed,current,results,error,outputDir,finishedAt}
const JOB_TTL_MS = 6 * 3600 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await worker(items[i]) }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  });
  await Promise.all(runners);
  return results;
}

app.post('/api/process', express.json(), async (req, res) => {
  try {
    const { inputDir, outputDir, presetId, recursive, skipProcessed } = req.body || {};
    const inDir = String(inputDir || '').trim();
    if (!path.isAbsolute(inDir) || !fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory()) {
      return res.status(400).json({ error: `目录不存在：${inDir}` });
    }
    const preset = presets.get(presetId);
    if (!preset) return res.status(400).json({ error: '请先选择相纸方案' });
    const outDir = String(outputDir || '').trim() || path.join(inDir, 'filmcut');
    if (!path.isAbsolute(outDir)) return res.status(400).json({ error: '输出目录需为绝对路径' });
    if (path.resolve(outDir) === path.resolve(inDir)) return res.status(400).json({ error: '输出目录不能与扫描目录相同' });

    const scan = async (dir) => {
      const out = [];
      for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (recursive) out.push(...await scan(full)); }
        else if (IMAGE_EXTS.has(extOf(ent.name))) out.push(full);
      }
      return out;
    };
    const files = await scan(inDir);
    fs.mkdirSync(outDir, { recursive: true });
    const usedNames = new Set();

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId, status: 'running', total: files.length, done: 0, ok: 0, failed: 0, crops: 0,
      current: null, results: [], error: null, outputDir: outDir, startedAt: Date.now(), finishedAt: null,
    };
    jobs.set(jobId, job);
    res.json({ jobId, total: files.length });

    const opts = engineOpts(preset);
    // 混合扫描：不按方案比例过滤；输出旋转：整批统一转正（倒放/横放的相纸）
    const mixed = !!(req.body && req.body.mixed);
    const rotate = Math.round(Number(req.body && req.body.rotate) || 0);
    await mapPool(files, 2, async (file) => {
      const stat = await fs.promises.stat(file);
      const stem = path.basename(file, extOf(file));
      // 跳过已处理：输出目录里已有「同名-1」的产物
      if (skipProcessed && usedNames.size >= 0) {
        const first = `${stem}-1${preset.format === 'png' ? '.png' : '.jpg'}`;
        if (fs.existsSync(path.join(outDir, first))) {
          job.done++; job.current = file;
          job.results.push({ name: path.basename(file), ok: true, skipped: true });
          return;
        }
      }
      const buf = await fs.promises.readFile(file);
      const det = await detectPrints(buf, { tolerance: opts.tolerance, minAreaPct: opts.minAreaPct, ratio: mixed ? null : opts.ratio });
      if (!det.boxes.length) {
        job.done++; job.current = file; job.failed++;
        job.results.push({ name: path.basename(file), ok: false, error: '未检测到相纸（试试调大白底容差）' });
        return;
      }
      for (let i = 0; i < det.boxes.length; i++) {
        const r = await cropPrint(buf, det.boxes[i], { ...opts, rotate });
        let name = `${stem}-${i + 1}${r.ext}`;
        while (usedNames.has(name.toLowerCase())) name = `_${name}`;
        usedNames.add(name.toLowerCase());
        fs.writeFileSync(path.join(outDir, name), r.buffer);
        job.crops++;
        job.results.push({ name: path.basename(file), output: name, ok: true });
      }
      job.done++; job.ok++; job.current = file;
    });
    // 汇总 done/ok/failed（done 按文件计，ok/failed 已在循环里记）
    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (e) {
    console.error('[process]', e);
    const job = res.headersSent && jobs.get(String((req.body || {}).jobId || ''));
    if (job) { job.status = 'error'; job.error = e.message; }
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

function start({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`[filmcut] 监听 http://${host}:${port}  (数据目录 ${DATA_DIR}，内置 ${presets.list().filter((p) => p.builtIn).length} 个相纸方案)`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('[filmcut] 启动失败:', e.message); process.exit(1); });
}

module.exports = { app, start, presets };

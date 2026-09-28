'use strict';
/* FilmCut 裁片 — 前端逻辑：方案管理 / 目录浏览 / 画布框选微调 / 单张裁剪 / 批量进度 */
const $ = (id) => document.getElementById(id);
const state = {
  presets: [],
  presetId: null,
  scanDir: null,
  files: [],
  currentFile: null,   // {path, width, height}
  boxes: [],
  selected: -1,
  outDir: '',
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i) || [])[1] || '';

// ---------- ⓪ 相纸方案 ----------
function presetOf(id) { return state.presets.find((p) => p.id === id) || null; }
function curPreset() { return presetOf(state.presetId); }

function renderPresets() {
  const sel = $('preset-select');
  sel.innerHTML = state.presets.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === state.presetId ? 'selected' : ''}>${esc(p.name)}${p.builtIn ? '（内置）' : ''}</option>`).join('');
  if (!state.presets.length) sel.innerHTML = '<option value="">（还没有方案，点「＋ 新建方案」）</option>';
  const p = curPreset();
  $('preset-summary').textContent = p
    ? `框选比例 ${p.ratio[0]}:${p.ratio[1]} · 输出长边 ${p.outLong}px · 容差 ${p.tolerance} · 外扩 ${p.expandPct}% · ${p.format.toUpperCase()}`
    : '先选一个相纸方案：它决定框选比例、白底容差与固定输出分辨率';
  $('run-batch').disabled = !p;
}

async function loadPresets() {
  state.presets = await api('/api/presets').catch(() => []);
  if (!state.presetId || !presetOf(state.presetId)) state.presetId = state.presets[0] ? state.presets[0].id : null;
  renderPresets();
}

function openEditor(p) {
  $('preset-editor').classList.remove('hidden');
  $('preset-name').value = p ? p.name : '';
  $('preset-ratio').value = p ? p.ratio.join(':') : '';
  $('preset-outlong').value = p ? p.outLong : 1600;
  $('preset-tol').value = p ? p.tolerance : 28;
  $('preset-expand').value = p ? p.expandPct : 1;
  $('preset-format').value = p ? p.format : 'jpeg';
  $('preset-name').dataset.id = p ? p.id : '';
}
function closeEditor() { $('preset-editor').classList.add('hidden'); }

async function savePreset() {
  const ratio = $('preset-ratio').value.trim().split(/[:：]/).map((n) => Number(n));
  const payload = {
    id: $('preset-name').dataset.id || undefined,
    name: $('preset-name').value.trim(),
    ratio,
    outLong: +$('preset-outlong').value,
    tolerance: +$('preset-tol').value,
    expandPct: +$('preset-expand').value,
    format: $('preset-format').value,
  };
  try {
    const p = await api('/api/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await loadPresets();
    state.presetId = p.id;
    renderPresets();
    closeEditor();
    $('hint').textContent = `方案「${p.name}」已保存 ✓（比例与输出分辨率固定）`;
  } catch (e) { $('hint').textContent = '✗ ' + e.message; }
}

async function delPreset() {
  if (!state.presetId) return;
  try {
    await api('/api/presets/' + encodeURIComponent(state.presetId), { method: 'DELETE' });
    state.presetId = null;
    await loadPresets();
    $('hint').textContent = '方案已删除';
  } catch (e) { $('hint').textContent = '✗ ' + e.message; }
}

// ---------- ① 目录与文件 ----------
async function browse(path) {
  try {
    const r = await api('/api/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    state.scanDir = r.path;
    $('scan-dir').value = r.path;
    $('dir-browser').classList.remove('hidden');
    $('dir-crumbs').textContent = r.path;
    const parentBtn = r.parent && r.parent !== r.path ? `<button data-up="${esc(r.parent)}">⬆ 上一级</button>` : '';
    $('dir-entries').innerHTML =
      parentBtn +
      r.dirs.map((d) => `<button data-sub="${esc(d)}">📁 ${esc(d)}</button>`).join('') +
      (r.imageCount ? `<button class="picked-dir" data-pick="1">✓ 用这个目录（${r.imageCount} 张图）</button>` : '');
    $('dir-entries').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.up) browse(b.dataset.up);
      else if (b.dataset.sub) browse(r.path.replace(/[\\/]+$/, '') + '/' + b.dataset.sub);
      else { state.scanDir = r.path; renderFiles(r.images); }
    }));
  } catch (e) { $('hint').textContent = '✗ ' + e.message; }
}

function renderFiles(images) {
  $('dir-browser').classList.add('hidden');
  const box = $('file-list');
  box.innerHTML = images.length
    ? images.map((f) => `<button class="file-chip" data-f="${esc(f)}">${esc(f)}</button>`).join('')
    : '<span class="muted">目录里没有图片</span>';
  box.querySelectorAll('.file-chip').forEach((el) => el.addEventListener('click', () => {
    box.querySelectorAll('.file-chip').forEach((x) => x.classList.remove('on'));
    el.classList.add('on');
    loadScan(state.scanDir.replace(/[\\/]+$/, '') + '/' + el.dataset.f);
  }));
}

// ---------- 画布：加载 / 检测 / 框选 ----------
async function loadScan(path) {
  state.currentFile = null;
  state.boxes = [];
  state.selected = -1;
  $('canvas-wrap').classList.remove('empty');
  $('canvas-hint').textContent = '载入中…';
  const img = $('scan-img');
  img.hidden = false;
  img.src = '/api/file?path=' + encodeURIComponent(path);
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片加载失败')); }).catch(() => {});
  if (!img.naturalWidth) { $('canvas-hint').textContent = '图片加载失败'; return; }
  state.currentFile = { path, width: img.naturalWidth, height: img.naturalHeight };
  $('canvas-hint').textContent = '';
  await redetect();
}

async function redetect() {
  if (!state.currentFile) return;
  const p = curPreset();
  $('canvas-hint').textContent = '检测中…';
  try {
    const r = await api('/api/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentFile.path, presetId: state.presetId }),
    });
    state.boxes = r.boxes.map((b, i) => ({ ...b, id: i + 1 }));
    state.selected = state.boxes.length ? 0 : -1;
    $('canvas-hint').textContent = state.boxes.length
      ? `检测到 ${state.boxes.length} 张相纸（容差 ${p ? p.tolerance : 28}）。可拖动微调，空白处拖出新框。`
      : '未检测到相纸：把相纸放在白纸上重新扫描，或调大方案里的「白底容差」，也可空白处手动拖框。';
  } catch (e) {
    $('canvas-hint').textContent = '✗ 检测失败：' + e.message;
    state.boxes = [];
  }
  renderBoxes();
  hideCropPreview();
}

/** 把框渲染为覆盖层（含旋转角） */
function renderBoxes(dragBox) {
  const layer = $('box-layer');
  const cf = state.currentFile;
  layer.innerHTML = '';
  if (!cf) return;
  const img = $('scan-img');
  const dispW = img.clientWidth, dispH = img.clientHeight;
  if (!dispW) return;
  const sx = dispW / cf.width, sy = dispH / cf.height;
  const draw = (b, i, cls) => {
    const el = document.createElement('div');
    el.className = 'box ' + (i === state.selected ? 'on ' : '') + (cls || '');
    el.style.left = (b.cx - b.w / 2) * sx + 'px';
    el.style.top = (b.cy - b.h / 2) * sy + 'px';
    el.style.width = b.w * sx + 'px';
    el.style.height = b.h * sy + 'px';
    el.style.transform = `rotate(${b.angle || 0}deg)`;
    el.innerHTML = `<span class="tag">${i + 1} · ${Math.round(b.angle || 0)}°</span>`;
    el.dataset.i = i;
    layer.appendChild(el);
  };
  state.boxes.forEach((b, i) => draw(b, i));
  if (dragBox) draw(dragBox, state.boxes.length, 'dragnew');
  syncBoxTools();
}

function syncBoxTools() {
  const b = state.boxes[state.selected];
  $('box-tools').classList.toggle('hidden', !b);
  if (b) {
    $('box-angle').value = b.angle || 0;
    $('angle-v').textContent = (b.angle || 0).toFixed(1);
  }
}

// 框移动 / 新建拖框（全部换算回原图像素坐标）
let drag = null;
function canvasPoint(e) {
  const img = $('scan-img');
  const r = img.getBoundingClientRect();
  const cf = state.currentFile;
  if (!r.width || !cf) return null;
  const sx = cf.width / r.width, sy = cf.height / r.height;
  return {
    x: Math.max(0, Math.min(cf.width, (e.clientX - r.left) * sx)),
    y: Math.max(0, Math.min(cf.height, (e.clientY - r.top) * sy)),
  };
}
function hitBox(e) {
  const layer = $('box-layer');
  const el = e.target.closest && e.target.closest('.box');
  return el ? +el.dataset.i : -1;
}
$('box-layer').addEventListener('mousedown', (e) => {
  if (!state.currentFile) return;
  e.preventDefault();
  const i = hitBox(e);
  const p = canvasPoint(e);
  if (!p) return;
  if (i >= 0) {
    state.selected = i;
    const b = state.boxes[i];
    drag = { kind: 'move', start: p, orig: { ...b } };
  } else {
    const preset = curPreset();
    const ratio = preset ? preset.ratio[0] / preset.ratio[1] : 1;
    drag = { kind: 'new', start: p, ratio };
    state.selected = -1;
  }
  renderBoxes();
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e);
  if (!p) return;
  if (drag.kind === 'move') {
    const b = state.boxes[state.selected];
    if (!b) return;
    b.cx = Math.max(b.w / 2, Math.min(state.currentFile.width - b.w / 2, drag.orig.cx + (p.x - drag.start.x)));
    b.cy = Math.max(b.h / 2, Math.min(state.currentFile.height - b.h / 2, drag.orig.cy + (p.y - drag.start.y)));
    renderBoxes();
  } else {
    // 按方案比例锁定的新框：以拖拽对角线取最大内接框
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    const w = Math.abs(dx), h = Math.abs(dy);
    let bw, bh;
    if (w / drag.ratio > h) { bw = w; bh = w / drag.ratio; } else { bh = h; bw = h * drag.ratio; }
    if (bh < 8) { drag.preview = null; return; }
    const cx = drag.start.x + (dx >= 0 ? bw / 2 : -bw / 2);
    const cy = drag.start.y + (dy >= 0 ? bh / 2 : -bh / 2);
    drag.preview = { cx, cy, w: bw, h: bh, angle: 0 };
    renderBoxes(drag.preview);
  }
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.kind === 'new' && drag.preview) {
    state.boxes.push({ ...drag.preview, id: state.boxes.length + 1 });
    state.selected = state.boxes.length - 1;
    hideCropPreview();
  }
  drag = null;
  renderBoxes();
});

$('box-angle').addEventListener('input', () => {
  const b = state.boxes[state.selected];
  if (!b) return;
  b.angle = +$('box-angle').value;
  $('angle-v').textContent = b.angle.toFixed(1);
  renderBoxes();
});
$('box-del').addEventListener('click', () => {
  if (state.selected < 0) return;
  state.boxes.splice(state.selected, 1);
  state.selected = -1;
  renderBoxes();
});
$('box-redetect').addEventListener('click', redetect);

// ---------- 单框裁剪（预览 + 保存）----------
let lastCrop = null;
function hideCropPreview() { $('crop-preview').classList.add('hidden'); lastCrop = null; }

async function cropPreview() {
  const b = state.boxes[state.selected];
  if (!b || !state.currentFile) return;
  $('hint').textContent = '裁剪中…';
  try {
    const r = await api('/api/crop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentFile.path, box: b, presetId: state.presetId }),
    });
    $('crop-preview').classList.remove('hidden');
    $('crop-img').src = r.preview;
    $('crop-info').textContent = `输出 ${r.width}×${r.height}px（固定分辨率，长边按方案）`;
    lastCrop = { box: b };
    $('hint').textContent = '';
  } catch (e) { $('hint').textContent = '✗ ' + e.message; }
}
async function cropSave() {
  if (!lastCrop) return;
  const outDir = $('opt-outdir').value.trim() || (state.scanDir ? state.scanDir.replace(/[\\/]+$/, '') + '/filmcut' : '');
  if (!outDir) { $('hint').textContent = '先填输出目录'; return; }
  const stem = state.currentFile.path.match(/([^\\/]+)\.[^.]+$/) ? state.currentFile.path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'scan';
  try {
    const r = await api('/api/crop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentFile.path, box: lastCrop.box, presetId: state.presetId, save: true, outDir, name: `${stem}-cut` }),
    });
    $('hint').textContent = `已保存 ✓ ${r.output}`;
  } catch (e) { $('hint').textContent = '✗ ' + e.message; }
}

// ---------- 批量 ----------
const debouncePreview = debounce(cropPreview, 250);

async function runBatch() {
  const p = curPreset();
  if (!p || !state.scanDir) return;
  $('run-batch').disabled = true;
  $('job-log').textContent = '';
  try {
    const { jobId } = await api('/api/process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputDir: state.scanDir, outputDir: $('opt-outdir').value.trim() || null,
        presetId: state.presetId, recursive: $('opt-recursive').checked,
        skipProcessed: $('opt-skipdone').checked,
      }),
    });
    pollJob(jobId);
  } catch (e) {
    $('job-summary').textContent = '✗ ' + e.message;
    $('run-batch').disabled = false;
  }
}

async function pollJob(jobId) {
  try {
    const j = await api('/api/jobs/' + jobId);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    $('bar').style.width = pct + '%';
    $('job-summary').textContent = j.status === 'running'
      ? `处理中 ${j.done}/${j.total}（裁出 ${j.crops} 张，失败 ${j.failed}）`
      : j.status === 'done'
        ? `完成：${j.total} 个扫描件 → ${j.crops} 张裁剪成品，失败 ${j.failed}。输出目录：${j.outputDir}`
        : '✗ ' + j.error;
    const lines = (j.results || []).slice(-100).map((r) => r.skipped
      ? `<div class="ok">↷ ${esc(r.name)} 已处理过</div>`
      : r.ok
        ? `<div class="ok">✓ ${esc(r.name)}</div>`
        : `<div class="fail">✗ ${esc(r.name)}：${esc(r.error || '')}</div>`);
    $('job-log').innerHTML = lines.join('');
    if (j.status === 'running') setTimeout(() => pollJob(jobId), 700);
    else $('run-batch').disabled = false;
  } catch (e) {
    $('job-summary').textContent = '✗ ' + e.message;
    $('run-batch').disabled = false;
  }
}

// ---------- 初始化 ----------
function init() {
  $('preset-select').addEventListener('change', (e) => {
    state.presetId = e.target.value || null;
    renderPresets();
    if (state.currentFile) redetect();
  });
  $('preset-new').addEventListener('click', () => openEditor(null));
  $('preset-edit').addEventListener('click', () => openEditor(curPreset()));
  $('preset-cancel').addEventListener('click', closeEditor);
  $('preset-save').addEventListener('click', savePreset);
  $('preset-del').addEventListener('click', delPreset);

  $('dir-browse').addEventListener('click', () => browse($('scan-dir').value.trim()));
  $('scan-dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') browse($('scan-dir').value.trim()); });

  $('box-crop').addEventListener('click', cropPreview);
  $('crop-save').addEventListener('click', cropSave);
  $('run-batch').addEventListener('click', runBatch);

  loadPresets();
  api('/api/health').then(() => { $('app-ver').textContent += ' · 已就绪'; }).catch(() => {});
}
init();

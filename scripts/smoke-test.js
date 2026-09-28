'use strict';
/**
 * FilmCut 冒烟测试：合成扫描件检测/摆正/固定分辨率 + 方案存储 + HTTP 接口。
 * 运行：node scripts/smoke-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const sharp = require('sharp');

const { detectPrints } = require('../src/core/detect');
const { cropPrint } = require('../src/core/crop');
const { PresetStore } = require('../src/presets');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'filmcut-test-'));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, e) => { fail++; console.error(`  ✗ ${n}: ${e.message}`); };
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }

/** 在白底上画倾斜的「相纸」（一个或多个矩形，各自旋转） */
function drawTiltedRect(W, H, rects, rotDegOrList) {
  const list = Array.isArray(rotDegOrList)
    ? rects.map((r, i) => ({ ...r, rot: rotDegOrList[i] }))
    : [{ ...rects, rot: rotDegOrList }];
  const buf = Buffer.alloc(W * H * 3, 255);
  for (const rect of list) {
    const rad = rect.rot * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // 把采样点绕矩形中心反转回去，落在轴对齐矩形内即涂黑
        const dx = x - rect.cx, dy = y - rect.cy;
        const rx = c * dx + s * dy;
        const ry = -s * dx + c * dy;
        if (Math.abs(rx) <= rect.w / 2 && Math.abs(ry) <= rect.h / 2) {
          const i = (y * W + x) * 3;
          buf[i] = 40; buf[i + 1] = 44; buf[i + 2] = 52;
        }
      }
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function main() {
  console.log('[1] 检测 / 摆正 / 固定分辨率');

  await t('单张相纸：检测出倾斜角并摆正裁剪到固定分辨率', async () => {
    const png = await drawTiltedRect(1200, 900, { cx: 600, cy: 450, w: 320, h: 430 }, 12);
    const det = await detectPrints(png, {});
    assert.strictEqual(det.boxes.length, 1, `应检出 1 张，实际 ${det.boxes.length}`);
    const b = det.boxes[0];
    assert.ok(Math.abs(Math.abs(b.angle) - 12) < 1.5, `倾斜角应约 12°，实际 ${b.angle}`);
    assert.ok(Math.abs(b.w - 320) < 8 && Math.abs(b.h - 430) < 8, `尺寸应约 320×430，实际 ${Math.round(b.w)}×${Math.round(b.h)}`);
    const r = await cropPrint(png, b, { outLong: 800, expandPct: 3 });
    // 竖版相纸长边是高：固定分辨率约束的是长边
    assert.strictEqual(Math.max(r.width, r.height), 800, `长边应 800，实际 ${r.width}×${r.height}`);
    assert.ok(Math.abs(r.width - 800 * 320 / 430) <= 2, `短边应约 ${Math.round(800 * 320 / 430)}，实际 ${r.width}`);
    // 摆正后：中心是相纸（暗），四角是白纸
    const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data[(y * info.width + x) * info.channels];
    assert.ok(px(400, Math.round(info.height / 2)) < 120, '中心应为相纸（暗）');
    assert.ok(px(4, 4) > 200 && px(info.width - 5, 4) > 200, '四角应为白底');
  });

  await t('一纸多张：白底上两张相纸分别检出', async () => {
    const png = await drawTiltedRect(1200, 1600,
      [{ cx: 600, cy: 400, w: 300, h: 400 }, { cx: 600, cy: 1150, w: 340, h: 300 }],
      [-7, 4]);
    const det = await detectPrints(png, {});
    assert.strictEqual(det.boxes.length, 2, `应检出 2 张，实际 ${det.boxes.length}（角度 ${det.boxes.map((b) => b.angle).join(',')}）`);
  });

  await t('不带角度的框：cropPrint 原样按框取图', async () => {
    const png = await drawTiltedRect(1000, 800, { cx: 500, cy: 400, w: 250, h: 350 }, 0);
    const r = await cropPrint(png, { cx: 500, cy: 400, w: 250, h: 350, angle: 0 }, { outLong: 500, expandPct: 0 });
    assert.strictEqual(Math.max(r.width, r.height), 500);
    assert.ok(Math.abs(r.width - 500 * 250 / 350) <= 1);
  });

  await t('留白越界补白：相纸贴扫描边时四边留白仍均匀', async () => {
    // 相纸中心贴近扫描图右边界，外扩窗口越界 → 右侧必须补白而不是被截断
    const png = await drawTiltedRect(1000, 800, { cx: 900, cy: 90, w: 200, h: 140 }, 0);
    const r = await cropPrint(png, { cx: 900, cy: 90, w: 200, h: 140, angle: 0 }, { outLong: 1000, expandPct: 10 });
    assert.strictEqual(Math.max(r.width, r.height), 1000);
    const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data[(y * info.width + x) * info.channels];
    assert.ok(px(info.width - 5, Math.round(info.height / 2)) > 200, '右缘应为补白（截断实现这里会是相纸）');
    assert.ok(px(Math.round(info.width / 2), Math.round(info.height / 2)) < 120, '中心应为相纸');
  });

  await t('两步模型：选区比例 ≠ 方案比例时，输出归一到方案画幅（留白补齐）', async () => {
    // 横版选区（2:1）配竖版方案（54:86）：输出必须是 54:86 画幅、相纸居中、上下大量留白
    const png = await drawTiltedRect(1200, 700, { cx: 600, cy: 350, w: 400, h: 200 }, 0);
    const r = await cropPrint(png, { cx: 600, cy: 350, w: 400, h: 200, angle: 0 },
      { outLong: 1600, expandPct: 0, ratio: [54, 86] });
    assert.strictEqual(r.width, Math.round(1600 * 54 / 86));
    assert.strictEqual(r.height, 1600);
    const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data[(y * info.width + x) * info.channels];
    // 画幅上部（相纸之外）应为留白；中线应为相纸
    assert.ok(px(Math.round(info.width / 2), 8) > 200, '画幅顶部应为留白');
    assert.ok(px(Math.round(info.width / 2), Math.round(info.height / 2)) < 120, '中线应为相纸');
  });

  console.log('[2] 相纸方案存储');
  await t('内置方案播种 + 新增/编辑/删除持久化', async () => {
    const file = path.join(TMP, 'presets.json');
    const s1 = new PresetStore(file);
    assert.ok(s1.list().length >= 9, `内置方案应 ≥9，实际 ${s1.list().length}`);
    assert.ok(s1.getByName('Instax Mini · 整张相纸'), '内置 Instax Mini 应存在');
    const p = s1.upsert({ name: '我的宝丽来', ratio: [88, 107], outLong: 1800, tolerance: 30 });
    assert.ok(p && p.id, '应能新增方案');
    const s2 = new PresetStore(file);
    assert.ok(s2.getByName('我的宝丽来'), '重启（重新加载）后方案仍在');
    const edited = s2.upsert({ name: '我的宝丽来 v2', ratio: [88, 107] }, p.id);
    assert.strictEqual(edited.name, '我的宝丽来 v2', '应能按 id 编辑');
    assert.ok(s2.remove(p.id), '应能删除');
    assert.ok(!s2.get(p.id), '删除后取不到');
  });

  console.log('[3] HTTP 接口');
  await t('health / presets / detect / crop / browse 全链路', async () => {
    process.env.FILMCUT_DATA_DIR = path.join(TMP, 'data');
    const { start } = require('../src/server');
    const srv = await start({ port: 0, host: '127.0.0.1' });
    const port = srv.address().port;
    const j = async (p, opts) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, opts);
      const body = await res.json().catch(() => ({}));
      assert.ok(res.ok, `${p} → ${res.status} ${body.error || ''}`);
      return body;
    };
    const health = await j('/api/health');
    assert.strictEqual(health.app, 'filmcut');
    const presets = await j('/api/presets');
    assert.ok(presets.length >= 9);

    const scanPath = path.join(TMP, 'scan.png');
    fs.writeFileSync(scanPath, await drawTiltedRect(1200, 900, { cx: 600, cy: 450, w: 320, h: 430 }, 9));
    const det = await j('/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: scanPath, presetId: presets[0].id }) });
    assert.strictEqual(det.boxes.length, 1);

    const saved = await j('/api/crop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: scanPath, box: det.boxes[0], presetId: presets[0].id, save: true }),
    });
    assert.ok(fs.existsSync(saved.output), `产物应存在：${saved.output}`);
    assert.strictEqual(Math.max(saved.width, saved.height), presets[0].outLong, '固定输出长边');

    const browse = await j('/api/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: TMP }) });
    assert.ok(browse.imageCount >= 1);

    const batch = await j('/api/process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputDir: TMP, outputDir: path.join(TMP, 'out'), presetId: presets[0].id }),
    });
    let job;
    for (let i = 0; i < 60; i++) {
      job = await j('/api/jobs/' + batch.jobId);
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.strictEqual(job.status, 'done', `批量应完成：${job.error || ''}`);
    assert.ok(job.crops >= 1, `批量应裁出 ≥1 张，实际 ${job.crops}`);
    srv.close();
  });

  console.log(`\n结果：${pass} 通过，${fail} 失败  （fixtures 在 ${TMP}）`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

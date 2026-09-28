'use strict';
/**
 * 按检测框摆正 + 裁剪 + 固定分辨率输出。
 *
 * sharp 管线固定顺序里 rotate 在 extract 之前，所以 rotate(angleDeg) 之后
 * extract 的坐标就在「旋转后画布」上：画布已扩到旋转包围盒，原图中心仍是画布中心，
 * 检测框中心按同一旋转变换映射过去，再从新画布上抠出 (w×h)。
 * 最后等比缩放到方案设定的固定输出长边（扫描件通常大于输出，缩小为主）。
 */
const sharp = require('sharp');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif']);

/**
 * @param {Buffer} buffer 扫描图
 * @param {{cx,cy,w,h,angle}} box 检测/手调后的框（原图像素坐标，angle 为度）
 * @param {object} o expandPct: 外扩百分比（补白边余量，默认 1）
 *   outLong: 输出长边像素（固定分辨率，默认 1600）
 *   format: 'jpeg'|'png'，quality
 * @returns {{buffer, ext, width, height}}
 */
async function cropPrint(buffer, box, o = {}) {
  const expandPct = Math.max(0, Math.min(20, o.expandPct ?? 1));
  const outLong = Math.max(64, Math.min(8000, Math.round(o.outLong ?? 1600)));
  const format = o.format === 'png' ? 'png' : 'jpeg';
  const quality = Math.max(50, Math.min(100, Math.round(o.quality ?? 92)));

  const meta = await sharp(buffer).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error('无法读取图片尺寸');

  // 摆正角 = 相纸倾斜角的反向；sharp 正角为顺时针
  const angleDeg = -(box.angle || 0);
  const theta = angleDeg * Math.PI / 180;
  const c = Math.cos(theta), s = Math.sin(theta);

  // 旋转后画布尺寸（非 90° 倍数时 sharp 自动扩大画布）
  const radA = Math.abs(theta);
  const W2 = Math.round(W * Math.cos(radA) + H * Math.sin(radA));
  const H2 = Math.round(W * Math.sin(radA) + H * Math.cos(radA));

  // 框中心绕原图中心旋转到新画布坐标（y 向下，[[c,-s],[s,c]] 为顺时针）
  const rx = c * (box.cx - W / 2) - s * (box.cy - H / 2);
  const ry = s * (box.cx - W / 2) + c * (box.cy - H / 2);
  const cx2 = W2 / 2 + rx, cy2 = H2 / 2 + ry;

  const pad = 1 + expandPct / 100;
  const cw = Math.max(8, Math.round(box.w * pad));
  const ch = Math.max(8, Math.round(box.h * pad));
  const left = Math.max(0, Math.min(W2 - cw, Math.round(cx2 - cw / 2)));
  const top = Math.max(0, Math.min(H2 - ch, Math.round(cy2 - ch / 2)));

  // 固定分辨率：长边 = outLong，等比（fit:fill 保持框比例，不被裁）
  const scale = outLong / Math.max(cw, ch);
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));

  const pipe = sharp(buffer)
    .rotate(angleDeg, { background: { r: 255, g: 255, b: 255 } })
    .extract({ left, top, width: cw, height: ch })
    .resize(outW, outH, { fit: 'fill' });
  const out = format === 'png'
    ? await pipe.png().toBuffer()
    : await pipe.jpeg({ quality }).toBuffer();
  return { buffer: out, ext: format === 'png' ? '.png' : '.jpg', width: outW, height: outH };
}

module.exports = { cropPrint, IMAGE_EXTS };

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
 * @param {{cx,cy,w,h,angle,rot?}} box 检测/手调后的框（原图像素坐标，angle 为度；
 *   rot 为输出内容的旋转角 0/90/180/270 —— 扫描时倒放/横放的相纸转正）
 * @param {object} o expandPct: 第一步留白 %（选区四周外扩，越界补白，默认 1）
 *   ratio: [宽,高] 方案输出画幅 —— 第二步把裁剪结果 contain 进该比例白底画幅（长边=outLong）
 *   outLong: 输出长边像素（固定分辨率，默认 1600）
 *   rotate: 整批统一输出旋转（0/90/180/270，优先于 box.rot）
 *   format: 'jpeg'|'png'，quality
 * @returns {{buffer, ext, width, height}}
 */
async function cropPrint(buffer, box, o = {}) {
  const expandPct = Math.max(0, Math.min(20, o.expandPct ?? 1));
  const outLong = Math.max(64, Math.min(8000, Math.round(o.outLong ?? 1600)));
  const format = o.format === 'png' ? 'png' : 'jpeg';
  const quality = Math.max(50, Math.min(100, Math.round(o.quality ?? 92)));
  // 内容旋转：批量走 o.rotate，单张走框上的 rot；归一到 0/90/180/270
  let rot90 = Math.round(o.rotate ?? box.rot ?? 0) % 360;
  if (rot90 < 0) rot90 += 360;
  rot90 = Math.round(rot90 / 90) * 90;

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
  // 留白窗口以框为中心、不 clamp：越出扫描边界的部分用白底补齐，四边留白始终均匀
  const left = Math.round(cx2 - cw / 2);
  const top = Math.round(cy2 - ch / 2);
  const visL = Math.max(0, left), visT = Math.max(0, top);
  const visR = Math.min(W2, left + cw), visB = Math.min(H2, top + ch);
  if (visR - visL < 8 || visB - visT < 8) throw new Error('裁剪窗口完全超出扫描图');

  // 只对扫描图内的可见部分做旋转+抠图（无损中转，尺寸=裁剪区域）
  const cropArea = await sharp(buffer)
    .rotate(angleDeg, { background: { r: 255, g: 255, b: 255 } })
    .extract({ left: visL, top: visT, width: visR - visL, height: visB - visT })
    .png().toBuffer();
  // 越界部分补白
  const padL = visL - left, padT = visT - top;
  const padR = (left + cw) - visR, padB = (top + ch) - visB;
  let windowed = sharp(cropArea);
  if (padL > 0 || padT > 0 || padR > 0 || padB > 0) {
    windowed = windowed.extend({
      left: padL, top: padT, right: padR, bottom: padB,
      background: { r: 255, g: 255, b: 255 },
    });
  }

  // ---- 第二步：输出归一 ----
  // 给了方案比例（o.ratio=[宽,高]）→ 输出画幅固定为该比例：裁剪结果 contain 居中放到
  // 白色画幅上，缺的部分留白 —— 选区比例与输出比例没有必然联系，选区只负责「剪出来」。
  // 没给比例 → 输出保持选区比例，长边 = outLong。
  let outW, outH, pipe;
  if (Array.isArray(o.ratio) && o.ratio.length === 2 && o.ratio[0] > 0 && o.ratio[1] > 0) {
    const [rw, rh] = o.ratio;
    const canvasW = rw >= rh ? outLong : Math.round(outLong * rw / rh);
    const canvasH = rw >= rh ? Math.round(outLong * rh / rw) : outLong;
    // 裁剪结果 contain 装进画幅，gravity 居中贴到白底画幅上（png 中转无损）
    const innerBuf = await windowed.resize(canvasW, canvasH, { fit: 'inside' }).png().toBuffer();
    outW = canvasW; outH = canvasH;
    pipe = sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: innerBuf, gravity: 'centre' }]);
  } else {
    const scale = outLong / Math.max(cw, ch);
    outW = Math.max(1, Math.round(cw * scale));
    outH = Math.max(1, Math.round(ch * scale));
    pipe = windowed.resize(outW, outH, { fit: 'fill' });
  }

  if (!rot90) {
    const out = format === 'png' ? await pipe.png().toBuffer() : await pipe.jpeg({ quality }).toBuffer();
    return { buffer: out, ext: format === 'png' ? '.png' : '.jpg', width: outW, height: outH };
  }
  // 90° 倍数的输出旋转：管线里 rotate 只能调用一次，先 raw 再转（仍然只编码一次）
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  const rotated = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .rotate(rot90);
  const out = format === 'png' ? await rotated.png().toBuffer() : await rotated.jpeg({ quality }).toBuffer();
  const finalMeta = await sharp(out).metadata();
  return { buffer: out, ext: format === 'png' ? '.png' : '.jpg', width: finalMeta.width, height: finalMeta.height };
}

module.exports = { cropPrint, IMAGE_EXTS };

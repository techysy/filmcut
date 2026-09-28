'use strict';
/**
 * 白底扫描件上的相纸检测引擎。
 *
 * 扫描仪出来的「白纸 + 相纸」图：相纸（拍立得/宝丽来/胶片）是白底上的非白区域，
 * 检测 = 找出这些区域的外接矩形和倾斜角。
 *
 *  1. sharp 降采样到工作分辨率（长边 WORK_MAX）灰度 raw —— 只看结构不看原分辨率；
 *  2. 阈值二值化：灰度 < 255 - tolerance 视为内容（tolerance 抵抗扫描灰底/阴影）；
 *  3. 四邻接连通域（BFS）→ 按面积占比、长宽比过滤掉字迹/阴影/噪点；
 *  4. 每个域取样点集 → 凸包（Andrew 单调链）→ 旋转卡壳最小面积外接矩形，
 *     得到 {cx, cy, w, h, angle}，angle 即相纸倾斜角 —— 自动摆正的依据；
 *  5. 坐标按缩放比例映射回原图。
 */
const sharp = require('sharp');

const WORK_MAX = 900;  // 检测用工作分辨率（长边）
const POINT_STEP = 3;  // 点集取样步长（工作分辨率像素；凸包不需要全部点）

/** Andrew 单调链凸包。返回按序排列的凸包顶点（y 向下坐标系，方向性不影响最小矩形） */
function convexHull(points) {
  if (points.length < 4) return points.slice();
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list) => {
    const st = [];
    for (const p of list) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], p) <= 0) st.pop();
      st.push(p);
    }
    return st;
  };
  const lower = half(pts);
  const upper = half(pts.slice().reverse());
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 旋转卡壳：凸包每条边上贴一个矩形，取面积最小者。
 *  返回 {cx, cy, w, h, angleDeg}，angle 已归一到 (-45°, 45°]，w 沿 angle 方向。 */
function minAreaRect(hull) {
  if (!hull.length) return null;
  if (hull.length === 1) return { cx: hull[0].x, cy: hull[0].y, w: 1, h: 1, angleDeg: 0 };
  let best = null;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const p1 = hull[i], p2 = hull[(i + 1) % n];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;            // 边方向单位向量
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;              // 法向分量
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (best && area >= best.area) continue;
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    best = {
      area, w: maxU - minU, h: maxV - minV,
      cx: cu * ux - cv * uy,                       // 逆变换（R 的转置）
      cy: cu * uy + cv * ux,
      angleRad: Math.atan2(uy, ux),
    };
  }
  if (!best) return null;
  let a = best.angleRad;
  // 边方向无向：归一到 (-π/2, π/2]
  if (a > Math.PI / 2) a -= Math.PI;
  if (a <= -Math.PI / 2) a += Math.PI;
  let { w, h } = best;
  // 统一到 (-π/4, π/4]：超出就换长边方向为基准，宽高互换
  if (Math.abs(a) > Math.PI / 4) {
    a += a > 0 ? -Math.PI / 2 : Math.PI / 2;
    const t = w; w = h; h = t;
  }
  return { cx: best.cx, cy: best.cy, w, h, angleDeg: a * 180 / Math.PI };
}

/**
 * 检测一张扫描件上的所有相纸。
 * @param {Buffer} buffer 扫描图
 * @param {object} o tolerance: 白底容差（1-128，默认 28）
 *   minAreaPct: 域最小面积占比（0-1，默认 0.004，过滤字迹/噪点）
 *   ratio: [宽,高] 相纸方案的框选比例 —— 给了就按比例亲和过滤（允许横竖互换），
 *          相纸边上的手写字条、被字迹撑变形的框会被淘汰
 *   ratioTolerance: 比例亲和容差（默认 1.45，即 ±45%）
 *   maxBoxes: 最多返回几个框
 * @returns {{width, height, boxes: Array<{cx,cy,w,h,angle,areaPct}>}} 原图像素坐标
 */
async function detectPrints(buffer, o = {}) {
  const tolerance = Math.max(1, Math.min(128, o.tolerance ?? 28));
  const minAreaPct = Math.max(0.0005, Math.min(0.5, o.minAreaPct ?? 0.004));
  const maxBoxes = Math.max(1, Math.min(36, o.maxBoxes ?? 12));
  const ratioTol = Math.max(1, Math.min(3, o.ratioTolerance ?? 1.45));
  const ratio = Array.isArray(o.ratio) && o.ratio.length === 2 && o.ratio[0] > 0 && o.ratio[1] > 0
    ? Math.min(o.ratio[0], o.ratio[1]) / Math.max(o.ratio[0], o.ratio[1]) // 归一到短/长 ≤1，横竖互换都算
    : null;

  const meta = await sharp(buffer).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error('无法读取图片尺寸');
  const scale = Math.min(1, WORK_MAX / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const { data } = await sharp(buffer).resize(w, h, { fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = 255 - tolerance;
  const total = w * h;
  const isContent = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (data[i] < threshold) isContent[i] = 1;

  const label = new Int32Array(total);
  const queue = new Int32Array(total);
  const boxes = [];
  let labelId = 0;
  for (let start = 0; start < total; start++) {
    if (!isContent[start] || label[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = ++labelId;
    const pts = [];
    let area = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (((x + y) % POINT_STEP) === 0) pts.push({ x, y });
      if (x > 0 && isContent[p - 1] && !label[p - 1]) { label[p - 1] = labelId; queue[tail++] = p - 1; }
      if (x < w - 1 && isContent[p + 1] && !label[p + 1]) { label[p + 1] = labelId; queue[tail++] = p + 1; }
      if (y > 0 && isContent[p - w] && !label[p - w]) { label[p - w] = labelId; queue[tail++] = p - w; }
      if (y < h - 1 && isContent[p + w] && !label[p + w]) { label[p + w] = labelId; queue[tail++] = p + w; }
    }
    const areaPct = area / total;
    if (areaPct > 0.92) continue;                        // 整图几乎都是内容：背景不是白的，检测无意义
    if (areaPct < minAreaPct) continue;                  // 字迹/噪点/碎屑
    const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
    if (area / bboxArea < 0.35) continue;                // 细长/散碎（阴影带、文字行）不像一张相纸
    const rect = minAreaRect(convexHull(pts));
    if (!rect || rect.w < 24 || rect.h < 24) continue;   // 工作分辨率下太小的域
    if (ratio) {
      // 比例亲和：框的短长边比应接近方案比例（±容差），否则多半是字条/阴影/并框
      const boxRatio = Math.min(rect.w, rect.h) / Math.max(rect.w, rect.h);
      if (boxRatio < ratio / ratioTol || boxRatio > ratio * ratioTol) continue;
    }
    boxes.push({
      cx: rect.cx / scale, cy: rect.cy / scale,
      w: rect.w / scale, h: rect.h / scale,
      angle: Math.round(rect.angleDeg * 100) / 100,
      areaPct: Math.round(areaPct * 10000) / 10000,
    });
  }
  boxes.sort((a, b) => b.areaPct - a.areaPct);
  return { width: W, height: H, boxes: boxes.slice(0, maxBoxes) };
}

module.exports = { detectPrints, convexHull, minAreaRect, WORK_MAX };

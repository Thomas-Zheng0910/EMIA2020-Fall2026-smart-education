import { getStroke } from 'perfect-freehand';
import type { Stroke } from './types';

export const PAGE_WIDTH = 1000;

export function strokeOutline(stroke: Stroke): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i + 1 < stroke.points.length; i += 3)
    pts.push([stroke.points[i]!, stroke.points[i + 1]!, stroke.points[i + 2] ?? 0.5]);
  const highlighter = stroke.tool === 'highlighter';
  return getStroke(pts, {
    size: stroke.size,
    thinning: highlighter ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !highlighter && pts.every((p) => p[2] === 0.5),
    last: true,
    start: { cap: !highlighter },
    end: { cap: !highlighter },
  });
}

export function outlineToPath(outline: number[][]): string {
  if (!outline.length) return '';
  const d = outline.reduce(
    (acc: (string | number)[], [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(x0!.toFixed(2), y0!.toFixed(2), ((x0! + x1!) / 2).toFixed(2), ((y0! + y1!) / 2).toFixed(2));
      return acc;
    },
    ['M', ...outline[0]!.map((n) => n.toFixed(2)), 'Q'],
  );
  return d.join(' ') + ' Z';
}

export const strokePath = (s: Stroke) => outlineToPath(strokeOutline(s));
export const strokeOpacity = (s: Stroke) => (s.tool === 'highlighter' ? 0.35 : 1);

export function strokeBounds(s: Stroke): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < s.points.length; i += 3) {
    x0 = Math.min(x0, s.points[i]!);
    y0 = Math.min(y0, s.points[i + 1]!);
    x1 = Math.max(x1, s.points[i]!);
    y1 = Math.max(y1, s.points[i + 1]!);
  }
  const r = s.size / 2;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

export function pointInPolygon(x: number, y: number, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** True when at least half of a stroke's points fall inside the lasso polygon. */
export function strokeInLasso(s: Stroke, poly: number[][]) {
  let n = 0,
    hit = 0;
  for (let i = 0; i < s.points.length; i += 3) {
    n++;
    if (pointInPolygon(s.points[i]!, s.points[i + 1]!, poly)) hit++;
  }
  return n > 0 && hit / n >= 0.5;
}

export function strokeNear(s: Stroke, x: number, y: number, radius: number) {
  const r2 = (radius + s.size / 2) ** 2;
  for (let i = 0; i < s.points.length; i += 3) {
    const dx = s.points[i]! - x,
      dy = s.points[i + 1]! - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  // segment check for fast strokes
  for (let i = 3; i < s.points.length; i += 3) {
    const ax = s.points[i - 3]!,
      ay = s.points[i - 2]!,
      bx = s.points[i]!,
      by = s.points[i + 1]!;
    const dx = bx - ax,
      dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
    const px = ax + t * dx - x,
      py = ay + t * dy - y;
    if (px * px + py * py <= r2) return true;
  }
  return false;
}

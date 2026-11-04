import { describe, it, expect } from 'vitest';
import { strokeInLasso, strokeNear, strokePath, pointInPolygon } from '../shared/ink';
import { renderMd } from '../src/Md';
import { restatesSlide } from '../server/jobs';
import type { Stroke } from '../shared/types';

const stroke = (pts: number[][]): Stroke => ({ id: 's', tool: 'pen', color: '#000', size: 4, points: pts.flatMap(([x, y]) => [x!, y!, 0.5]) });

describe('ink geometry', () => {
  it('renders a closed SVG path for a stroke', () => {
    const d = strokePath(stroke([[0, 0], [10, 10], [20, 5]]));
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });
  it('selects strokes mostly inside a lasso', () => {
    const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(strokeInLasso(stroke([[10, 10], [50, 50], [90, 90]]), square)).toBe(true);
    expect(strokeInLasso(stroke([[90, 90], [150, 150], [200, 200]]), square)).toBe(false);
  });
  it('erases strokes crossed between sampled points', () => {
    const s = stroke([[0, 0], [100, 0]]);
    expect(strokeNear(s, 50, 3, 2)).toBe(true);
    expect(strokeNear(s, 50, 30, 2)).toBe(false);
  });
});

describe('markdown rendering', () => {
  it('renders LaTeX and neutralizes HTML and links', () => {
    const html = renderMd('Bayes: $P(A|B)$ <img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).toContain('katex');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
  });
});

describe('peer note value', () => {
  const slide = 'P(B): Prior probability (How likely belief is on its own)\nE: Evidence (also called Feature)\nB: Belief (also called Class)';
  it('keeps notes that add something beyond the slide', () => {
    expect(restatesSlide('Prior is what you believe before seeing evidence; with no smoke we still expect fires 1% of days.', slide)).toBe(false);
  });
  it('drops notes that only repeat the slide', () => {
    expect(restatesSlide('Prior probability $P(B)$: how likely the belief is on its own.', slide)).toBe(true);
    expect(restatesSlide('E stands for evidence, also known as a feature; B stands for belief, also known as a class.', slide)).toBe(true);
  });
});

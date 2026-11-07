import type { PaperKind } from '../shared/types';

/**
 * Paper a notebook is written on. The choice decides the rule spacing typed text sits on, so it is
 * described here once and read by the creation dialog, the editor and the page thumbnail alike.
 */
export type Paper = {
  kind: PaperKind;
  name: string;
  /** What this paper is for, in the student's words. */
  use: string;
  /** Sheet size in page units (page width is 1000). */
  width: number;
  height: number;
  /** Spacing between rules, or null when the paper has no ruling. */
  rule: number | null;
  /** Where the writing column starts, so typed text and quoted notes line up with handwriting. */
  left: number;
  right: number;
};

export const PAPERS: Paper[] = [
  { kind: 'ruled', name: 'Lined', use: 'Handwriting in straight lines', width: 1000, height: 1414, rule: 36, left: 90, right: 40 },
  { kind: 'grid', name: 'Grid', use: 'Equations, matrices, diagrams', width: 1000, height: 1414, rule: 30, left: 30, right: 30 },
  { kind: 'blank', name: 'Plain', use: 'Typing, pasting, sketching freely', width: 1000, height: 1414, rule: null, left: 70, right: 50 },
];

const BY_KIND = new Map(PAPERS.map((p) => [p.kind, p]));

/** A page's paper: slide and PDF pages keep their own image, so they fall back to the plain sheet's geometry. */
export const paperFor = (kind: string): Paper => BY_KIND.get(kind as PaperKind) ?? PAPERS[2]!;
export const paperName = (kind: string) => paperFor(kind).name;

/** Where the writing column sits on a page of this width, and where its rules fall. */
export function writingColumn(width: number, height: number, kind: string) {
  const p = paperFor(kind);
  // A page keeps its own paper's margins; slide and PDF pages are drawn edge to edge.
  const isSheet = kind === 'ruled' || kind === 'grid' || kind === 'blank';
  const left = isSheet ? p.left : Math.round(width * 0.08);
  const right = isSheet ? width - p.right : Math.round(width * 0.92);
  return {
    left,
    right: Math.max(left + 120, right),
    rule: isSheet ? p.rule : null,
    // Ruled paper starts below a title band; an unruled sheet writes from near the top.
    top: kind === 'grid' ? 60 : p.rule ? 120 : 90,
    height,
  };
}

/** The rule line nearest to y, so a new text box lands on the paper instead of across it. */
export function snapToRule(y: number, kind: string, width: number) {
  const col = writingColumn(width, 0, kind);
  if (!col.rule) return Math.max(col.top, Math.round(y));
  const n = Math.round((Math.max(col.top, y) - col.top) / col.rule);
  return col.top + n * col.rule;
}

/** Memos are paper, not UI: four warm tints, and a default size that reads as a stuck-on note. */
export const MEMO_TINTS = ['yellow', 'pink', 'blue', 'green'] as const;
export const MEMO_WIDTH = 190;

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { Citation, Item, MemoTint, Stroke } from '../../shared/types';
import { strokeBounds, strokeInLasso, strokeNear, strokeOpacity, strokePath, pointInPolygon } from '../../shared/ink';
import { uid } from '../api';
import { Md } from '../Md';
import { MEMO_TINTS, MEMO_WIDTH, snapToRule, writingColumn } from '../paper';
import type { EditorPage, Selection, ToolState } from './types';

const pathCache = new WeakMap<Stroke, string>();
const pathOf = (s: Stroke) => {
  let d = pathCache.get(s);
  if (d === undefined) pathCache.set(s, (d = strokePath(s)));
  return d;
};

export const StrokeLayer = memo(function StrokeLayer({ strokes, hidden }: { strokes: Stroke[]; hidden?: Set<string> }) {
  return (
    <>
      {strokes.map((s) =>
        hidden?.has(s.id) ? null : <path key={s.id} className="stroke" d={pathOf(s)} fill={s.color} fillOpacity={strokeOpacity(s)} />,
      )}
    </>
  );
});

export function itemBox(it: Item): [number, number, number, number] {
  if (it.type === 'image') return [it.x, it.y, it.x + it.w, it.y + it.h];
  if (it.type === 'memo') {
    const lines = it.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length * it.size * 0.55) / (it.w - 20))), 0);
    const h = Math.max(64, lines * it.size * 1.35 + 20);
    return [it.x, it.y, it.x + it.w, it.y + (it.collapsed ? 30 : h)];
  }
  if (it.type === 'text') {
    const lh = it.lineHeight ?? it.size * 1.5;
    const lines = it.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length * it.size * 0.52) / it.w)), 0);
    return [it.x, it.y, it.x + it.w, it.y + Math.max(1, lines) * lh + 8];
  }
  // An annotation's height follows its text, citations and credit line, so placing one uses the
  // space it really takes rather than a guess that lets a long quote run off the sheet.
  const chars = Math.max(12, Math.floor(it.w / 7.4));
  const lines = Math.ceil(it.body.replace(/\n/g, '').length / chars) + Math.max(0, it.body.split('\n').length - 1);
  if (it.collapsed) return [it.x, it.y, it.x + it.w, it.y + 36];
  const height = 40 + 22 * Math.max(1, lines) + 24 * Math.min(2, it.citations.length) + 34;
  return [it.x, it.y, it.x + it.w, it.y + height];
}

export function selectionBox(strokes: Stroke[], items: Item[], sel: { strokeIds: Set<string>; itemIds: Set<string> }) {
  let b: [number, number, number, number] | null = null;
  const add = (r: [number, number, number, number]) => {
    b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r;
  };
  for (const s of strokes) if (sel.strokeIds.has(s.id)) add(strokeBounds(s));
  for (const it of items) if (sel.itemIds.has(it.id)) add(itemBox(it));
  return b as [number, number, number, number] | null;
}

type DragItemPosition = { id: string; x: number; y: number };
type TextItem = Extract<Item, { type: 'text' }>;

type Props = {
  page: EditorPage;
  scale: number;
  tool: ToolState;
  selection: Selection | null;
  editingText: string | null;
  setEditingText: Dispatch<SetStateAction<string | null>>;
  setSelection: (s: Selection | null) => void;
  commit: (pageId: string, strokes: Stroke[], items: Item[]) => void;
  onCreateText: (item: TextItem) => void;
  onDraftItem: (itemId: string, text: string) => void;
  onSelectionAction: (action: 'ask' | 'delete') => void;
  onCitation: (c: Citation) => void;
};

export function PageView({ page, scale, tool, selection, editingText, setEditingText, setSelection, commit, onCreateText, onDraftItem, onSelectionAction, onCitation }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const live = useRef<SVGPathElement>(null);
  const lassoPath = useRef<SVGPathElement>(null);
  const gesture = useRef<
    | { kind: 'ink'; stroke: Stroke }
    | { kind: 'erase'; removed: Set<string> }
    | { kind: 'lasso'; poly: number[][] }
    | { kind: 'move'; x: number; y: number; dx: number; dy: number }
    | {
        kind: 'drag-item';
        id: string;
        x: number;
        y: number;
        ox: number;
        oy: number;
        bounds?: { maxX: number; maxY: number };
        position?: DragItemPosition;
      }
    | null
  >(null);
  const [erased, setErased] = useState<Set<string>>(new Set());
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [dragItem, setDragItem] = useState<DragItemPosition | null>(null);
  const [pendingText, setPendingText] = useState<TextItem | null>(null);
  const visibleItems = pendingText?.id === editingText ? [...page.items, pendingText] : page.items;
  const sel = selection?.pageId === page.id ? selection : null;
  const selBox = useMemo(() => (sel ? selectionBox(page.strokes, page.items, sel) : null), [sel, page.strokes, page.items]);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * page.width, ((e.clientY - r.top) / r.height) * page.height] as const;
  };
  const drawingTool = tool.tool === 'pen' || tool.tool === 'highlighter';

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (tool.stylusOnly && e.pointerType === 'touch' && tool.tool !== 'lasso') return; // fingers scroll
    if ((e.target as HTMLElement).closest('[data-interactive]')) return;
    const [x, y] = toPage(e);
    if (tool.tool === 'memo') {
      e.preventDefault();
      // A memo is stuck on the page where the student taps: a small sheet, not a line of text.
      const w = MEMO_WIDTH;
      const col = writingColumn(page.width, page.height, page.kind);
      const left = Math.max(12, Math.min(x - w / 2, page.width - w - 12));
      const top = Math.max(12, Math.min(y - 24, page.height - 120));
      const tints = MEMO_TINTS;
      const it: Item = {
        id: uid(),
        type: 'memo',
        x: Math.round(left),
        y: Math.round(top),
        w,
        text: '',
        color: '#3d3423',
        size: 15,
        // Each new memo takes the next tint, so a page of them reads as a set rather than a rainbow.
        tint: tints[page.items.filter((i) => i.type === 'memo').length % tints.length]!,
      };
      commit(page.id, page.strokes, [...page.items, it]);
      setEditingText(it.id);
      return;
    }
    if (tool.tool === 'text') {
      e.preventDefault(); // keeps focus on the new text box mounted below
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.matches('.text-item.editing')) active.blur();
      // Typed text is written on the paper: it starts inside the writing column and on a rule,
      // and it is exactly as wide as the column, so it reads like a line of writing.
      const col = writingColumn(page.width, page.height, page.kind);
      const lineHeight = col.rule && col.rule >= 22 ? col.rule : 33;
      // Written on a line, not in a box: a hand-sized 19-20px against a 36px rule.
      const size = Math.max(14, Math.min(20, Math.round(lineHeight * 0.54)));
      const onSlide = page.kind === 'slide' || page.kind === 'pdf';
      const slideWidth = Math.min(300, page.width - 32);
      const left = onSlide
        ? Math.max(16, Math.min(x, page.width - slideWidth - 16))
        : Math.max(col.left, Math.min(x, col.right - 160));
      const top = onSlide ? Math.max(0, Math.min(y, page.height - lineHeight)) : snapToRule(y, page.kind, page.width) - lineHeight;
      const it: TextItem = {
        id: uid(),
        type: 'text',
        x: left,
        y: top,
        w: onSlide ? slideWidth : Math.max(160, col.right - left),
        text: '',
        color: tool.color,
        size,
        lineHeight,
      };
      // Keep the placeholder out of the notebook until it contains text.
      setPendingText(it);
      setEditingText(it.id);
      return;
    }
    setEditingText(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (drawingTool) {
      const hl = tool.tool === 'highlighter';
      gesture.current = {
        kind: 'ink',
        stroke: { id: uid(), tool: tool.tool as Stroke['tool'], color: hl ? tool.hlColor : tool.color, size: hl ? tool.hlSize : tool.size, points: [x, y, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5] },
      };
      setSelection(null);
    } else if (tool.tool === 'eraser') {
      gesture.current = { kind: 'erase', removed: new Set() };
      eraseAt(x, y);
    } else if (tool.tool === 'lasso') {
      if (sel && selBox && x >= selBox[0] && x <= selBox[2] && y >= selBox[1] && y <= selBox[3]) {
        gesture.current = { kind: 'move', x, y, dx: 0, dy: 0 };
      } else {
        setSelection(null);
        gesture.current = { kind: 'lasso', poly: [[x, y]] };
      }
    }
    e.preventDefault();
  };

  const eraseAt = (x: number, y: number) => {
    const g = gesture.current;
    if (g?.kind !== 'erase') return;
    let changed = false;
    for (const s of page.strokes) if (!g.removed.has(s.id) && strokeNear(s, x, y, 8 / Math.max(scale, 0.3))) (g.removed.add(s.id), (changed = true));
    if (changed) setErased(new Set(g.removed));
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    if (g.kind === 'ink') {
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const [x, y] = toPage(ev);
        g.stroke.points.push(x, y, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5);
      }
      live.current?.setAttribute('d', strokePath(g.stroke));
    } else if (g.kind === 'erase') {
      for (const ev of events.length ? events : [e.nativeEvent]) eraseAt(...toPage(ev));
    } else if (g.kind === 'lasso') {
      const [x, y] = toPage(e);
      g.poly.push([x, y]);
      lassoPath.current?.setAttribute('d', 'M' + g.poly.map((p) => p.join(',')).join('L'));
    } else if (g.kind === 'move') {
      const [x, y] = toPage(e);
      g.dx = x - g.x;
      g.dy = y - g.y;
      setOffset({ dx: g.dx, dy: g.dy });
    } else if (g.kind === 'drag-item') {
      const [x, y] = toPage(e);
      const dx = x - g.x;
      const dy = y - g.y;
      if (g.bounds && Math.hypot(dx, dy) * scale < 3) {
        g.position = undefined;
      } else {
        const left = g.ox + dx;
        const top = g.oy + dy;
        g.position = {
          id: g.id,
          x: g.bounds ? Math.max(0, Math.min(left, g.bounds.maxX)) : left,
          y: g.bounds ? Math.max(0, Math.min(top, g.bounds.maxY)) : top,
        };
      }
      setDragItem(g.position ?? null);
    }
  };

  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === 'ink') {
      live.current?.setAttribute('d', '');
      if (g.stroke.points.length >= 3) commit(page.id, [...page.strokes, { ...g.stroke, points: g.stroke.points.map((n) => Math.round(n * 100) / 100) }], page.items);
    } else if (g.kind === 'erase') {
      if (g.removed.size) commit(page.id, page.strokes.filter((s) => !g.removed.has(s.id)), page.items);
      setErased(new Set());
    } else if (g.kind === 'lasso') {
      lassoPath.current?.setAttribute('d', '');
      if (g.poly.length < 4) return;
      const strokeIds = new Set(page.strokes.filter((s) => strokeInLasso(s, g.poly)).map((s) => s.id));
      const itemIds = new Set(
        page.items
          .filter((it) => {
            const b = itemBox(it);
            return pointInPolygon((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, g.poly);
          })
          .map((i) => i.id),
      );
      const xs = g.poly.map((p) => p[0]!),
        ys = g.poly.map((p) => p[1]!);
      const area: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      setSelection({ pageId: page.id, strokeIds, itemIds, area });
    } else if (g.kind === 'move') {
      setOffset(null);
      if (!sel || (Math.abs(g.dx) < 1 && Math.abs(g.dy) < 1)) return;
      const strokes = page.strokes.map((s) => (sel.strokeIds.has(s.id) ? { ...s, points: s.points.map((v, i) => (i % 3 === 0 ? v + g.dx : i % 3 === 1 ? v + g.dy : v)) } : s));
      const items = page.items.map((it) => (sel.itemIds.has(it.id) ? { ...it, x: it.x + g.dx, y: it.y + g.dy } : it));
      commit(page.id, strokes, items);
      setSelection({ ...sel, area: [sel.area[0] + g.dx, sel.area[1] + g.dy, sel.area[2] + g.dx, sel.area[3] + g.dy] });
    } else if (g.kind === 'drag-item') {
      setDragItem(null);
      const position = g.position;
      if (position && (position.x !== g.ox || position.y !== g.oy)) {
        commit(page.id, page.strokes, page.items.map((it) => (it.id === position.id ? { ...it, x: position.x, y: position.y } : it)));
      }
    }
  };

  const startItemDrag = (e: React.PointerEvent, it: Item, bounds?: { maxX: number; maxY: number }) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = toPage(e);
    gesture.current = { kind: 'drag-item', id: it.id, x, y, ox: it.x, oy: it.y, bounds };
  };
  const updateItem = (id: string, patch: Partial<Item>, record = true) => {
    if (record) commit(page.id, page.strokes, page.items.map((it) => (it.id === id ? ({ ...it, ...patch } as Item) : it)));
  };
  const removeItem = (id: string) => commit(page.id, page.strokes, page.items.filter((it) => it.id !== id));

  const hidden = useMemo(() => {
    const h = new Set(erased);
    if (offset && sel) sel.strokeIds.forEach((id) => h.add(id));
    return h;
  }, [erased, offset, sel]);
  const moving = offset && sel ? page.strokes.filter((s) => sel.strokeIds.has(s.id)) : [];
  const cursor = { pen: 'crosshair', highlighter: 'crosshair', eraser: 'cell', lasso: 'default', text: 'text', memo: 'copy' }[tool.tool];

  return (
    <div className="page-stage-wrap" style={{ width: page.width * scale, height: page.height * scale }}>
      <div
        ref={stage}
        className={`page-stage paper-${page.kind}`}
        style={{ width: page.width, height: page.height, transform: `scale(${scale})`, cursor, touchAction: tool.stylusOnly ? 'pan-y pinch-zoom' : 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {page.background && <img className="page-bg" src={page.background} alt="" draggable={false} />}
        {page.items.map((it) => {
          if (it.type !== 'image') return null;
          const pos = dragItem?.id === it.id ? dragItem : offset && sel?.itemIds.has(it.id) ? { x: it.x + offset.dx, y: it.y + offset.dy } : it;
          return <img key={it.id} className="page-image" src={`/api/files/${it.fileId}`} style={{ left: pos.x, top: pos.y, width: it.w, height: it.h }} alt="" draggable={false} />;
        })}
        <svg className="ink" viewBox={`0 0 ${page.width} ${page.height}`} width={page.width} height={page.height}>
          {!page.background && <Paper kind={page.kind} w={page.width} h={page.height} />}
          <StrokeLayer strokes={page.strokes} hidden={hidden} />
          {offset && (
            <g transform={`translate(${offset.dx} ${offset.dy})`}>
              <StrokeLayer strokes={moving} />
            </g>
          )}
          <path ref={live} fill={tool.tool === 'highlighter' ? tool.hlColor : tool.color} fillOpacity={tool.tool === 'highlighter' ? 0.35 : 1} />
          <path ref={lassoPath} className="lasso-path" />
          {selBox && (
            <rect
              className="sel-rect"
              x={selBox[0] - 6 + (offset?.dx ?? 0)}
              y={selBox[1] - 6 + (offset?.dy ?? 0)}
              width={selBox[2] - selBox[0] + 12}
              height={selBox[3] - selBox[1] + 12}
            />
          )}
          {sel && !selBox && <rect className="sel-rect" x={sel.area[0]} y={sel.area[1]} width={sel.area[2] - sel.area[0]} height={sel.area[3] - sel.area[1]} />}
        </svg>
        {visibleItems.map((it) => {
          if (it.type === 'image') return null;
          const pos = dragItem?.id === it.id ? dragItem : offset && sel?.itemIds.has(it.id) ? { x: it.x + offset.dx, y: it.y + offset.dy } : it;
          if (it.type === 'memo')
            return (
              <MemoNote
                key={it.id}
                item={{ ...it, x: pos.x, y: pos.y }}
                editing={editingText === it.id}
                interactive={tool.tool === 'memo' || tool.tool === 'lasso'}
                onEdit={() => setEditingText(it.id)}
                onDragStart={(e) => startItemDrag(e, it)}
                onMove={onMove}
                onUp={onUp}
                onTint={(tint) => updateItem(it.id, { tint } as Partial<Item>)}
                onRemove={() => removeItem(it.id)}
                onDraft={(text) => onDraftItem(it.id, text)}
                onDone={(text) => {
                  setEditingText(null);
                  if (!text.trim()) removeItem(it.id);
                  else if (text !== it.text) updateItem(it.id, { text });
                }}
                onResize={(w) => updateItem(it.id, { w } as Partial<Item>)}
              />
            );
          if (it.type === 'text')
            return (
              <TextBox
                key={it.id}
                item={{ ...it, x: pos.x, y: pos.y }}
                editing={editingText === it.id}
                interactive={tool.tool === 'text'}
                scale={scale}
                pageWidth={page.width}
                pageHeight={page.height}
                onMoveStart={(e) => startItemDrag(e, it, {
                  maxX: page.width - it.w,
                  maxY: page.height - e.currentTarget.offsetHeight,
                })}
                onEdit={() => setEditingText(it.id)}
                onRemove={() => removeItem(it.id)}
                onDraft={(text) => {
                  if (it.id !== pendingText?.id) {
                    onDraftItem(it.id, text);
                  } else if (text.trim()) {
                    onCreateText({ ...it, text });
                    setPendingText(null);
                  }
                }}
                onDone={(text) => {
                  setEditingText((active) => active === it.id ? null : active);
                  if (it.id === pendingText?.id) setPendingText(null);
                  else if (!text.trim()) removeItem(it.id);
                  else if (text !== it.text) updateItem(it.id, { text });
                }}
                onResize={(w) => updateItem(it.id, { w })}
              />
            );
          return (
            <div
              key={it.id}
              data-interactive
              className={`annotation source-${it.source} ${it.collapsed ? 'collapsed' : ''}`}
              style={{ left: pos.x, top: pos.y, width: it.w, maxHeight: Math.max(120, page.height - pos.y - 8) }}
            >
              <div className="annotation-head" onPointerDown={(e) => startItemDrag(e, it)} onPointerMove={onMove} onPointerUp={onUp}>
                <span className={`basis-dot`} />
                <span className="annotation-title">{it.forGap || it.title}</span>
                <button title={it.collapsed ? 'Expand' : 'Collapse'} onPointerDown={(e) => e.stopPropagation()} onClick={() => updateItem(it.id, { collapsed: !it.collapsed })}>
                  {it.collapsed ? '▾' : '▴'}
                </button>
                <button title="Remove from my notes" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeItem(it.id)}>
                  ×
                </button>
              </div>
              {!it.collapsed && (
                <div className="annotation-body">
                  {/* The student's own wording of the gap, then the borrowed text as a quotation. */}
                  {it.forGap && it.title !== it.forGap && <div className="annotation-label">{it.title}</div>}
                  <div className="annotation-quote">
                    <Md text={it.body} />
                  </div>
                  <div className="annotation-label credit">
                    {it.source === 'slide' ? 'From the slides' : it.source === 'peer' ? 'From a classmate’s note' : 'AI explanation'}
                  </div>
                  {it.citations.length > 0 && (
                    <div className="citations">
                      {it.citations.map((c, i) => (
                        <button key={i} className={`cite cite-${c.kind}`} onClick={() => onCitation(c)}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sel && !offset && (
          <div className="sel-menu" data-interactive style={{ left: (selBox ?? sel.area)[0], top: Math.max(0, (selBox ?? sel.area)[1] - 52) }}>
            <button onClick={() => onSelectionAction('ask')}>✦ Explain</button>
            {(sel.strokeIds.size > 0 || sel.itemIds.size > 0) && (
              <button className="danger" onClick={() => onSelectionAction('delete')}>
                Delete
              </button>
            )}
            <button onClick={() => setSelection(null)}>✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

const Paper = memo(function Paper({ kind, w, h }: { kind: EditorPage['kind']; w: number; h: number }) {
  const lines: React.ReactNode[] = [];
  if (kind === 'ruled') {
    lines.push(<line key="m" x1={90} x2={90} y1={0} y2={h} stroke="#f2b8b8" strokeWidth={1.2} />);
    for (let y = 120; y < h - 40; y += 36) lines.push(<line key={y} x1={0} x2={w} y1={y} y2={y} stroke="#c9d6e8" strokeWidth={1.2} />);
  }
  if (kind === 'grid') {
    for (let y = 30; y < h; y += 30) lines.push(<line key={`h${y}`} x1={0} x2={w} y1={y} y2={y} stroke="#dfe5ec" strokeWidth={1} />);
    for (let x = 30; x < w; x += 30) lines.push(<line key={`v${x}`} x1={x} x2={x} y1={0} y2={h} stroke="#dfe5ec" strokeWidth={1} />);
  }
  return <g pointerEvents="none">{lines}</g>;
});

/**
 * A memo: a small note the student sticks on the page. It is their own writing, so it behaves like
 * ink and text — draggable, editable, indexed and shareable — and it is deliberately not a card of
 * app chrome: paper tint, a hairline edge, a folded corner.
 */
function MemoNote({
  item,
  editing,
  interactive,
  onEdit,
  onDragStart,
  onMove,
  onUp,
  onTint,
  onRemove,
  onDone,
  onDraft,
  onResize,
}: {
  item: Extract<Item, { type: 'memo' }>;
  editing: boolean;
  interactive: boolean;
  onEdit: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
  onTint: (t: MemoTint) => void;
  onRemove: () => void;
  onDone: (t: string) => void;
  onDraft: (t: string) => void;
  onResize: (w: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = useRef<{ x: number; w: number } | null>(null);
  const [value, setValue] = useState(item.text);
  useLayoutEffect(() => {
    if (editing) {
      setValue(item.text);
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const style = { left: item.x, top: item.y, width: item.w, fontSize: item.size, color: item.color };
  return (
    <div className={`memo tint-${item.tint} ${editing ? 'editing' : ''} ${interactive ? 'interactive' : ''}`} style={style} {...(interactive ? { 'data-interactive': true } : {})}>
      {editing ? (
        <textarea
          ref={ref}
          autoFocus
          data-interactive
          className="memo-text"
          value={value}
          placeholder="Write a memo…"
          onChange={(e) => {
            setValue(e.target.value);
            onDraft(e.target.value);
          }}
          onBlur={() => onDone(value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      ) : (
        <>
          {/* The note's own face: drag anywhere on it, and it is text like any other. */}
          <div
            className="memo-text"
            onPointerDown={(e) => {
              if (!interactive) return;
              e.stopPropagation();
              // A press that moves drags the memo; a press that stays opens it for typing.
              const start = { x: e.clientX, y: e.clientY };
              const win = window;
              const up = (ev: PointerEvent) => {
                win.removeEventListener('pointerup', up);
                if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) onEdit();
              };
              win.addEventListener('pointerup', up);
              onDragStart(e);
            }}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {item.text}
          </div>
          {interactive && (
            <div className="memo-tools">
              {MEMO_TINTS.map((t) => (
                <button key={t} className={`memo-tint tint-${t} ${item.tint === t ? 'active' : ''}`} aria-label={`Colour ${t}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onTint(t)} />
              ))}
              <button className="memo-del" title="Remove memo" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>
                ×
              </button>
              <span
                className="memo-grip"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  grow.current = { x: e.clientX, w: item.w };
                }}
                onPointerMove={(e) => {
                  if (!grow.current) return;
                  e.stopPropagation();
                  onResize(Math.max(120, grow.current.w + (e.clientX - grow.current.x) * 2));
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  grow.current = null;
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TextBox({
  item,
  editing,
  interactive,
  scale,
  pageWidth,
  pageHeight,
  onMoveStart,
  onEdit,
  onRemove,
  onDone,
  onDraft,
  onResize,
}: {
  item: Extract<Item, { type: 'text' }>;
  editing: boolean;
  interactive: boolean;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  onMoveStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onEdit: () => void;
  onRemove: () => void;
  onDone: (t: string) => void;
  onDraft: (t: string) => void;
  onResize: (w: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = useRef<{ x: number; w: number } | null>(null);
  const [value, setValue] = useState(item.text);
  useLayoutEffect(() => {
    if (editing) {
      setValue(item.text);
      ref.current?.focus();
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const lh = item.lineHeight ?? Math.round(item.size * 1.5);
  const style = { left: item.x, top: item.y, width: item.w, fontSize: item.size, lineHeight: `${lh}px`, color: item.color };
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.max(lh, input.scrollHeight)}px`;
  }, [editing, value, item.w, lh]);
  if (editing)
    return (
      <textarea
        ref={ref}
        autoFocus
        data-interactive
        className="text-item editing"
        style={{ ...style, maxHeight: Math.max(lh, pageHeight - item.y) }}
        value={value}
        placeholder="Type…"
        onChange={(e) => {
          setValue(e.target.value);
          onDraft(e.target.value);
        }}
        onBlur={() => onDone(value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          e.stopPropagation();
        }}
      />
    );
  return (
    <div
      className={`text-item ${interactive ? 'interactive' : ''}`}
      data-interactive={interactive || undefined}
      tabIndex={interactive ? 0 : undefined}
      style={style}
      onPointerDown={interactive ? (e) => {
        if (e.target !== e.currentTarget || e.button !== 0) return;
        e.currentTarget.focus({ preventScroll: true });
        onMoveStart(e);
      } : undefined}
      onDoubleClick={interactive ? (e) => {
        if (e.target === e.currentTarget) onEdit();
      } : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') onEdit();
        else if (e.key === 'Delete' || e.key === 'Backspace') onRemove();
        else if (e.key === 'Escape') e.currentTarget.blur();
        else return;
        e.preventDefault();
        e.stopPropagation();
      } : undefined}
    >
      {item.text}
      {interactive && (
        <>
          <div className="text-note-actions" style={{ top: item.y < 36 ? '100%' : -34 }}>
            <button type="button" title="Edit text note" aria-label="Edit text note" onClick={onEdit}><Pencil size={15} /></button>
            <button type="button" title="Delete text note" aria-label="Delete text note" onClick={onRemove}><Trash2 size={15} /></button>
          </div>
          <div
            className="text-grip"
            title="Drag to resize"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              grow.current = { x: e.clientX, w: item.w };
            }}
            onPointerMove={(e) => {
              if (!grow.current) return;
              const width = grow.current.w + (e.clientX - grow.current.x) / scale;
              onResize(Math.min(pageWidth - item.x, Math.max(100, width)));
            }}
            onLostPointerCapture={() => { grow.current = null; }}
          />
        </>
      )}
    </div>
  );
}

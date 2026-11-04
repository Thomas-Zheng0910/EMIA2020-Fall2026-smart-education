import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Citation, Item, Stroke } from '../../shared/types';
import { strokeBounds, strokeInLasso, strokeNear, strokeOpacity, strokePath, pointInPolygon } from '../../shared/ink';
import { uid } from '../api';
import { Md } from '../Md';
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
  if (it.type === 'text') {
    const lines = it.text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil((l.length * it.size * 0.52) / it.w)), 0);
    return [it.x, it.y, it.x + it.w, it.y + Math.max(1, lines) * it.size * 1.3 + 8];
  }
  return [it.x, it.y, it.x + it.w, it.y + (it.collapsed ? 40 : 180)];
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

type Props = {
  page: EditorPage;
  scale: number;
  tool: ToolState;
  selection: Selection | null;
  editingText: string | null;
  setEditingText: (id: string | null) => void;
  setSelection: (s: Selection | null) => void;
  commit: (pageId: string, strokes: Stroke[], items: Item[]) => void;
  onSelectionAction: (action: 'ask' | 'quiz' | 'delete') => void;
  onCitation: (c: Citation) => void;
};

export function PageView({ page, scale, tool, selection, editingText, setEditingText, setSelection, commit, onSelectionAction, onCitation }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const live = useRef<SVGPathElement>(null);
  const lassoPath = useRef<SVGPathElement>(null);
  const gesture = useRef<
    | { kind: 'ink'; stroke: Stroke }
    | { kind: 'erase'; removed: Set<string> }
    | { kind: 'lasso'; poly: number[][] }
    | { kind: 'move'; x: number; y: number; dx: number; dy: number }
    | { kind: 'drag-item'; id: string; x: number; y: number; ox: number; oy: number }
    | null
  >(null);
  const [erased, setErased] = useState<Set<string>>(new Set());
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [dragItem, setDragItem] = useState<{ id: string; x: number; y: number } | null>(null);
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
    if (tool.tool === 'text') {
      e.preventDefault(); // keeps focus on the new text box mounted below
      const left = Math.min(x, page.width - 90);
      const it: Item = { id: uid(), type: 'text', x: left, y: y - 14, w: Math.max(80, Math.min(420, page.width - left - 10)), text: '', color: tool.color, size: 22 };
      commit(page.id, page.strokes, [...page.items, it]);
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
      setDragItem({ id: g.id, x: g.ox + x - g.x, y: g.oy + y - g.y });
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
      setDragItem((d) => {
        if (d) commit(page.id, page.strokes, page.items.map((it) => (it.id === d.id ? { ...it, x: d.x, y: d.y } : it)));
        return null;
      });
    }
  };

  const startItemDrag = (e: React.PointerEvent, it: Item) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = toPage(e);
    gesture.current = { kind: 'drag-item', id: it.id, x, y, ox: it.x, oy: it.y };
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
  const cursor = { pen: 'crosshair', highlighter: 'crosshair', eraser: 'cell', lasso: 'default', text: 'text' }[tool.tool];

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
        {page.items.map((it) => {
          if (it.type === 'image') return null;
          const pos = dragItem?.id === it.id ? dragItem : offset && sel?.itemIds.has(it.id) ? { x: it.x + offset.dx, y: it.y + offset.dy } : it;
          if (it.type === 'text')
            return (
              <TextBox
                key={it.id}
                item={{ ...it, x: pos.x, y: pos.y }}
                editing={editingText === it.id}
                interactive={tool.tool === 'text'}
                onEdit={() => setEditingText(it.id)}
                onDone={(text) => {
                  setEditingText(null);
                  if (!text.trim()) removeItem(it.id);
                  else if (text !== it.text) updateItem(it.id, { text });
                }}
              />
            );
          return (
            <div key={it.id} data-interactive className={`annotation source-${it.source} ${it.collapsed ? 'collapsed' : ''}`} style={{ left: pos.x, top: pos.y, width: it.w }}>
              <div className="annotation-head" onPointerDown={(e) => startItemDrag(e, it)} onPointerMove={onMove} onPointerUp={onUp}>
                <span className={`basis-dot`} />
                <span className="annotation-title">{it.title}</span>
                <button title={it.collapsed ? 'Expand' : 'Collapse'} onPointerDown={(e) => e.stopPropagation()} onClick={() => updateItem(it.id, { collapsed: !it.collapsed })}>
                  {it.collapsed ? '▾' : '▴'}
                </button>
                <button title="Remove from my notes" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeItem(it.id)}>
                  ×
                </button>
              </div>
              {!it.collapsed && (
                <div className="annotation-body">
                  <div className="annotation-label">{it.source === 'slide' ? 'From the slides' : it.source === 'peer' ? 'From a classmate’s note' : 'AI explanation'}</div>
                  <Md text={it.body} />
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
            <button onClick={() => onSelectionAction('quiz')}>Quiz me</button>
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

function TextBox({ item, editing, interactive, onEdit, onDone }: { item: Extract<Item, { type: 'text' }>; editing: boolean; interactive: boolean; onEdit: () => void; onDone: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(item.text);
  useLayoutEffect(() => {
    if (editing) {
      setValue(item.text);
      ref.current?.focus();
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const style = { left: item.x, top: item.y, width: item.w, fontSize: item.size, color: item.color };
  if (editing)
    return (
      <textarea
        ref={ref}
        autoFocus
        data-interactive
        className="text-item editing"
        style={{ ...style, height: Math.max(item.size * 1.6, (value.split('\n').length + 1) * item.size * 1.3) }}
        value={value}
        placeholder="Type…"
        onChange={(e) => setValue(e.target.value)}
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
      {...(interactive ? { 'data-interactive': true } : {})}
      style={style}
      onPointerDown={interactive ? (e) => (e.stopPropagation(), onEdit()) : undefined}
    >
      {item.text}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Citation, Item, Notebook, Stroke, Suggestion } from '../../shared/types';
import { api, ApiError, upload, uid, getStudent } from '../api';
import { PageView, StrokeLayer, selectionBox } from './PageView';
import { Toolbar } from './Toolbar';
import { MarginMarkers, SuggestionCard, LassoPopover, SuggestionsPanel, useSuggestions, type AddFn } from '../panel/Panel';
import { SourceViewer } from '../panel/SourceViewer';
import { PageChrome } from './PageChrome';
import { useBoot } from '../boot';
import { lastPage, readMigrated } from '../ui';
import type { EditorPage, SaveState, Selection, ToolState } from './types';

type Snapshot = { strokes: Stroke[]; items: Item[] };
type HistoryEntry = { pageId: string; before: Snapshot; after: Snapshot };

const DEFAULT_TOOL: ToolState = { tool: 'pen', color: '#1f2933', size: 4, hlColor: '#ffd43b', hlSize: 22, stylusOnly: false };

export function Editor({ notebookId, onBack, onToast }: { notebookId: string; onBack: (courseId?: string) => void; onToast: (m: string) => void }) {
  const boot = useBoot();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolState>(() => ({
    ...DEFAULT_TOOL,
    ...JSON.parse(readMigrated('notebook.tool') ?? '{}'),
  }));
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  // Quiet by default: the panel opens only when the student asks; the choice is remembered.
  const [panel, setPanelState] = useState<{ open: boolean }>({
    open: readMigrated('notebook.panel') === 'open' && window.innerWidth > 1100,
  });
  const setPanel = (next: { open: boolean } | ((p: { open: boolean }) => { open: boolean })) =>
    setPanelState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      localStorage.setItem('notebook.panel', v.open ? 'open' : 'closed');
      return v;
    });
  /**
   * The suggestion card open at a gap. The card itself is held, not its id: a suggestions
   * refresh (a re-read after writing) must not blink an open card out from under the student.
   */
  const [openGap, setOpenGap] = useState<Suggestion | null>(null);
  const [lasso, setLasso] = useState<{ pageId: string; bbox: [number, number, number, number] } | null>(null);
  const [source, setSource] = useState<Citation | null>(null);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [showThumbs, setShowThumbs] = useState(window.innerWidth > 800);
  const [width, setWidth] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollLock = useRef(0);
  const pagesRef = useRef<EditorPage[]>([]);
  pagesRef.current = pages;
  const undo = useRef<HistoryEntry[]>([]);
  const redo = useRef<HistoryEntry[]>([]);
  const [, bump] = useState(0);

  useEffect(() => localStorage.setItem('notebook.tool', JSON.stringify(tool)), [tool]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ notebook: Notebook; pages: EditorPage[] }>(`/api/notebooks/${notebookId}`);
      setNotebook(data.notebook);
      setPages(data.pages);
      // Resume where the student left this notebook.
      const resume = lastPage.get(notebookId);
      const start = data.pages.find((p) => p.id === resume)?.id ?? data.pages[0]?.id ?? null;
      setCurrent((c) => c ?? start);
      if (start && start !== data.pages[0]?.id) setTimeout(() => goto(start, 'auto'), 60);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [notebookId]);
  useEffect(() => {
    load();
  }, [load]);
  // Opening a notebook (e.g. from a link) switches to its course so lectures and links match.
  useEffect(() => {
    if (notebook && boot.course?.id !== notebook.courseId && boot.enrolled.includes(notebook.courseId)) boot.selectCourse(notebook.courseId);
  }, [notebook?.courseId, boot.course?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- saving (per page, serialized; edits made during a save are kept and saved next)
  const timers = useRef(new Map<string, number>());
  const inflight = useRef(new Set<string>());
  const dirty = useRef(new Set<string>());
  const setSave = (pid: string, s: SaveState) => setSaveState((m) => (m[pid] === s ? m : { ...m, [pid]: s }));
  const flush = useCallback(async (pid: string) => {
    if (inflight.current.has(pid)) return;
    const page = pagesRef.current.find((p) => p.id === pid);
    if (!page || !dirty.current.has(pid)) return;
    dirty.current.delete(pid);
    inflight.current.add(pid);
    setSave(pid, 'saving');
    try {
      const { revision } = await api<{ revision: number }>(`/api/pages/${pid}`, { method: 'PUT', json: { revision: page.revision, strokes: page.strokes, items: page.items } });
      setPages((ps) => ps.map((p) => (p.id === pid ? { ...p, revision, indexStatus: 'queued' } : p)));
      pagesRef.current = pagesRef.current.map((p) => (p.id === pid ? { ...p, revision } : p));
      setSave(pid, dirty.current.has(pid) ? 'dirty' : 'saved');
    } catch (e) {
      dirty.current.add(pid);
      setSave(pid, 'error');
      onToast((e as Error).message);
      if (e instanceof ApiError && e.status === 409) return;
      window.setTimeout(() => flush(pid), 4000);
    } finally {
      inflight.current.delete(pid);
    }
    if (dirty.current.has(pid)) flush(pid);
  }, [onToast]);
  const scheduleSave = useCallback(
    (pid: string) => {
      dirty.current.add(pid);
      setSave(pid, 'dirty');
      clearTimeout(timers.current.get(pid));
      timers.current.set(pid, window.setTimeout(() => flush(pid), 700));
    },
    [flush],
  );
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size || inflight.current.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    // A tab closed or hidden is also "leaving": flush what is unsaved and let the server merge.
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      for (const pid of [...dirty.current]) flush(pid);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);
  const saveAll = async () => {
    for (const pid of [...dirty.current]) {
      clearTimeout(timers.current.get(pid));
      await flush(pid);
    }
  };

  const apply = useCallback(
    (pid: string, snap: Snapshot) => {
      setPages((ps) => {
        const next = ps.map((p) => (p.id === pid ? { ...p, ...snap } : p));
        pagesRef.current = next;
        return next;
      });
      scheduleSave(pid);
    },
    [scheduleSave],
  );
  const commit = useCallback(
    (pid: string, strokes: Stroke[], items: Item[]) => {
      const page = pagesRef.current.find((p) => p.id === pid);
      if (!page) return;
      undo.current.push({ pageId: pid, before: { strokes: page.strokes, items: page.items }, after: { strokes, items } });
      if (undo.current.length > 200) undo.current.shift();
      redo.current = [];
      apply(pid, { strokes, items });
      bump((n) => n + 1);
    },
    [apply],
  );
  const doUndo = () => {
    const h = undo.current.pop();
    if (!h) return;
    redo.current.push(h);
    apply(h.pageId, h.before);
    setSelection(null);
    bump((n) => n + 1);
  };
  const doRedo = () => {
    const h = redo.current.pop();
    if (!h) return;
    undo.current.push(h);
    apply(h.pageId, h.after);
    bump((n) => n + 1);
  };

  // ---------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable=true]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? doRedo() : doUndo());
      else if (mod && e.key.toLowerCase() === 'y') (e.preventDefault(), doRedo());
      else if (mod && e.key.toLowerCase() === 's') (e.preventDefault(), saveAll());
      else if (mod && (e.key === '=' || e.key === '+')) (e.preventDefault(), setZoom((z) => Math.min(3, z + 0.1)));
      else if (mod && e.key === '-') (e.preventDefault(), setZoom((z) => Math.max(0.4, z - 0.1)));
      else if (!mod && !e.altKey) {
        const map: Record<string, ToolState['tool']> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text' };
        if (map[e.key]) setTool((s) => ({ ...s, tool: map[e.key]! }));
        if ((e.key === 'Delete' || e.key === 'Backspace') && selection) selectionAction('delete');
        if (e.key === 'Escape') setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- layout: fit width and track the current page
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.4, z * (e.deltaY < 0 ? 1.08 : 0.93))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => (ro.disconnect(), el.removeEventListener('wheel', onWheel));
  }, [notebook]);
  const baseScale = Math.min(1.15, Math.max(0.3, (width - 48) / 1000));
  const scale = baseScale * zoom;
  // Keep the page the student is reading in place when the scale changes (panel opens, zoom, resize).
  const anchor = useRef<{ pid: string; frac: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    const node = a ? el?.querySelector<HTMLElement>(`[data-page-id="${a.pid}"]`) : null;
    if (el && a && node) {
      scrollLock.current = Date.now() + 300;
      el.scrollTop = node.offsetTop + a.frac * node.offsetHeight;
    }
  }, [scale]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      if (Date.now() < scrollLock.current) return; // an explicit navigation is in progress
      const mid = el.getBoundingClientRect().top + el.clientHeight * 0.35;
      let best: string | null = null;
      for (const node of el.querySelectorAll<HTMLElement>('[data-page-id]')) {
        const r = node.getBoundingClientRect();
        if (r.top <= mid) best = node.dataset.pageId!;
        else break;
      }
      if (best) {
        setCurrent(best);
        const node = el.querySelector<HTMLElement>(`[data-page-id="${best}"]`)!;
        anchor.current = { pid: best, frac: (el.scrollTop - node.offsetTop) / Math.max(1, node.offsetHeight) };
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [pages.length]);
  function goto(pid: string, behavior: ScrollBehavior = 'smooth') {
    scrollLock.current = Date.now() + 1000;
    anchor.current = { pid, frac: 0 };
    document.querySelector(`[data-page-id="${pid}"]`)?.scrollIntoView({ behavior, block: 'start' });
    setCurrent(pid);
  }
  const pickPage = (pid: string) => {
    goto(pid);
    // On phones the thumbnails are a drawer over the page; get out of the way once a page is picked.
    if (window.innerWidth <= 800) setShowThumbs(false);
  };

  // ---------- status polling: fast while any page is being organized, slow otherwise (new classmate notes)
  const currentPage = pages.find((p) => p.id === current) ?? null;
  // One suggestion request per page version: the markers, the panel and the inline card share it.
  const suggestions = useSuggestions(currentPage, onToast);
  useEffect(() => {
    if (current) lastPage.set(notebookId, current);
  }, [current, notebookId]);
  const busy = pages.some((p) => p.indexStatus === 'queued' || p.indexStatus === 'indexing');
  useEffect(() => {
    if (!notebook) return;
    const t = window.setInterval(async () => {
      try {
        const list: Pick<EditorPage, 'id' | 'indexStatus' | 'indexError' | 'link' | 'sharedCount' | 'peerCount'>[] = await api(`/api/notebooks/${notebook.id}/status`);
        const byId = new Map(list.map((s) => [s.id, s]));
        setPages((ps) =>
          ps.map((p) => {
            const s = byId.get(p.id);
            if (!s) return p;
            // A save in flight means the server state is about to change; keep the local "queued".
            const indexStatus = dirty.current.has(p.id) || inflight.current.has(p.id) ? p.indexStatus : s.indexStatus;
            return { ...p, ...s, indexStatus };
          }),
        );
      } catch {
        /* transient */
      }
    }, busy ? 2500 : 30000);
    return () => clearInterval(t);
  }, [notebook, busy]);

  // ---------- actions
  const selectionAction = (action: 'ask' | 'quiz' | 'delete') => {
    if (!selection) return;
    const page = pages.find((p) => p.id === selection.pageId);
    if (!page) return;
    if (action === 'delete') {
      commit(page.id, page.strokes.filter((s) => !selection.strokeIds.has(s.id)), page.items.filter((i) => !selection.itemIds.has(i.id)));
      setSelection(null);
      return;
    }
    const b = selectionBox(page.strokes, page.items, selection) ?? selection.area;
    const bbox: [number, number, number, number] = [
      Math.max(0, b[0] / page.width),
      Math.max(0, b[1] / page.height),
      Math.min(1, (b[2] - b[0]) / page.width),
      Math.min(1, (b[3] - b[1]) / page.height),
    ];
    setCurrent(page.id);
    // Circling a part opens the popover in place; it answers without leaving the page.
    if (action === 'ask') setLasso({ pageId: page.id, bbox });
    else setPanel({ open: true });
  };

  const addAnnotation = (
    pid: string,
    a: { title: string; body: string; source: Suggestion['source']; citations: Citation[] },
    near?: [number, number, number, number] | null,
  ) => {
    const page = pagesRef.current.find((p) => p.id === pid);
    if (!page) return;
    const w = Math.min(380, page.width * 0.42);
    const n = page.items.filter((i) => i.type === 'annotation').length;
    let x = page.width - w - 16,
      y = Math.min(page.height - 80, 16 + n * 36);
    if (near) {
      // Beside the selection it explains; below it when there's no room on the right.
      const [bx, by, bw, bh] = [near[0] * page.width, near[1] * page.height, near[2] * page.width, near[3] * page.height];
      if (bx + bw + 12 + w <= page.width) (x = bx + bw + 12), (y = by);
      else (x = Math.max(8, Math.min(page.width - w - 8, bx))), (y = by + bh + 12);
      y = Math.max(8, Math.min(page.height - 60, y));
    }
    const item: Item = { id: uid(), type: 'annotation', x, y, w, title: a.title, body: a.body, source: a.source, citations: a.citations };
    commit(pid, page.strokes, [...page.items, item]);
    onToast('Added to your notes as a separate note. Ctrl+Z to undo.');
  };

  /**
   * Leaving is the moment the notes are uploaded: the server merges this notebook's slides so
   * classmates see them. Sent with keepalive so closing a tab still counts.
   */
  const closeNotebook = async () => {
    if (!notebook) return;
    try {
      await fetch(`/api/notebooks/${notebook.id}/close`, { method: 'POST', keepalive: true, headers: { 'x-student-id': getStudent() } });
    } catch {
      /* the periodic sweep will pick these slides up */
    }
  };

  const reportSuggestion = async (g: Suggestion) => {
    if (!g.entryId) return;
    await api(`/api/entries/${g.entryId}/report`, { method: 'POST', json: { reason: '' } }).catch(() => {});
    onToast('Thanks — that suggestion is hidden while it is checked.');
  };

  const insertPage = async (after: string | null, kind: 'blank' | 'ruled' | 'grid' = 'ruled') => {
    try {
      const page = await api<EditorPage>(`/api/notebooks/${notebookId}/pages`, { method: 'POST', json: { after, kind } });
      setPages((ps) => {
        const idx = after ? ps.findIndex((p) => p.id === after) : ps.length - 1;
        const next = [...ps];
        next.splice(idx + 1, 0, page);
        return next;
      });
      setTimeout(() => goto(page.id), 50);
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const deletePage = async (pid: string) => {
    if (!confirm('Delete this page and everything on it?')) return;
    try {
      await api(`/api/pages/${pid}`, { method: 'DELETE' });
      const before = pagesRef.current;
      const removedAt = before.findIndex((p) => p.id === pid);
      const remaining = before.filter((p) => p.id !== pid);
      pagesRef.current = remaining;
      setPages(remaining);
      undo.current = undo.current.filter((h) => h.pageId !== pid);
      if (selection?.pageId === pid) setSelection(null);
      if (current === pid && remaining.length) {
        const next = remaining[Math.min(Math.max(0, removedAt), remaining.length - 1)]!;
        setCurrent(next.id);
        setTimeout(() => goto(next.id, 'auto'), 30);
      }
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const insertImage = async (file: File) => {
    const page = currentPage;
    if (!page) return;
    try {
      const f = await upload<{ id: string; width: number; height: number }>('/api/files', file);
      const w = Math.min(page.width * 0.5, f.width);
      const h = (w * f.height) / f.width;
      commit(page.id, page.strokes, [...page.items, { id: uid(), type: 'image', x: (page.width - w) / 2, y: Math.max(10, (page.height - h) / 3), w, h, fileId: f.id }]);
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const setLink = async (pid: string, lectureId: string | null, slideId: string | null) => {
    try {
      const s = await api(`/api/pages/${pid}/link`, { method: 'POST', json: { lectureId, slideId } });
      setPages((ps) => ps.map((p) => (p.id === pid ? { ...p, link: s.link, indexStatus: s.indexStatus } : p)));
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const rename = async (title: string) => {
    if (!notebook || !title.trim() || title === notebook.title) return;
    await api(`/api/notebooks/${notebook.id}`, { method: 'PATCH', json: { title } }).catch((e) => onToast(e.message));
    setNotebook({ ...notebook, title });
  };

  const overall: SaveState = Object.values(saveState).includes('error')
    ? 'error'
    : Object.values(saveState).includes('saving')
      ? 'saving'
      : Object.values(saveState).includes('dirty')
        ? 'dirty'
        : 'saved';
  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);

  if (error)
    return (
      <div className="center-message">
        <p>{error}</p>
        <button className="btn" onClick={() => onBack()}>
          Back to courses
        </button>
      </div>
    );
  if (!notebook) return <div className="center-message">Opening notebook…</div>;

  return (
    <div className={`editor ${panel.open ? 'panel-open' : ''}`}>
      <header className="editor-top">
        <button className="icon-btn" onClick={async () => (await saveAll(), await closeNotebook(), onBack(notebook.courseId))} title="Back to course" aria-label="Back to course">
          ‹
        </button>
        {boot.course?.id === notebook.courseId && (
          <button className="course-badge as-link" onClick={async () => (await saveAll(), await closeNotebook(), onBack(notebook.courseId))} title={boot.course.name}>
            {boot.course.code}
          </button>
        )}
        <button className="icon-btn" onClick={() => setShowThumbs((v) => !v)} title="Pages" aria-label="Toggle page thumbnails">
          ▤
        </button>
        <input className="nb-title" defaultValue={notebook.title} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state s-${overall}`}>{{ saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved — retrying' }[overall]}</span>
        <div className="spacer" />
        <Toolbar
          tool={tool}
          setTool={setTool}
          canUndo={undo.current.length > 0}
          canRedo={redo.current.length > 0}
          onUndo={doUndo}
          onRedo={doRedo}
          onImage={insertImage}
        />
        <div className="spacer" />
        <button className={`btn ghost panel-toggle ${panel.open ? 'active' : ''}`} onClick={() => setPanel((p) => ({ ...p, open: !p.open }))}>
          ✦ Study
        </button>
      </header>
      <div className="editor-body">
        {showThumbs && (
          <aside className="thumbs">
            {pages.map((p, i) => (
              <button key={p.id} className={`thumb ${p.id === current ? 'active' : ''}`} onClick={() => pickPage(p.id)}>
                <div className={`thumb-page paper-${p.kind}`} style={{ aspectRatio: `${p.width} / ${p.height}` }}>
                  {p.background && <img src={p.background} alt="" loading="lazy" />}
                  <svg viewBox={`0 0 ${p.width} ${p.height}`}>
                    <StrokeLayer strokes={p.strokes} />
                  </svg>
                  {p.peerCount > 0 && <span className="thumb-badge" title={`${p.peerCount} classmate notes`}>{p.peerCount}</span>}
                </div>
                <span className="thumb-num">{i + 1}</span>
              </button>
            ))}
            <button className="thumb-add" onClick={() => insertPage(pages.at(-1)?.id ?? null)}>
              + Page
            </button>
          </aside>
        )}
        <main
          className="canvas-scroll"
          ref={scroller}
          onPointerDown={(e) => e.target === e.currentTarget && setSelection(null)}
          onPointerDownCapture={(e) => {
            const id = (e.target as HTMLElement).closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
            if (id && id !== current) (setCurrent(id), (scrollLock.current = Date.now() + 1500));
          }}
        >
          {pages.map((p) => (
            <section key={p.id} className="page-slot" data-page-id={p.id} style={{ width: p.width * scale }}>
              <PageChrome
                page={p}
                index={pageIndex.get(p.id)! + 1}
                saveState={saveState[p.id]}
                onInsert={(kind) => insertPage(p.id, kind)}
                onDelete={() => deletePage(p.id)}
                onClassmates={() => (goto(p.id), setPanel({ open: true }))}
                onLink={(l, s) => setLink(p.id, l, s)}
              />
              <div className="page-with-margin">
                {/* Quiet by default: a small marker beside each gap, nothing else until it is tapped. */}
                {p.id === current && suggestions.gaps.length > 0 && (
                  <MarginMarkers page={p} scale={scale} gaps={suggestions.gaps} onOpen={(g) => (goto(p.id), setOpenGap(g))} />
                )}
                <LazyPage height={p.height * scale} root={scroller}>
                  <PageView
                    page={p}
                    scale={scale}
                    tool={tool}
                    selection={selection}
                    setSelection={setSelection}
                    editingText={editingText}
                    setEditingText={setEditingText}
                    commit={commit}
                    onSelectionAction={selectionAction}
                    onCitation={setSource}
                  />
                </LazyPage>
                {openGap && p.id === current && (
                  <div className="gap-card" style={{ top: Math.max(0, openGap.bbox[1] * p.height) * scale }}>
                    <SuggestionCard
                      key={openGap.id}
                      suggestion={openGap}
                      onAdd={() => {
                        addAnnotation(p.id, { title: openGap.title || openGap.missing, body: openGap.body, source: openGap.source, citations: openGap.citations }, openGap.bbox);
                        setOpenGap(null);
                      }}
                      onDismiss={() => {
                        suggestions.dismiss(openGap);
                        setOpenGap(null);
                      }}
                      onCitation={setSource}
                      onReport={() => {
                        reportSuggestion(openGap);
                        setOpenGap(null);
                      }}
                      onClose={() => setOpenGap(null)}
                    />
                  </div>
                )}
              </div>
            </section>
          ))}
          <div className="canvas-end">
            <button className="btn ghost" onClick={() => insertPage(pages.at(-1)?.id ?? null)}>
              + Add page
            </button>
          </div>
        </main>
        <div className={`zoom-float ${panel.open ? 'with-panel' : ''}`} role="group" aria-label="Zoom">
          <button onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">
            −
          </button>
          <button className="zoom-val" onClick={() => setZoom(() => 1)} title="Fit width">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">
            +
          </button>
        </div>
        {panel.open && currentPage && (
          <SuggestionsPanel
            page={currentPage}
            notebook={notebook}
            pageNumber={pageIndex.get(currentPage.id)! + 1}
            gaps={suggestions.gaps}
            own={suggestions.data?.own ?? []}
            unlinked={suggestions.data?.unlinked ?? false}
            onClose={() => setPanel((p) => ({ ...p, open: false }))}
            onScrollTo={(g) => {
              setOpenGap(g);
              goto(currentPage.id);
            }}
            onAdd={addAnnotation}
            onCitation={setSource}
            onDismiss={suggestions.dismiss}
            onReport={reportSuggestion}
          />
        )}
      </div>
      {lasso && currentPage && lasso.pageId === currentPage.id && (
        <LassoPopover
          pageId={lasso.pageId}
          bbox={lasso.bbox}
          onAdd={(a) => {
            addAnnotation(currentPage.id, a, lasso.bbox);
            setLasso(null);
          }}
          onCitation={setSource}
          onClose={() => setLasso(null)}
        />
      )}
      {source && <SourceViewer citation={source} onClose={() => setSource(null)} />}
    </div>
  );
}

/** Renders pages near the visible part of the canvas (not the window), so scrolling never shows blank pages. */
function LazyPage({ height, root, children }: { height: number; root: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e!.isIntersecting), { root: root.current, rootMargin: '1500px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  return (
    <div ref={ref} style={{ minHeight: height }}>
      {visible ? children : <div className="page-placeholder" style={{ height }} />}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, PanelLeft, Share2 } from 'lucide-react';
import type { Citation, Item, LiveSession, Notebook, NotebookMember, PaperKind, Stroke, Suggestion } from '../../shared/types';
import { api, ApiError, upload, uid, getStudent } from '../api';
import { ShareDialog } from '../ShareDialog';
import { PageView, StrokeLayer, selectionBox, itemBox } from './PageView';
import { Toolbar } from './Toolbar';
import { InlineGhost, MarginMarkers, SuggestionCard, LassoPopover, SuggestionsPanel, unanswered, useSuggestions, type AddFn } from '../panel/Panel';
import { SourceViewer } from '../panel/SourceViewer';
import { DemoFeedback } from '../panel/DemoFeedback';
import { PageChrome } from './PageChrome';
import { useBoot } from '../boot';
import { lastPage, readMigrated } from '../ui';
import { paperName, writingColumn } from '../paper';
import { strokeBounds } from '../../shared/ink';
import type { EditorPage, SaveState, Selection, ToolState } from './types';

type Snapshot = { strokes: Stroke[]; items: Item[] };
type HistoryEntry = { pageId: string; before: Snapshot; after: Snapshot };

/**
 * Apply the local edits that arrived while a save was in flight on top of the server's merged
 * page. The next save must be based on the merged state, not the pre-save state, or a local erase
 * of an object that was just saved would look like a remote addition to the server.
 */
function rebaseSnapshot(sent: Snapshot, local: Snapshot, merged: Snapshot): Snapshot {
  const s = new Map([...sent.strokes, ...sent.items].map((o) => [o.id, o]));
  const l = new Map([...local.strokes, ...local.items].map((o) => [o.id, o]));
  const m = new Map([...merged.strokes, ...merged.items].map((o) => [o.id, o]));
  const out: (Stroke | Item)[] = [];
  for (const id of new Set([...s.keys(), ...l.keys(), ...m.keys()])) {
    const so = s.get(id);
    const lo = l.get(id);
    const mo = m.get(id);
    if (!lo) {
      // A local delete wins. A server addition the client never saw is kept.
      if (so) continue;
      if (mo) out.push(mo);
      continue;
    }
    if (!so) {
      out.push(lo); // local addition
      continue;
    }
    if (JSON.stringify(lo) !== JSON.stringify(so)) {
      out.push(lo); // local edit wins
      continue;
    }
    if (mo) out.push(mo); // unchanged locally: follow the server
  }
  return { strokes: out.filter((o) => !('type' in o)) as Stroke[], items: out.filter((o) => 'type' in o) as Item[] };
}

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
  const [panelTab, setPanelTab] = useState<'ask' | 'suggestions'>('ask');
  const [demoPanelOpen, setDemoPanelOpen] = useState(false);
  const demoLecture = import.meta.env.VITE_ARITHMETIC_DEMO === '1' && notebook?.courseId === 'arith101' && notebook.kind === 'lecture';
  const demoFeedback = demoLecture && (notebook.studentId === 'alex' || notebook.studentId === 'thomas');
  const panelOpen = demoLecture ? demoFeedback && demoPanelOpen : panel.open;
  const setPanel = (next: { open: boolean } | ((p: { open: boolean }) => { open: boolean })) =>
    setPanelState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      localStorage.setItem('notebook.panel', v.open ? 'open' : 'closed');
      return v;
    });
  /**
   * The suggestion card open at a gap: its id plus the version that was showing when it opened.
   * The id keeps the card alive across a refresh, and the snapshot keeps it on screen if the gap
   * disappears; otherwise the card follows the refreshed data, so a gap that just gained a
   * classmate's note shows that note instead of a stale "From slide 12".
   */
  const [openGap, setOpenGap] = useState<{ id: string; snapshot: Suggestion } | null>(null);
  /** Which of this page's suggestions is showing inline; accepting one advances to the next. */
  const [ghostIndex, setGhostIndex] = useState(0);
  const [lasso, setLasso] = useState<{ pageId: string; bbox: [number, number, number, number] } | null>(null);
  const [source, setSource] = useState<Citation | null>(null);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [showThumbs, setShowThumbs] = useState(window.innerWidth > 800);
  const [width, setWidth] = useState(800);
  const [sharing, setSharing] = useState<'copy' | 'group' | null>(null);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [presence, setPresence] = useState<{ studentId: string; pageId: string | null; updatedAt: string; name: string; initials: string; color: string }[]>([]);
  const [fetching, setFetching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollLock = useRef(0);
  const notebookRef = useRef<Notebook | null>(null);
  notebookRef.current = notebook;
  const pagesRef = useRef<EditorPage[]>([]);
  const conflicted = useRef(new Set<string>());
  /** Pages added here that a status response may predate; never remove them as “deleted remotely”. */
  const addedPages = useRef(new Set<string>());
  /** Text/memo drafts survive a status/presence render that still carries the old page state. */
  const drafts = useRef(new Map<string, string>());
  // Do not reset the ref on every render: draft text lives in pagesRef between keystrokes and a
  // save-state render must not put the older React page back over it.
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  /** The page content to save, with any in-progress text/memo draft merged in. */
  const withDrafts = (page: EditorPage, pid: string): Snapshot => ({
    strokes: page.strokes,
    items: page.items.map((it) => {
      if (it.type !== 'text' && it.type !== 'memo') return it;
      const draft = drafts.current.get(`${pid}:${it.id}`);
      return draft !== undefined && draft !== it.text ? { ...it, text: draft } : it;
    }),
  });
  /** The server state each page's local edits are based on; group notes merge against it. */
  const bases = useRef(new Map<string, Snapshot>());
  const undo = useRef<HistoryEntry[]>([]);
  const redo = useRef<HistoryEntry[]>([]);
  const [, bump] = useState(0);

  useEffect(() => localStorage.setItem('notebook.tool', JSON.stringify(tool)), [tool]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ notebook: Notebook; pages: EditorPage[]; presence?: typeof presence }>(`/api/notebooks/${notebookId}`);
      setNotebook(data.notebook);
      // A text box or memo left empty by a tab closed mid-edit is invisible; drop it on open.
      const pages = data.pages.map((p) => ({
        ...p,
        items: p.items.filter((it) => !((it.type === 'text' || it.type === 'memo') && !it.text.trim())),
      }));
      bases.current = new Map(pages.map((p) => [p.id, { strokes: p.strokes, items: p.items }]));
      conflicted.current.clear();
      addedPages.current.clear();
      drafts.current.clear();
      setPresence(data.presence ?? []);
      setPages(pages);
      // Resume where the student left this notebook.
      const resume = lastPage.get(notebookId);
      const start = pages.find((p) => p.id === resume)?.id ?? pages[0]?.id ?? null;
      setCurrent((c) => c ?? start);
      if (start && start !== pages[0]?.id) setTimeout(() => goto(start, 'auto'), 60);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [notebookId]);
  useEffect(() => {
    load();
  }, [load]);
  // Reloading the page while live should keep the professor in the session, not orphan it.
  useEffect(() => {
    if (!notebook || notebook.studentId !== getStudent() || boot.course?.id !== notebook.courseId) return;
    let stopped = false;
    api<LiveSession | null>('/api/live/active')
      .then((s) => {
        if (!stopped && s && s.hostId === getStudent() && s.notebookId === notebook.id) setLive(s);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [notebook?.id, notebook?.studentId, boot.course?.id]);
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
    if (inflight.current.has(pid) || conflicted.current.has(pid)) return;
    const page = pagesRef.current.find((p) => p.id === pid);
    if (!page || !dirty.current.has(pid)) return;
    const sent = withDrafts(page, pid);
    dirty.current.delete(pid);
    inflight.current.add(pid);
    setSave(pid, 'saving');
    try {
      const nb = notebookRef.current;
      const base = bases.current.get(pid);
      const res = await api<{ revision: number; page?: EditorPage }>(`/api/pages/${pid}`, {
        method: 'PUT',
        json: {
          revision: page.revision,
          strokes: sent.strokes,
          items: sent.items,
          ...(nb?.kind === 'group' && base ? { base } : {}),
        },
      });
      const merged = res.page;
      const stillDirty = dirty.current.has(pid);
      if (merged) {
        const baseNext = { strokes: merged.strokes, items: merged.items };
        // The next save must merge against what the server just accepted, but the local page may
        // have gained edits during this request. Rebase those edits onto the server page.
        bases.current.set(pid, baseNext);
        const localPage = pagesRef.current.find((p) => p.id === pid) ?? page;
        const local = withDrafts(localPage, pid);
        const next = stillDirty ? rebaseSnapshot(sent, local, baseNext) : baseNext;
        const group = notebookRef.current?.kind === 'group';
        setPages((ps) =>
          ps.map((p) =>
            p.id === pid
              ? { ...p, ...next, sharedTombstones: merged.sharedTombstones ?? p.sharedTombstones, revision: res.revision, indexStatus: group ? p.indexStatus : 'queued' }
              : p,
          ),
        );
        pagesRef.current = pagesRef.current.map((p) => (p.id === pid ? { ...p, ...next, revision: res.revision } : p));
      } else {
        const latest = pagesRef.current.find((p) => p.id === pid) ?? page;
        const next = stillDirty ? withDrafts(latest, pid) : sent;
        setPages((ps) =>
          ps.map((p) => (p.id === pid ? { ...p, ...next, revision: res.revision, indexStatus: 'queued' } : p)),
        );
        pagesRef.current = pagesRef.current.map((p) =>
          (p.id === pid ? { ...p, ...next, revision: res.revision, indexStatus: 'queued' } : p),
        );
      }
      for (const it of sent.items) {
        if (it.type !== 'text' && it.type !== 'memo') continue;
        const key = `${pid}:${it.id}`;
        if (drafts.current.get(key) === it.text) drafts.current.delete(key);
      }
      setSave(pid, stillDirty ? 'dirty' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        dirty.current.delete(pid);
        setSave(pid, 'error');
        onToast('You no longer have access to this notebook.');
        onBack(notebookRef.current?.courseId);
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        // A classmate deleted this page while we were editing it. Drop it rather than retrying.
        dirty.current.delete(pid);
        conflicted.current.delete(pid);
        bases.current.delete(pid);
        setSaveState((m) => {
          const n = { ...m };
          delete n[pid];
          return n;
        });
        setPages((ps) => ps.filter((p) => p.id !== pid));
        pagesRef.current = pagesRef.current.filter((p) => p.id !== pid);
        setCurrent((c) => (c === pid ? (pagesRef.current[0]?.id ?? null) : c));
        setSelection((s) => (s?.pageId === pid ? null : s));
        setOpenGap(null);
        onToast('That page was deleted. The notebook has been refreshed.');
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        // Do not retry the same stale revision: stop and ask the user to reopen the page.
        conflicted.current.add(pid);
        dirty.current.delete(pid);
        setSave(pid, 'error');
        onToast('This page changed in another window. Reopen the notebook to get the latest version.');
        return;
      }
      dirty.current.add(pid);
      setSave(pid, 'error');
      onToast((e as Error).message);
      window.setTimeout(() => flush(pid), 4000);
    } finally {
      inflight.current.delete(pid);
    }
    if (dirty.current.has(pid) && !conflicted.current.has(pid)) flush(pid);
  }, [onToast, onBack]);
  const scheduleSave = useCallback(
    (pid: string) => {
      if (conflicted.current.has(pid)) {
        setSave(pid, 'error');
        return;
      }
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
    // flush() returns immediately when a save is already in flight. Live end / leave / share must
    // wait for that write, not copy the page 700 ms behind it.
    const started = Date.now();
    while (inflight.current.size && Date.now() - started < 15000) await new Promise((r) => window.setTimeout(r, 25));
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
  /** Keep the page in sync while a text box or memo is being typed, so autosave and leaving never lose it. */
  const draftItem = useCallback(
    (pid: string, itemId: string, text: string) => {
      const page = pagesRef.current.find((p) => p.id === pid);
      if (!page) return;
      const items = page.items.map((it) => (it.id === itemId ? ({ ...it, text } as Item) : it));
      drafts.current.set(`${pid}:${itemId}`, text);
      // Keep the ref current for autosave/Back, but do not re-render the whole editor on every key.
      // The textarea owns the live value; the normal onDone commit still records one undo step.
      pagesRef.current = pagesRef.current.map((p) => (p.id === pid ? { ...p, items } : p));
      scheduleSave(pid);
    },
    [scheduleSave],
  );
  const commit = useCallback(
    (pid: string, strokes: Stroke[], items: Item[]) => {
      const page = pagesRef.current.find((p) => p.id === pid);
      if (!page) return;
      let nextStrokes = strokes;
      let nextItems = items;
      // In a group note, stamp what this person added or changed. That is what per-user undo uses,
      // and what makes "local edit wins" legible on a free-form page.
      let before = { strokes: page.strokes, items: page.items };
      if (notebookRef.current?.kind === 'group') {
        const me = getStudent();
        const beforeMap = new Map([...page.strokes, ...page.items].map((o) => [o.id, o]));
        const afterIds = new Set([...strokes, ...items].map((o) => o.id));
        const mark = <T extends Stroke | Item>(o: T): T => {
          const b = beforeMap.get(o.id);
          if (!b) return { ...o, authorId: me, lastEditedBy: me, origin: 'own' };
          if (JSON.stringify(b) !== JSON.stringify(o)) return { ...o, authorId: o.authorId ?? b.authorId ?? me, lastEditedBy: me };
          return o;
        };
        const markDeleted = <T extends Stroke | Item>(o: T): T => (afterIds.has(o.id) ? o : { ...o, lastEditedBy: me });
        before = { strokes: page.strokes.map(markDeleted), items: page.items.map(markDeleted) };
        nextStrokes = strokes.map(mark);
        nextItems = items.map(mark);
      }
      for (const it of nextItems) if (it.type === 'text' || it.type === 'memo') drafts.current.delete(`${pid}:${it.id}`);
      undo.current.push({ pageId: pid, before, after: { strokes: nextStrokes, items: nextItems } });
      if (undo.current.length > 200) undo.current.shift();
      redo.current = [];
      apply(pid, { strokes: nextStrokes, items: nextItems });
      bump((n) => n + 1);
    },
    [apply],
  );
  /** Undo/redo only this person's objects in a group note; a classmate's newer work is left alone. */
  const restoreMine = (h: HistoryEntry, target: 'before' | 'after') => {
    const page = pagesRef.current.find((p) => p.id === h.pageId);
    if (!page) return;
    const me = getStudent();
    const source = target === 'before' ? h.before : h.after;
    const other = target === 'before' ? h.after : h.before;
    const sMap = new Map([...source.strokes, ...source.items].map((o) => [o.id, o]));
    const oMap = new Map([...other.strokes, ...other.items].map((o) => [o.id, o]));
    const current = [...page.strokes, ...page.items];
    const out: (Stroke | Item)[] = [];
    for (const o of current) {
      const s = sMap.get(o.id);
      const oo = oMap.get(o.id);
      // Only objects whose current version is mine may be undone. A classmate's newer edit wins.
      if (!s && oo && o.lastEditedBy === me) continue;
      if (s && (!oo || JSON.stringify(s) !== JSON.stringify(oo)) && o.lastEditedBy === me) {
        out.push({ ...s, lastEditedBy: me } as Stroke | Item);
        continue;
      }
      out.push(o);
    }
    for (const s of sMap.values()) {
      if (!oMap.has(s.id) && !current.some((o) => o.id === s.id) && s.lastEditedBy === me) out.push({ ...s, lastEditedBy: me } as Stroke | Item);
    }
    apply(h.pageId, { strokes: out.filter((o) => !('type' in o)) as Stroke[], items: out.filter((o) => 'type' in o) as Item[] });
  };
  const doUndo = () => {
    const h = undo.current.pop();
    if (!h) return;
    redo.current.push(h);
    if (notebookRef.current?.kind === 'group') restoreMine(h, 'before');
    else apply(h.pageId, h.before);
    setSelection(null);
    bump((n) => n + 1);
  };
  const doRedo = () => {
    const h = redo.current.pop();
    if (!h) return;
    undo.current.push(h);
    if (notebookRef.current?.kind === 'group') restoreMine(h, 'after');
    else apply(h.pageId, h.after);
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
        const map: Record<string, ToolState['tool']> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text', m: 'memo' };
        if (map[e.key]) setTool((s) => ({ ...s, tool: map[e.key]! }));
        if ((e.key === 'Delete' || e.key === 'Backspace') && selection) selectionAction('delete');
        if (e.key === 'Escape') setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- layout: fit width and track the current page
  // An open suggestion card sits beside the sheet, so the canvas is narrowed while it is open:
  // the card never covers the student's writing.
  const cardRoom = openGap ? Math.min(400, Math.max(300, width * 0.3)) : 0;
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
  // Pages are sized against the full sheet, so a memo sheet reads as the smaller thing it is.
  const baseScale = Math.min(1.15, Math.max(0.3, (width - 48 - cardRoom) / 1000));
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
  /** Gaps this page has not answered yet: an accepted note on the page is what settles a gap. */
  const unansweredGaps = unanswered(suggestions.gaps, currentPage?.items ?? []);
  /** Notes of this page the AI judged wrong — shown only to their author, with the explanation. */
  const disputed = (suggestions.data?.own ?? []).filter((o) => o.state === 'disputed');
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

  // ---------- co-owned notes: pull completed strokes from classmates and show who is here
  useEffect(() => {
    if (notebook?.kind !== 'group') return;
    let stopped = false;
    const sync = async () => {
      try {
        const list = await api<{ id: string; revision: number }[]>(`/api/notebooks/${notebook.id}/status`);
        const ids = new Set(list.map((s) => s.id));
        for (const id of ids) addedPages.current.delete(id);
        const removed = pagesRef.current.filter(
          (p) => !ids.has(p.id) && !addedPages.current.has(p.id) && !dirty.current.has(p.id) && !inflight.current.has(p.id),
        );
        if (removed.length) {
          const gone = new Set(removed.map((p) => p.id));
          for (const id of gone) bases.current.delete(id);
          const remaining = pagesRef.current.filter((p) => !gone.has(p.id));
          pagesRef.current = remaining;
          setPages((ps) => ps.filter((p) => !gone.has(p.id)));
          setSaveState((m) => {
            const n = { ...m };
            for (const id of gone) delete n[id];
            return n;
          });
          setCurrent((c) => (c && gone.has(c) ? (remaining[0]?.id ?? null) : c));
          setSelection((s) => (s && gone.has(s.pageId) ? null : s));
          setOpenGap(null);
          onToast('A classmate deleted a page. The notebook has been refreshed.');
        }
        for (const s of list) {
          if (stopped) return;
          const local = pagesRef.current.find((p) => p.id === s.id);
          if (local && (dirty.current.has(s.id) || inflight.current.has(s.id))) continue;
          if (local && s.revision <= local.revision) continue;
          const page = await api<EditorPage>(`/api/pages/${s.id}`);
          if (stopped) return;
          bases.current.set(s.id, { strokes: page.strokes, items: page.items });
          const applyPage = (ps: EditorPage[]) => {
            const exists = ps.some((p) => p.id === page.id);
            return (exists ? ps.map((p) => (p.id === page.id ? { ...p, ...page } : p)) : [...ps, page]).sort((a, b) => a.position - b.position);
          };
          setPages(applyPage);
          pagesRef.current = applyPage(pagesRef.current);
        }
      } catch {
        /* transient */
      }
    };
    const t = window.setInterval(sync, 2500);
    sync();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [notebook?.id, notebook?.kind, onToast]);
  useEffect(() => {
    if (notebook?.kind !== 'group') return;
    const beat = () => api(`/api/notebooks/${notebook.id}/presence`, { method: 'POST', json: { pageId: current } }).catch(() => {});
    beat();
    const t = window.setInterval(beat, 10000);
    return () => clearInterval(t);
  }, [notebook?.id, notebook?.kind, current]);
  useEffect(() => {
    if (notebook?.kind !== 'group') return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api<typeof presence>(`/api/notebooks/${notebook.id}/presence`);
        if (!stopped) setPresence(next);
      } catch {
        /* transient */
      }
    };
    const t = window.setInterval(tick, 5000);
    tick();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [notebook?.id, notebook?.kind]);
  // The professor's current page is what students see; a page change is part of the handout.
  useEffect(() => {
    if (!live?.id || !current) return;
    api(`/api/live/${live.id}`, { method: 'PATCH', json: { pageId: current } }).catch(() => {});
  }, [live?.id, current]);

  // ---------- actions
  const selectionAction = (action: 'ask' | 'delete') => {
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
    setLasso({ pageId: page.id, bbox });
  };

  /**
   * A suggestion merges into the page as a quoted note, not a card on top of it: it is written into
   * the space just below everything already on the sheet, in the page's own writing column, so it
   * never covers the slide or the student's ink, and reads as part of the page.
   */
  const addAnnotation = (
    pid: string,
    a: { title: string; body: string; source: Suggestion['source']; citations: Citation[] },
    near?: [number, number, number, number] | null,
    gap?: { id: string | null; missing: string | null },
  ) => {
    const page = pagesRef.current.find((p) => p.id === pid);
    if (!page) return;
    const col = writingColumn(page.width, page.height, page.kind);
    const w = Math.min(440, col.right - col.left);
    const estimate = (yy: number) => itemBox({ type: 'annotation', id: '', x: col.left, y: yy, w, title: a.title, body: a.body, source: a.source, citations: [] })[3];
    // The student's own ink is a thing to avoid too, not just the boxes on the page.
    const inkBottom = page.strokes.reduce((b, s) => Math.max(b, strokeBounds(s)[3]), 0);
    const nearY = near ? near[1] * page.height : col.top;
    // Where the student stopped is the anchor; the block goes below it, below their writing, and
    // below anything else already there, so it never covers the slide or their own words.
    let y = Math.round(Math.max(col.top, nearY + 16, inkBottom + 14));
    for (const it of page.items) {
      const b = itemBox(it);
      if (b[1] < y && b[3] > y - 24) y = Math.max(y, Math.round(b[3] + 12));
    }
    // Keep the whole block on the sheet.
    y = Math.max(8, Math.min(y, page.height - (estimate(y) - y) - 12));
    const item: Item = {
      id: uid(),
      type: 'annotation',
      x: col.left,
      y,
      w,
      title: a.title,
      body: a.body,
      source: a.source,
      citations: a.citations,
      gapId: gap?.id ?? null,
      forGap: gap?.missing || null,
    };
    commit(pid, page.strokes, [...page.items, item]);
    const where = pid === current ? 'below your notes' : page.kind === 'slide' ? `on Slide ${page.position}` : 'on that page';
    onToast(`Added ${where}. Drag it anywhere, or Ctrl+Z to undo.`);
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

  const leaveEditor = async () => {
    await saveAll();
    if (live) await api(`/api/live/${live.id}/end`, { method: 'POST' }).catch(() => {});
    await closeNotebook();
    onBack(notebook?.courseId);
  };
  const endLive = async () => {
    if (!live) return;
    try {
      // The snapshot must include the last stroke, not the page as it was 700 ms ago.
      await saveAll();
      await api(`/api/live/${live.id}/end`, { method: 'POST' });
      setLive(null);
      onToast('Live ended. Students can find their copy in their course files.');
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  const fetchUpdates = async () => {
    if (!notebook) return;
    setFetching(true);
    try {
      await saveAll();
      const r = await api<{ synced: boolean; reason?: string }>(`/api/notebooks/${notebook.id}/fetch`, { method: 'POST' });
      await load();
      onToast(r.synced ? `Updated from ${notebook.share?.fromName ?? 'the source'}.` : r.reason === 'source-deleted' ? 'The source note is gone; this is now your copy.' : 'Nothing new to fetch.');
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setFetching(false);
    }
  };
  const keepSnapshot = async () => {
    if (!notebook) return;
    try {
      await api(`/api/notebooks/${notebook.id}/detach`, { method: 'POST' });
      await load();
      onToast('This copy will stay as it is now.');
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const reportSuggestion = async (g: Suggestion) => {
    if (!g.entryId) return;
    await api(`/api/entries/${g.entryId}/report`, { method: 'POST', json: { reason: '' } }).catch(() => {});
    onToast('Thanks — that suggestion is hidden while it is checked.');
  };

  const insertPage = async (after: string | null, kind?: PaperKind) => {
    try {
      const page = await api<EditorPage>(`/api/notebooks/${notebookId}/pages`, { method: 'POST', json: { after, kind } });
      bases.current.set(page.id, { strokes: page.strokes, items: page.items });
      addedPages.current.add(page.id);
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
  /** Changing one sheet's paper keeps what is written on it; only the ruling underneath changes. */
  const setPagePaper = async (pid: string, kind: PaperKind) => {
    try {
      const { width, height } = await api<{ width: number; height: number }>(`/api/pages/${pid}/paper`, { method: 'PATCH', json: { kind } });
      setPages((ps) => ps.map((p) => (p.id === pid ? { ...p, kind, width, height } : p)));
      onToast(`This page is now ${paperName(kind).toLowerCase()}.`);
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
    <div className={`editor ${panelOpen ? 'panel-open' : ''}`}>
      <header className="editor-top">
        <button className="icon-btn" onClick={leaveEditor} title="Back to course" aria-label="Back to course">
          <ChevronLeft size={19} />
        </button>
        {boot.course?.id === notebook.courseId && (
          <button className="course-badge as-link" onClick={leaveEditor} title={boot.course.name}>
            {boot.course.code}
          </button>
        )}
        <button className="icon-btn" onClick={() => setShowThumbs((v) => !v)} title="Pages" aria-label="Toggle page thumbnails">
          <PanelLeft size={18} />
        </button>
        <input className="nb-title" defaultValue={notebook.title} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state s-${overall}`}>{{ saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved — retrying' }[overall]}</span>
        {notebook.kind === 'group' && (
          <div className="presence-stack" aria-label="People in this group note">
            {presence
              .filter((p) => p.studentId !== getStudent())
              .slice(0, 3)
              .map((p) => (
                <span key={p.studentId} className="avatar presence-avatar" style={{ background: p.color }} title={`${p.name}${p.pageId ? ` · page ${pages.findIndex((x) => x.id === p.pageId) + 1}` : ''}`}>
                  {p.initials}
                </span>
              ))}
            {presence.filter((p) => p.studentId !== getStudent()).length > 3 && <span className="presence-more">+{presence.filter((p) => p.studentId !== getStudent()).length - 3}</span>}
          </div>
        )}
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
        <button
          className="btn ghost share-btn"
          onClick={async () => {
            await saveAll();
            setSharing('copy');
          }}
          title="Send a copy, invite co-editors, or go live"
        >
          <Share2 size={15} aria-hidden /> Share
        </button>
        {demoFeedback && (
          <button
            type="button"
            className={`btn ghost panel-toggle ${demoPanelOpen ? 'active' : ''}`}
            onClick={() => setDemoPanelOpen((open) => !open)}
            aria-expanded={demoPanelOpen}
          >
            Save me!
          </button>
        )}
        {!demoLecture && (
          <button
            className={`btn ghost panel-toggle ${panel.open ? 'active' : ''}`}
            onClick={() => {
              if (!panel.open) setPanelTab('ask');
              setPanel((p) => ({ ...p, open: !p.open }));
            }}
            aria-expanded={panel.open}
            title={panel.open ? 'Hide Ask and suggestions' : 'Ask about this page, and see suggestions'}
          >
            {panel.open ? '✕ Ask' : '✦ Ask'}
          </button>
        )}
      </header>
      {live && (
        <div className="live-banner">
          <span className="live-dot" />
          <b>Live to the class</b>
          <span>{live.audience} {live.audience === 1 ? 'student' : 'students'} in the class.</span>
          <div className="spacer" />
          <button className="btn small ghost" onClick={endLive}>End live</button>
        </div>
      )}
      {notebook.share && (
        <div className={`share-banner ${notebook.share.sourceDeleted ? 'warn' : ''}`}>
          <b>From {notebook.share.fromName}</b>
          <span>
            {notebook.share.sourceDeleted
              ? 'The source note is gone; this is now your copy.'
              : notebook.share.mode === 'pull'
                ? notebook.share.updatesAvailable
                  ? 'The source has newer changes.'
                  : 'Pullable: you can fetch later changes.'
                : 'Snapshot: this copy will not change.'}
          </span>
          <div className="spacer" />
          {notebook.share.mode === 'pull' && notebook.share.updatesAvailable && (
            <button className="btn small" disabled={fetching || overall !== 'saved'} onClick={fetchUpdates}>{fetching ? 'Fetching…' : 'Fetch updates'}</button>
          )}
          {notebook.share.mode === 'pull' && <button className="btn small ghost" onClick={keepSnapshot}>Keep a snapshot</button>}
        </div>
      )}
      {notebook.kind === 'group' && (
        <div className="share-banner group">
          <b>Group note</b>
          <span>{notebook.memberCount ?? 1} {(notebook.memberCount ?? 1) === 1 ? 'member' : 'members'} · everyone can write and edit. AI suggestions stay in individual notes.</span>
          <div className="spacer" />
          <button
            className="btn small ghost"
            onClick={async () => {
              await saveAll();
              setSharing('group');
            }}
          >
            Members & invites
          </button>
        </div>
      )}
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
              + {paperName(notebook.paper)} page
            </button>
          </aside>
        )}
        <main
          className={`canvas-scroll ${openGap ? 'card-open' : ''}`}
          ref={scroller}
          onPointerDown={(e) => e.target === e.currentTarget && setSelection(null)}
          onPointerDownCapture={(e) => {
            const id = (e.target as HTMLElement).closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
            if (id && id !== current) (setCurrent(id), (scrollLock.current = Date.now() + 1500));
          }}
        >
          {pages.map((p) => {
            const pScale = scale;
            return (
            <section key={p.id} className={`page-slot ${openGap && p.id === current ? 'gap-open' : ''}`} data-page-id={p.id} style={{ width: p.width * pScale }}>
              <PageChrome
                page={p}
                index={pageIndex.get(p.id)! + 1}
                saveState={saveState[p.id]}
                onInsert={(kind) => insertPage(p.id, kind)}
                onPaper={(kind) => setPagePaper(p.id, kind)}
                onDelete={() => deletePage(p.id)}
                onClassmates={() => (goto(p.id), setPanelTab('suggestions'), setPanel({ open: true }))}
                onLink={(l, s) => setLink(p.id, l, s)}
                allowSlideDelete={notebook.kind === 'shared' || notebook.kind === 'group'}
              />
              <div className="page-with-margin">
                {/* Quiet by default: one inline suggestion per page, in the writing column, with an accept button. */}
                {p.id === current && disputed.length > 0 && (
                  <div className="margin-markers" style={{ height: p.height * pScale }}>
                    <button
                      className="gap-marker disputed"
                      style={{ top: 12 * pScale }}
                      onClick={() => (goto(p.id), setPanelTab('suggestions'), setPanel({ open: true }), onToast(disputed[0]!.disputeExplanation ?? 'One of your notes is being checked.'))}
                      title={disputed[0]!.disputeExplanation ?? 'One of your notes is being checked'}
                      aria-label="A note on this page is being checked"
                    >
                      <span />
                    </button>
                  </div>
                )}
                <LazyPage height={p.height * pScale} root={scroller}>
                  <PageView
                    page={p}
                    scale={pScale}
                    tool={tool}
                    selection={selection}
                    setSelection={setSelection}
                    editingText={editingText}
                    setEditingText={setEditingText}
                    commit={commit}
                    onCreateText={(item) => {
                      const latest = pagesRef.current.find((page) => page.id === p.id);
                      if (latest) commit(p.id, latest.strokes, [...latest.items, item]);
                    }}
                    onDraftItem={(itemId, text) => draftItem(p.id, itemId, text)}
                    onSelectionAction={selectionAction}
                    onCitation={setSource}
                  />
                </LazyPage>
                {/* The top unanswered suggestion for this page, written into the page at its gap. */}
                {p.id === current && !openGap && unansweredGaps.length > 0 && !editingText && (
                  <InlineGhost
                    key={unansweredGaps[ghostIndex % unansweredGaps.length]!.id}
                    page={p}
                    scale={pScale}
                    suggestion={unansweredGaps[ghostIndex % unansweredGaps.length]!}
                    index={ghostIndex % unansweredGaps.length}
                    total={unansweredGaps.length}
                    onAdd={(s) => {
                      addAnnotation(p.id, { title: s.title || s.missing, body: s.body, source: s.source, citations: s.citations }, s.bbox, { id: s.id, missing: s.missing });
                      setGhostIndex(0);
                    }}
                    onNotNow={(s) => {
                      // Escape or "Not now": away for this visit, nothing remembered.
                      suggestions.hideForNow(s.id);
                      setGhostIndex(0);
                    }}
                    onDismiss={(s) => {
                      suggestions.dismiss(s);
                      setGhostIndex(0);
                    }}
                    onDetails={(s) => (goto(p.id), setOpenGap({ id: s.id, snapshot: s }))}
                  />
                )}
                {openGap && p.id === current && (
                  <div
                    className={`gap-card ${width - 48 - p.width * pScale < 380 ? 'flipped' : ''}`}
                    style={{ top: Math.max(0, (suggestions.gaps.find((g) => g.id === openGap.id) ?? openGap.snapshot).bbox[1] * p.height) * pScale }}
                  >
                    <SuggestionCard
                      key={openGap.id}
                      suggestion={suggestions.gaps.find((g) => g.id === openGap.id) ?? openGap.snapshot}
                      onAdd={(s) => {
                        addAnnotation(p.id, { title: s.title || s.missing, body: s.body, source: s.source, citations: s.citations }, s.bbox, {
                          id: s.id,
                          missing: s.missing,
                        });
                        setOpenGap(null);
                      }}
                      onDismiss={(s) => {
                        suggestions.dismiss(s);
                        setOpenGap(null);
                      }}
                      onCitation={setSource}
                      onReport={(s) => {
                        reportSuggestion(s);
                        setOpenGap(null);
                      }}
                      onClose={() => setOpenGap(null)}
                    />
                  </div>
                )}
              </div>
            </section>
            );
          })}
          <div className="canvas-end">
            <button className="btn ghost" onClick={() => insertPage(pages.at(-1)?.id ?? null)}>
              + {paperName(notebook.paper)} page
            </button>
          </div>
        </main>
        <div className={`zoom-float ${panelOpen ? 'with-panel' : ''}`} role="group" aria-label="Zoom">
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
        {demoFeedback && demoPanelOpen && (
          <DemoFeedback
            slide={currentPage?.kind === 'slide' ? currentPage.link.slidePage ?? null : null}
            commonConfusionOnly={notebook.studentId === 'thomas'}
            onGoToSlide={(slide) => {
              const target = pages.find((page) => page.kind === 'slide' && page.link.slidePage === slide);
              if (target) pickPage(target.id);
            }}
            onClose={() => setDemoPanelOpen(false)}
          />
        )}
        {!demoLecture && panel.open && currentPage && (
          <SuggestionsPanel
            page={currentPage}
            notebook={notebook}
            pageNumber={pageIndex.get(currentPage.id)! + 1}
            gaps={suggestions.gaps}
            own={suggestions.data?.own ?? []}
            unlinked={suggestions.data?.unlinked ?? false}
            onClose={() => setPanel((p) => ({ ...p, open: false }))}
            onScrollTo={(g) => {
              setOpenGap({ id: g.id, snapshot: g });
              goto(currentPage.id);
            }}
            onGoToPage={(pid) => {
              // Jumping to a page closes the card so the target page's own ghost is what shows.
              setOpenGap(null);
              setCurrent(pid);
              goto(pid);
            }}
            onAdd={addAnnotation}
            onCitation={setSource}
            onDismiss={suggestions.dismiss}
            onReport={reportSuggestion}
            tab={panelTab}
            onTab={setPanelTab}
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
      {sharing && (
        <ShareDialog
          notebook={notebook}
          pageId={current}
          initialTab={sharing}
          onClose={() => setSharing(null)}
          onToast={onToast}
          onChanged={load}
          onBeforeChange={saveAll}
          onStartedLive={(s) => setLive(s)}
          onLeft={() => {
            setSharing(null);
            onBack(notebook.courseId);
          }}
        />
      )}
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
    // The observer can miss the first callback on a narrow viewport, which left the page blank
    // until the student scrolled. Decide once from the current layout, then let the observer take over.
    const rootEl = root.current;
    const rect = el.getBoundingClientRect();
    const view = rootEl ? rootEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (rect.bottom > view.top - 1500 && rect.top < view.bottom + 1500) setVisible(true);
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

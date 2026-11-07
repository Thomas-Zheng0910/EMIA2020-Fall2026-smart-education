import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus } from 'lucide-react';
import type { CourseFiles, Deck, Folder, Lecture, Notebook, PaperKind } from '../shared/types';
import type { LibView } from './App';
import { Dialog, ago } from './Home';
import { ShareDialog } from './ShareDialog';
import { PAPERS, paperName } from './paper';
import { api, upload } from './api';
import { useBoot } from './boot';
import { useEscape } from './ui';
import { useFileDrop, usePressGestures, type FileTarget } from './gestures';

type Nav = { course?: string; view?: LibView; folder?: string | null };
type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean; keep?: boolean };
type MenuState = { x: number; y: number; title?: string; items: MenuItem[] };
type Editing = { kind: 'create'; parentId: string | null } | { kind: 'rename'; id: string } | null;
/** A file on a page of the tree: one of the student's notebooks, or a deck they have not opened. */
type FileRef = { notebookId?: string; deck?: Deck };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const CHIP_COLORS = ['#2f5d7c', '#0c6b6b', '#5f4b8b', '#b05a2a', '#3b7a57', '#a8435f', '#2b5d8a', '#6b4e8e'];
const chipColor = (code: string) => CHIP_COLORS[[...code].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % CHIP_COLORS.length];

/** A course is not a folder: it is something you join, and it decides which classmates your notes connect with. */
function Chip({ code, big }: { code: string; big?: boolean }) {
  return (
    <span className={`lib-chip ${big ? 'big' : ''}`} style={{ background: chipColor(code) }} aria-hidden>
      {code.replace(/^[A-Za-z]+/, '') || code.slice(0, 4)}
    </span>
  );
}
const Icon = {
  notes: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M1.8 3.8h4l1.2 1.4h7.2v7.3H1.8z" />
      <path d="M5 9.2h6" />
    </svg>
  ),
  lectures: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M1.8 3.8h4l1.2 1.4h7.2v7.3H1.8z" />
      <path d="M6.5 8v3l2.6-1.5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M1.8 3.8h4l1.2 1.4h7.2v7.3H1.8z" />
    </svg>
  ),
  bigFolder: (
    <svg viewBox="0 0 34 34" fill="currentColor" aria-hidden>
      <path d="M2 7.5a2 2 0 0 1 2-2h8.5l2.6 3H30a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
    </svg>
  ),
  sidebar: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M8 3.5v13" />
    </svg>
  ),
};

/**
 * A course's library: one free file tree per course, with smart views above it. Built for tablets
 * first: long-press for menus, long-press and drag to file notes, PDFs added by dropping them in.
 * Lecture decks are one shared record each; a student's own copy holds only their edits.
 */
export function Library({
  view,
  folder,
  onNavigate,
  onHome,
  onOpen,
  onToast,
}: {
  view: LibView;
  folder: string | null;
  onNavigate: (r: Nav) => void;
  onHome: () => void;
  onOpen: (id: string) => void;
  onToast: (m: string) => void;
}) {
  const { course, courses, enrolled, lectures, reload } = useBoot();
  const [files, setFiles] = useState<CourseFiles | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([`course:${course?.id}`]));
  const [sideOpen, setSideOpen] = useState(false);
  const [newNb, setNewNb] = useState<{ folderId: string | null } | null>(null);
  const [hint, setHint] = useState<FileTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Notebook | null>(null);
  const [slots, setSlots] = useState<{ toggle: HTMLElement | null; crumbs: HTMLElement | null }>({ toggle: null, crumbs: null });

  useEffect(() => setSlots({ toggle: document.getElementById('lib-toggle-slot'), crumbs: document.getElementById('lib-crumb-slot') }), []);
  const load = useCallback(
    () => (course ? api<CourseFiles>(`/api/courses/${course.id}/files`).then(setFiles).catch((e) => onToast(e.message)) : Promise.resolve()),
    [course, onToast],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!lectures.some((l) => l.status === 'rendering' || l.status === 'digesting')) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [lectures, reload]);

  // ---------- derived
  const folders = files?.folders ?? [];
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const fid = folder && folderById.has(folder) ? folder : null;
  const notes = files?.notes ?? [];
  const decks = files?.decks ?? [];
  const deckByNotebook = new Map(decks.filter((d) => d.notebookId).map((d) => [d.notebookId!, d]));
  const placeOf = (n: Notebook) => (n.folderId && folderById.has(n.folderId) ? n.folderId : null);
  const notesIn = (f: string | null) => notes.filter((n) => placeOf(n) === f);
  /** Decks still sitting where the course put them; a deck the student moved is filed like a note. */
  const decksIn = (f: string | null) => decks.filter((d) => (d.folderId && folderById.has(d.folderId) ? d.folderId : null) === f);
  const subfolders = (p: string | null) => folders.filter((f) => (f.parentId ?? null) === p);
  const pathTo = (f: string | null) => {
    const out: Folder[] = [];
    for (let cur = f ? folderById.get(f) : undefined; cur; cur = cur.parentId ? folderById.get(cur.parentId) : undefined) out.unshift(cur);
    return out;
  };
  /** What a place is called in a toast or a "Move to" row: a folder's name, or the top of the tree. */
  const placeName = (f: string | null) => (f ? folderById.get(f)?.name ?? 'the top level' : 'the top level');
  const lectureById = new Map(lectures.map((l) => [l.id, l]));
  const written = (n: Notebook) => (n.written ?? 0) > 0;
  type FileRow = { at: string | null; deck: Deck | null; note: Notebook | null };
  /**
   * Decks read as a course sequence, so they sort by lecture number rather than by when they were
   * last touched; the student's own notes come after them, newest first.
   */
  const order = (rows: FileRow[]) =>
    [...rows].sort((a, b) => {
      if (a.deck && b.deck) return a.deck.number - b.deck.number;
      if (a.deck !== b.deck) return a.deck ? -1 : 1;
      return (b.at ?? '').localeCompare(a.at ?? '');
    });
  const pair = (d: Deck[] | undefined, n: Notebook[]) =>
    order([
      ...(d ?? []).map((x) => ({ at: x.updatedAt, deck: x, note: null }) as FileRow),
      ...n.map((x) => ({ at: x.updatedAt, deck: null, note: x }) as FileRow),
    ]);
  /** Everything on one page of the tree: the decks, then the student's own files. */
  const filesIn = (f: string | null) => pair(decksIn(f), notesIn(f));
  /** "My notes" is a filter, not a folder: files with the student's ink or text. */
  // A group note is a shared workspace from the moment it is created; it belongs in My notes even
  // before anyone writes on it. A received copy with only the sender's ink also counts as written.
  const writtenFiles = pair(decks.filter((d) => d.written > 0), notes.filter((n) => n.kind === 'group' || written(n)));
  const allFiles = pair(decks, notes);
  /** A folder's line in the sidebar: how much is in it, subfolders included. */
  const countIn = (f: string): number => subfolders(f).reduce((n, s) => n + countIn(s.id), 0) + notesIn(f).length + decksIn(f).length;
  const expand = (...keys: (string | null)[]) => setExpanded((s) => new Set([...s, ...(keys.filter(Boolean) as string[])]));
  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  useEffect(() => {
    if (fid) expand('course', ...pathTo(fid).map((f) => f.parentId));
  }, [fid, folders]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- actions
  const nav = (r: Nav) => {
    setSideOpen(false);
    onNavigate(r);
  };
  const goFolder = (f: string | null) => nav(f ? { view: 'folder', folder: f } : { view: 'course' });
  const fail = (e: unknown) => onToast((e as Error).message);
  const startCreate = (parentId: string | null) => {
    expand('course', parentId);
    setEditing({ kind: 'create', parentId });
    setSideOpen(true);
  };
  const createFolder = async (parentId: string | null, name: string) => {
    try {
      const f = await api<Folder>('/api/folders', { method: 'POST', json: { name, parentId } });
      expand('course', parentId);
      await load();
      goFolder(f.id);
    } catch (e) {
      fail(e);
    }
  };
  const renameFolder = async (id: string, name: string) => {
    try {
      await api(`/api/folders/${id}`, { method: 'PATCH', json: { name } });
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const deleteFolder = async (f: Folder) => {
    try {
      await api(`/api/folders/${f.id}`, { method: 'DELETE' });
      onToast(`Deleted “${f.name}”. Its files moved to ${placeName(f.parentId)}.`);
      if (fid && pathTo(fid).some((x) => x.id === f.id)) goFolder(f.parentId);
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const moveNote = async (id: string, to: string | null) => {
    setFiles((c) => (c ? { ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, folderId: to } : n)) } : c));
    try {
      await api(`/api/notebooks/${id}`, { method: 'PATCH', json: { folderId: to } });
      onToast(`Moved to ${placeName(to)}`);
    } catch (e) {
      fail(e);
    }
    load();
  };
  /** A deck the student has not opened is filed without copying its slides: their copy is made empty. */
  const moveDeck = async (d: Deck, to: string | null) => {
    setFiles((c) => (c ? { ...c, decks: c.decks.map((x) => (x.lectureId === d.lectureId ? { ...x, folderId: to } : x)) } : c));
    try {
      await api(`/api/lectures/${d.lectureId}`, { method: 'PATCH', json: { folderId: to } });
      onToast(`Moved to ${placeName(to)}`);
    } catch (e) {
      fail(e);
    }
    load();
  };
  const removeNotebook = async (n: Notebook) => {
    if (!confirm(`Delete “${n.title}” and all its pages?`)) return;
    await api(`/api/notebooks/${n.id}`, { method: 'DELETE' }).catch(fail);
    load();
  };
  const openDeck = async (d: Deck) => {
    if (d.notebookId) return onOpen(d.notebookId);
    try {
      onOpen((await api<{ id: string }>(`/api/notebooks/lecture/${d.lectureId}`, { method: 'POST' })).id);
    } catch (e) {
      fail(e);
    }
  };
  const importFiles = async (files: File[], dest: { kind: 'lectures' } | { kind: 'notes'; folderId: string | null }) => {
    const pdfs = files.filter(isPdf);
    if (!pdfs.length) return onToast('Only PDF files can be added.');
    for (const f of pdfs) {
      setBusy(`Adding ${f.name}…`);
      try {
        if (dest.kind === 'lectures') await upload('/api/lectures', f);
        else await upload('/api/notebooks/import', f, dest.folderId ? { folderId: dest.folderId } : {});
      } catch (e) {
        setBusy(null);
        return fail(e);
      }
    }
    setBusy(null);
    const what = pdfs.length === 1 ? `“${pdfs[0]!.name.replace(/\.pdf$/i, '')}”` : `${pdfs.length} PDFs`;
    if (dest.kind === 'lectures') {
      reload();
      onToast(`Added ${what} to Lectures. Slides are being prepared for Explain and Quiz.`);
    } else {
      await load();
      onToast(`Added ${what} to ${placeName(dest.folderId)}.`);
    }
  };

  // ---------- menus (long-press with a finger or pen, right-click with a mouse)
  const folderMenu = (parent: string | null, withEdit: boolean): MenuState['items'] => {
    const f = parent ? folderById.get(parent) : null;
    return [
      { label: parent ? 'New folder inside' : 'New folder', run: () => startCreate(parent) },
      { label: parent ? 'New notebook here' : 'New notebook', run: () => setNewNb({ folderId: parent }) },
      ...(f && withEdit
        ? [
            { label: 'Rename', run: () => (expand('course', ...pathTo(f.id).map((x) => x.parentId)), setEditing({ kind: 'rename', id: f.id }), setSideOpen(true)) },
            { label: 'Delete folder', danger: true, run: () => deleteFolder(f) },
          ]
        : []),
    ];
  };
  const moveMenu = (file: FileRef, x: number, y: number) => {
    const here = file.deck
      ? (file.deck.folderId && folderById.has(file.deck.folderId) ? file.deck.folderId : null)
      : placeOf(notes.find((n) => n.id === file.notebookId)!);
    const rows: { id: string | null; name: string; depth: number }[] = [{ id: null, name: 'Top level', depth: 0 }];
    const walk = (p: string | null, depth: number) =>
      subfolders(p).forEach((f) => {
        rows.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      });
    walk(null, 1);
    const put = (to: string | null) => (file.deck ? moveDeck(file.deck, to) : moveNote(file.notebookId!, to));
    setMenu({
      x,
      y,
      title: 'Move to',
      items: rows.map((r) => ({ label: `${'\u2003'.repeat(r.depth)}${r.id === here ? '✓ ' : ''}${r.name}`, disabled: r.id === here, run: () => put(r.id) })),
    });
  };
  const paperMenu = (n: Notebook, x: number, y: number) =>
    setMenu({
      x,
      y,
      title: 'Paper for new pages',
      items: PAPERS.map((p) => ({
        label: `${n.paper === p.kind ? '✓ ' : ''}${p.name} — ${p.use.toLowerCase()}`,
        disabled: n.paper === p.kind,
        run: () => setPaper(n.id, p.kind),
      })),
    });
  const setPaper = async (id: string, paper: PaperKind) => {
    setFiles((c) => (c ? { ...c, notes: c.notes.map((n) => (n.id === id ? { ...n, paper } : n)) } : c));
    try {
      await api(`/api/notebooks/${id}/paper`, { method: 'PATCH', json: { paper } });
      onToast(`New pages in this notebook will be ${paperName(paper).toLowerCase()}.`);
    } catch (e) {
      fail(e);
      load();
    }
  };
  const openMenu = (el: HTMLElement, x: number, y: number) => {
    // An opened deck is a notebook in the tree, but its menu is the deck's: the slides are the course's.
    const deck = decks.find((d) => d.lectureId === (el.dataset.deck ?? deckByNotebook.get(el.dataset.note ?? '')?.lectureId));
    if (deck) {
      return setMenu({
        x,
        y,
        title: `L${deck.number} · ${deck.title}`,
        items: [
          { label: 'Open', run: () => openDeck(deck) },
          { label: 'Move to…', keep: true, run: () => moveMenu({ deck }, x, y) },
        ],
      });
    }
    const noteId = el.dataset.note;
    if (noteId) {
      const n = notes.find((x) => x.id === noteId);
      if (!n) return;
      return setMenu({
        x,
        y,
        title: n.title,
        items: [
          { label: 'Open', run: () => onOpen(n.id) },
          { label: n.kind === 'group' ? 'Share and members…' : 'Share…', run: () => setSharing(n) },
          { label: 'Paper for new pages', keep: true, run: () => paperMenu(n, x, y) },
          { label: 'Move to…', keep: true, run: () => moveMenu({ notebookId: n.id }, x, y) },
          ...(n.kind === 'group' && n.role !== 'owner' ? [] : [{ label: 'Delete notebook', danger: true, run: () => removeNotebook(n) }]),
        ],
      });
    }
    const ctx = el.dataset.ctx ?? '';
    if (ctx === 'area' && view !== 'notes' && view !== 'all') setMenu({ x, y, items: folderMenu(fid, false) });
    if (ctx.startsWith('folder:')) {
      const f = folderById.get(ctx.slice(7));
      if (f) setMenu({ x, y, title: f.name, items: folderMenu(f.id, true) });
    }
    if (ctx === 'course') setMenu({ x, y, title: course?.code, items: folderMenu(null, false) });
  };

  // ---------- drag a file onto a folder; drop PDFs from outside
  const verdict = (noteId: string, target: string): 'ok' | 'same' | 'blocked' => {
    if (!target.startsWith('f:')) return 'blocked';
    const to = target.slice(2) || null;
    const deck = decks.find((d) => d.lectureId === noteId);
    if (deck) return (deck.folderId && folderById.has(deck.folderId) ? deck.folderId : null) === to ? 'same' : 'ok';
    const n = notes.find((x) => x.id === noteId);
    return n && placeOf(n) === to ? 'same' : 'ok';
  };
  usePressGestures({
    onMenu: openMenu,
    canDrop: verdict,
    onDrop: (id, target) => {
      const to = target.slice(2) || null;
      const deck = decks.find((d) => d.lectureId === id);
      return deck ? moveDeck(deck, to) : moveNote(id, to);
    },
    onBlocked: () => onToast('Files stay in their own course.'),
    onDragChange: (d) => d && setMenu(null),
  });
  /** A PDF dropped into the course's own Lectures folder becomes official slides for everyone. */
  const isLecturesFolder = (f: string | null) => Boolean(f && f === files?.lecturesFolderId);
  useFileDrop((el) => {
    if (!course) return null;
    const d = el.closest<HTMLElement>('[data-drop]');
    if (d) {
      const t = d.dataset.drop!;
      if (!t.startsWith('f:')) return { el: d, ok: false, label: 'Open that course first', hint: 'Files are added to the course you have open.' };
      const f = t.slice(2) || null;
      // The course's own Lectures folder is where official decks live: a PDF dropped there becomes
      // slides for everyone, not a private notebook. Any other folder takes a personal notebook.
      if (isLecturesFolder(f) && course.myRole === 'instructor')
        return { el: d, ok: true, label: `Add to ${course.code} / ${placeName(f)}`, hint: `Becomes lecture slides for everyone in ${course.code}`, accept: (files) => importFiles(files, { kind: 'lectures' }) };
      return { el: d, ok: true, label: `Add to ${course.code} / ${placeName(f)}`, hint: isLecturesFolder(f) ? 'Only the professor can add official slides; this becomes your own note' : 'Becomes a note you can write on', accept: (files) => importFiles(files, { kind: 'notes', folderId: f }) };
    }
    const c = el.closest<HTMLElement>('.lib-content');
    if (!c) return null;
    if (view === 'notes' || view === 'all') return { el: c, ok: false, label: 'Drop onto a folder', hint: 'Choose where the PDF belongs.' };
    if (isLecturesFolder(fid) && course.myRole === 'instructor')
      return { el: c, ok: true, label: `Add to ${course.code} / ${placeName(fid)}`, hint: `Becomes lecture slides for everyone in ${course.code}`, accept: (files) => importFiles(files, { kind: 'lectures' }) };
    return { el: c, ok: true, label: `Add to ${course.code} / ${placeName(fid)}`, hint: isLecturesFolder(fid) ? 'Only the professor can add official slides; this becomes your own note' : 'Becomes a note you can write on', accept: (files) => importFiles(files, { kind: 'notes', folderId: fid }) };
  }, setHint);

  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!m || !menu) return;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - r.width - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - r.height - 8))}px`;
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  useEscape(() => (setMenu(null), setSideOpen(false)));

  if (!course) return null;
  const summary = courses.find((c) => c.id === course.id);
  const instructor = (course.myRole ?? summary?.myRole) === 'instructor';
  const classmates = Math.max(0, (summary?.memberCount ?? 1) - (instructor ? 0 : 1));
  const mine = courses.filter((c) => enrolled.includes(c.id)).sort((a, b) => a.code.localeCompare(b.code));

  // ---------- sidebar
  const row = (o: {
    level: number;
    icon: ReactNode;
    label: string;
    count?: number;
    sel: boolean;
    onClick: () => void;
    chev?: { open: boolean; key: string } | null;
    drop?: string;
    ctx?: string;
    onAdd?: () => void;
    addLabel?: string;
  }) => (
    <div className="side-item">
      <button
        className={`side-row ${o.sel ? 'sel' : ''}`}
        style={{ paddingLeft: 6 + o.level * 18 }}
        onClick={o.onClick}
        data-drop={o.drop}
        data-ctx={o.ctx}
        aria-current={o.sel ? 'page' : undefined}
      >
        {o.chev ? (
          <span
            className="side-chev"
            data-no-press
            role="button"
            aria-label={o.chev.open ? `Collapse ${o.label}` : `Expand ${o.label}`}
            onClick={(e) => (e.stopPropagation(), toggle(o.chev!.key))}
          >
            {o.chev.open ? '▾' : '▸'}
          </span>
        ) : (
          <span className="side-chev none" />
        )}
        {o.icon}
        <span className="label">{o.label}</span>
        {o.count !== undefined && <span className="count">{o.count}</span>}
      </button>
      {o.onAdd && (
        <button className="side-add" data-no-press onClick={o.onAdd} title={o.addLabel} aria-label={o.addLabel}>
          +
        </button>
      )}
    </div>
  );
  const editRow = (level: number, initial: string, onDone: (name: string | null) => void) => (
    <div className="side-row editing" style={{ paddingLeft: 6 + level * 18 }}>
      <span className="side-chev none" />
      {Icon.folder}
      <NameInput initial={initial} onDone={onDone} />
    </div>
  );
  const folderRows = (parent: string | null, level: number): ReactNode => (
    <ul>
      {subfolders(parent).map((f) => {
        const kids = subfolders(f.id).length > 0 || (editing?.kind === 'create' && editing.parentId === f.id);
        const open = expanded.has(f.id);
        return (
          <li key={f.id}>
            {editing?.kind === 'rename' && editing.id === f.id
              ? editRow(level, f.name, (name) => (setEditing(null), name && name !== f.name && renameFolder(f.id, name)))
              : row({
                  level,
                  icon: Icon.folder,
                  label: f.name,
                  count: countIn(f.id) || undefined,
                  sel: view === 'folder' && fid === f.id,
                  onClick: () => goFolder(f.id),
                  chev: kids ? { open, key: f.id } : null,
                  drop: `f:${f.id}`,
                  ctx: `folder:${f.id}`,
                  onAdd: () => startCreate(f.id),
                  addLabel: `New folder in ${f.name}`,
                })}
            {kids && open && folderRows(f.id, level + 1)}
          </li>
        );
      })}
      {editing?.kind === 'create' && editing.parentId === parent && (
        <li>{editRow(level, '', (name) => (setEditing(null), name && createFolder(parent, name)))}</li>
      )}
    </ul>
  );
  /** The two views above the tree: a filter over every file, and the whole tree flattened. They are not folders. */
  const smartViews = (cur: boolean) => (
    <ul>
      <li>
        {row({
          level: 1,
          icon: Icon.notes,
          label: 'My notes',
          count: cur ? writtenFiles.length : undefined,
          sel: cur && view === 'notes',
          onClick: () => nav({ course: course.id, view: 'notes' }),
        })}
      </li>
      <li>
        {row({
          level: 1,
          icon: Icon.lectures,
          label: 'All files',
          count: cur ? notes.length + decks.length : undefined,
          sel: cur && view === 'all',
          onClick: () => nav({ course: course.id, view: 'all' }),
        })}
      </li>
    </ul>
  );
  const sidebar = (
    <aside className={`lib-side ${sideOpen ? 'open' : ''}`} aria-label="Courses and files">
      <div className="side-label">Courses</div>
      <ul className="side-tree">
        {mine.map((c) => {
          const cur = c.id === course.id;
          const open = cur && expanded.has(`course:${c.id}`);
          // Only the open course has files loaded, so only it can show a tree.
          return (
            <li key={c.id}>
              <button
                className={`side-course ${cur && view === 'course' ? 'sel' : ''}`}
                // Opening the course is what the row does; the chevron is for folding the tree away.
                onClick={() => {
                  if (!cur) return nav({ course: c.id, view: 'course' });
                  nav({ course: c.id, view: 'course' });
                  expand(`course:${c.id}`);
                }}
                title={`${c.code} · ${plural(Math.max(0, c.memberCount - (c.myRole === 'instructor' ? 0 : 1)), c.myRole === 'instructor' ? 'student' : 'classmate')}`}
                data-drop={cur ? 'f:' : `x:${c.id}`}
              >
                {cur ? (
                  <span
                    className="side-chev"
                    data-no-press
                    role="button"
                    aria-label={open ? `Collapse ${c.code}` : `Expand ${c.code}`}
                    onClick={(e) => (e.stopPropagation(), toggle(`course:${c.id}`))}
                  >
                    {open ? '▾' : '▸'}
                  </span>
                ) : (
                  <span className="side-chev none" />
                )}
                <Chip code={c.code} />
                <span className="side-cname">
                  <b>{c.code}</b>
                  <small>{c.name}</small>
                </span>
              </button>
              {open && (
                <div className="side-children">
                  {smartViews(cur)}
                  {folderRows(null, 1)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button className="side-join" onClick={onHome}>
        <span className="plus">+</span>Join a course
      </button>
    </aside>
  );

  // ---------- main area
  const deckPreview = (d: Deck) =>
    d.lastPageId ? `/api/pages/${d.lastPageId}/render.png?w=480` : d.pageCount > 0 ? `/api/assets/lectures/${d.lectureId}/${Math.min(2, d.pageCount)}.png` : null;
  const noteCard = (n: Notebook) => (
    <button key={n.id} className="doc-card" data-note={n.id} onClick={() => onOpen(n.id)} aria-label={n.title}>
      <div className="doc-cover">
        {n.cover ? (
          <img className="doc-page" src={n.cover} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className={`paper-cover paper-cover-${n.paper}`}>
            {/* A new notebook shows the cover it was made with, not an empty white page. */}
            <span className="paper-label">
              <span className="paper-label-title">{n.title}</span>
              <span className="paper-label-meta">{paperName(n.paper)} paper</span>
            </span>
          </div>
        )}
        {n.kind === 'group' && <span className="doc-badge group-badge">Group · {n.memberCount ?? 1}</span>}
        {n.share && <span className="doc-badge share-badge">From {n.share.fromName}</span>}
      </div>
      <div className="doc-meta">
        {n.cover && <b>{n.title}</b>}
        <span>
          {n.kind === 'group'
            ? `${plural(n.memberCount ?? 1, 'member')} · ${plural(n.pageCount, 'page')}`
            : n.share
              ? `${n.share.mode === 'pull' ? 'Pullable' : 'Snapshot'} · ${plural(n.pageCount, 'page')}`
              : `${plural(n.pageCount, 'page')} · ${paperName(n.paper)} · ${ago(n.updatedAt)}`}
        </span>
      </div>
    </button>
  );
  /**
   * A deck is the course's slides plus whatever this student wrote on them. Opening it builds their
   * own pages; until then the card shows the official slide and nothing of their own.
   */
  const deckCard = (d: Deck) => {
    const preview = deckPreview(d);
    return (
      <button
        key={d.lectureId}
        className="doc-card"
        data-deck={d.lectureId}
        disabled={d.status === 'rendering'}
        onClick={() => openDeck(d)}
        aria-label={`Lecture ${d.number}: ${d.title}`}
      >
        <div className="doc-cover from-slides">
          {preview && <img className="doc-slide" src={preview} alt="" loading="lazy" draggable={false} />}
          <span className="doc-badge">L{d.number}</span>
          <span className="pdf-badge">PDF</span>
          {d.written > 0 && (
            <span className="ink-badge" title={`You wrote on ${plural(d.written, 'slide')}`}>
              ✎ {d.written}
            </span>
          )}
        </div>
        <div className="doc-meta">
          <b>{d.title}</b>
          <span>
            {plural(d.pageCount, 'slide')}
            {d.written > 0 ? ` · you wrote on ${d.written}` : ''}
          </span>
          {d.status === 'digesting' && (
            <span className="progress" title="Preparing slides for Explain and Quiz">
              <span style={{ width: `${(100 * (lectureById.get(d.lectureId)?.digested ?? 0)) / Math.max(1, d.pageCount)}%` }} />
            </span>
          )}
          {d.status === 'failed' && (
            <span className="small warn-text" title={lectureById.get(d.lectureId)?.error ?? ''}>
              Some slides couldn’t be prepared
            </span>
          )}
        </div>
      </button>
    );
  };
  const folderTile = (f: Folder) => (
    <button key={f.id} className="folder-tile" data-ctx={`folder:${f.id}`} data-drop={`f:${f.id}`} onClick={() => goFolder(f.id)}>
      {Icon.bigFolder}
      {f.id === files?.sharedFolderId && (files.unreadShares ?? 0) > 0 && <span className="folder-unread" title={`${files!.unreadShares} new shared ${files!.unreadShares === 1 ? 'note' : 'notes'}`} />}
      <span>
        <b>{f.name}</b>
        <span>{plural(countIn(f.id), 'item')}</span>
      </span>
    </button>
  );

  let content: ReactNode;
  const head = (title: string, sub: string, withChip?: boolean, place: string | null = fid) => (
    <header className="lib-head">
      {withChip ? (
        <div className="lib-course-head">
          <Chip code={course.code} big />
          <div>
            <div className="lib-kicker">Course · {course.code}</div>
            <h1 className="lib-title">{title}</h1>
            {course.description && <p className="lib-desc">{course.description}</p>}
            <div className="lib-peers">
              {instructor
                ? classmates === 0
                  ? 'No students have joined yet'
                  : `${plural(classmates, 'student')} in ${course.code}`
                : classmates === 0
                  ? 'No classmates have joined yet'
                  : `${plural(classmates, 'classmate')} in ${course.code}`}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="lib-kicker">{course.code}</div>
          <h1 className="lib-title">{title}</h1>
          <p className="lib-sub">{sub}</p>
        </div>
      )}
      <div className="lib-head-actions">
        <button className="btn ghost" onClick={() => startCreate(place)}>
          <FolderPlus size={15} aria-hidden /> New folder
        </button>
        <button className="btn primary" onClick={() => setNewNb({ folderId: place })}>
          + New notebook
        </button>
      </div>
    </header>
  );
  /** Folders first, then the files in this place — the same order the tree uses. */
  const treeView = (place: string | null) => {
    const subs = subfolders(place);
    const items = filesIn(place);
    return (
      <>
        {subs.length > 0 && <div className="lib-folders">{subs.map(folderTile)}</div>}
        {items.length > 0 && (
          <div className="lib-docs">{items.map((i) => (i.deck ? deckCard(i.deck) : noteCard(i.note!)))}</div>
        )}
        {files && !subs.length && !items.length && (
          <div className="lib-empty">
            <b>{place ? 'This folder is empty' : 'Nothing here yet'}</b>
            <p>Drag files onto this page, or press and hold for a new folder or notebook.</p>
          </div>
        )}
      </>
    );
  };
  if (view === 'folder' && fid) {
    content = (
      <div className="lib-view">
        {head(folderById.get(fid)!.name, 'Drag files onto a folder to file them here.')}
        {treeView(fid)}
      </div>
    );
  } else if (view === 'notes') {
    content = (
      <div className="lib-view">
        {head('My notes', 'Newest first. Every file you have written on, wherever you filed it.')}
        {writtenFiles.length > 0 ? (
          <div className="lib-docs">{writtenFiles.map((i) => (i.deck ? deckCard(i.deck) : noteCard(i.note!)))}</div>
        ) : (
          <div className="lib-empty">
            <b>No notes yet</b>
            <p>Open a lecture and write on a slide, or drop a PDF of your notes anywhere in your files.</p>
          </div>
        )}
      </div>
    );
  } else if (view === 'all') {
    content = (
      <div className="lib-view">
        {head('All files', `Everything in ${course.code}, the official decks included.`, false, null)}
        {allFiles.length > 0 ? (
          <div className="lib-docs">{allFiles.map((i) => (i.deck ? deckCard(i.deck) : noteCard(i.note!)))}</div>
        ) : (
          <div className="lib-empty">
            <b>No files yet</b>
            <p>Official decks and your own notebooks both appear here.</p>
          </div>
        )}
      </div>
    );
  } else {
    content = (
      <div className="lib-view">
        {head(course.name, '', true, null)}
        {treeView(null)}
      </div>
    );
  }

  const path = view === 'folder' ? pathTo(fid) : [];
  const viewName = view === 'notes' ? 'My notes' : view === 'all' ? 'All files' : null;
  const crumbs = (
    <>
      <span className="crumb-sep">/</span>
      {path.length || viewName ? (
        <button className="crumb-link" onClick={() => nav({ view: 'course' })}>
          {course.code}
        </button>
      ) : (
        <span className="crumb-here">{course.code}</span>
      )}
      {viewName && (
        <>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">{viewName}</span>
        </>
      )}
      {path.map((f, i) => (
        <span key={f.id} className="crumb-part">
          <span className="crumb-sep">/</span>
          {i === path.length - 1 ? (
            <span className="crumb-here">{f.name}</span>
          ) : (
            <button className="crumb-link" onClick={() => goFolder(f.id)}>
              {f.name}
            </button>
          )}
        </span>
      ))}
    </>
  );

  return (
    <div className="lib-shell">
      {slots.toggle &&
        createPortal(
          <button className="side-toggle" onClick={() => setSideOpen((v) => !v)} aria-label="Courses and files" aria-expanded={sideOpen}>
            {Icon.sidebar}
          </button>,
          slots.toggle,
        )}
      {slots.crumbs && createPortal(crumbs, slots.crumbs)}
      {sidebar}
      {sideOpen && <div className="lib-scrim" onClick={() => setSideOpen(false)} />}
      <main className="lib-content" data-ctx={view === 'course' || view === 'folder' ? 'area' : undefined}>
        {content}
      </main>
      {menu && (
        <div className="lib-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }}>
          {menu.title && <div className="lib-menu-title">{menu.title}</div>}
          {menu.items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                if (!it.keep) setMenu(null);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
      {(hint || busy) && (
        <div className={`lib-hint ${hint && !hint.ok ? 'no' : ''}`} role="status">
          <b>{busy ?? hint!.label}</b>
          {!busy && hint!.hint && <span>{hint!.hint}</span>}
        </div>
      )}
      {newNb && <NewNotebook folderId={newNb.folderId} onClose={() => setNewNb(null)} onCreated={onOpen} onToast={onToast} />}
      {sharing && <ShareDialog notebook={sharing} onClose={() => setSharing(null)} onToast={onToast} onChanged={load} onLeft={load} />}
    </div>
  );
}

function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit && v.trim() ? v.trim() : null);
  };
  return (
    <input
      autoFocus
      className="side-input"
      value={v}
      maxLength={80}
      placeholder="Folder name"
      aria-label="Folder name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') (e.stopPropagation(), finish(false));
      }}
      onBlur={() => finish(true)}
    />
  );
}

function NewNotebook({ folderId, onClose, onCreated, onToast }: { folderId: string | null; onClose: () => void; onCreated: (id: string) => void; onToast: (m: string) => void }) {
  const [title, setTitle] = useState('');
  const [paper, setPaper] = useState<PaperKind>('ruled');
  const create = async () => {
    try {
      onCreated((await api<{ id: string }>('/api/notebooks', { method: 'POST', json: { title: title.trim() || 'Untitled notebook', paper, folderId } })).id);
    } catch (e) {
      onToast((e as Error).message);
    }
  };
  return (
    <Dialog title="New notebook" onClose={onClose} wide>
      <input autoFocus className="input" placeholder="e.g. Revision — neural networks" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      <div className="paper-choice" role="radiogroup" aria-label="Paper">
        {PAPERS.map((p) => (
          <button
            key={p.kind}
            role="radio"
            aria-checked={paper === p.kind}
            className={`paper-opt paper-${p.kind} ${paper === p.kind ? 'active' : ''}`}
            onClick={() => setPaper(p.kind)}
          >
            <span className="paper-preview">
              <span className="paper-sheet" style={{ width: 54, height: Math.round(54 * (p.height / p.width)) }}>
                <span className="paper-rules" style={p.rule ? { backgroundSize: `100% ${(p.rule / p.height) * 100}%` } : undefined} />
              </span>
            </span>
            <span className="paper-copy">
              <b>{p.name}</b>
              <em>{p.use}</em>
            </span>
          </button>
        ))}
      </div>
      <p className="muted small">New pages use the same paper. You can change it per page from the page menu, or for the whole notebook in its menu.</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={create}>
          Create
        </button>
      </div>
    </Dialog>
  );
}

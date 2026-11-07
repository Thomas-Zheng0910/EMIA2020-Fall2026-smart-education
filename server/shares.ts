import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AppError, Store, id } from './db';
import type { Item, Notebook, Page, ShareMode, Stroke } from '../shared/types';

const shared = <T extends Stroke | Item>(o: T, ownerId: string): T => ({
  ...o,
  origin: 'shared',
  sourceId: o.sourceId ?? o.id,
  authorId: o.authorId ?? ownerId,
  localModified: false,
});
const copyStrokes = (strokes: Stroke[], ownerId: string) => strokes.map((s) => shared(s, ownerId));
const copyItems = (items: Item[], ownerId: string) => items.filter((i) => i.type !== 'annotation').map((i) => shared(i, ownerId));

/** Copy a PDF page's background into the recipient's own notebook folder, since asset URLs are owner-only. */
async function copyBackground(store: Store, dataDir: string, page: Page, copyNotebookId: string) {
  if (page.kind === 'slide' || !page.image) return null;
  const src = join(dataDir, 'assets', page.image);
  const name = basename(page.image);
  const rel = `notebooks/${copyNotebookId}/${name}`;
  const dst = join(dataDir, 'assets', rel);
  try {
    await mkdir(join(dataDir, 'assets', 'notebooks', copyNotebookId), { recursive: true });
    await copyFile(src, dst);
    return rel;
  } catch (e) {
    console.error('[share] could not copy page background', page.image, (e as Error).message);
    return null;
  }
}

function pageLink(page: Page) {
  return {
    lectureId: page.link.lectureId,
    slideId: page.link.slideId,
    confidence: page.link.confidence,
    confirmed: page.link.confirmed,
  };
}

/**
 * A direct share is a real editable copy, not a view. The sender's page becomes `origin='shared'`
 * objects; the recipient's new ink is `origin='own'`. Nothing in the source notebook changes.
 */
export async function shareNotebook({
  store,
  dataDir,
  sourceNotebookId,
  sourcePageId,
  fromStudentId,
  toStudentId,
  mode,
  refreshSnapshot = false,
}: {
  store: Store;
  dataDir: string;
  sourceNotebookId: string;
  sourcePageId: string | null;
  fromStudentId: string;
  toStudentId: string;
  mode: ShareMode;
  /** A live handout is a new session and may refresh a snapshot; a manual resend must not. */
  refreshSnapshot?: boolean;
}) {
  const source = store.notebook(sourceNotebookId);
  if (!store.isEnrolled(toStudentId, source.courseId)) throw new AppError(400, 'That student is not in this course.');
  if (sourcePageId && store.page(sourcePageId).notebookId !== sourceNotebookId) throw new AppError(400, 'That page is not in this notebook.');
  const fromName = store.student(fromStudentId).name;
  const sourcePages = sourcePageId ? [store.page(sourcePageId)] : store.pages(sourceNotebookId);
  if (!sourcePages.length) throw new AppError(400, 'There is nothing to share yet.');
  const pageForTitle = sourcePageId ? sourcePages[0]! : null;
  const pageLabel = pageForTitle
    ? pageForTitle.kind === 'slide'
      ? `Slide ${pageForTitle.position}`
      : `Page ${store.pages(sourceNotebookId).findIndex((p) => p.id === pageForTitle.id) + 1}`
    : null;
  const title = `${fromName} · ${source.title}${pageLabel ? ` · ${pageLabel}` : ''}`;
  const folderId = store.ensureSharedFolder(source.courseId, toStudentId);
  const existing = store.getShareFor(sourceNotebookId, toStudentId, sourcePageId);
  if (existing) {
    let copy: Notebook | null = null;
    try {
      copy = store.notebook(existing.copyNotebookId);
    } catch {
      store.deleteShare(existing.id); // the recipient deleted their copy; make a fresh one below
    }
    if (copy) {
      if (copy.shareMode === 'snapshot' && !refreshSnapshot) {
        // The recipient chose to keep a snapshot (or the sender sent one). A manual resend must
        // not silently turn it back into a live-following copy.
        store.setShareMode(existing.id, 'snapshot');
        store.setNotebookShare(copy.id, {
          shareId: existing.id,
          sourceNotebookId,
          sourceRevision: existing.sourceRevision,
          shareMode: 'snapshot',
        });
        return { copyNotebookId: copy.id, shareId: existing.id, keptSnapshot: true };
      }
      store.setShareMode(existing.id, 'pull');
      // Keep the recipient's title if they renamed their copy; only the shared content refreshes.
      store.setNotebookShare(copy.id, { shareId: existing.id, sourceNotebookId, sourceRevision: existing.sourceRevision, shareMode: 'pull' });
      await syncCopy({ store, dataDir, copyNotebookId: copy.id });
      store.setShareMode(existing.id, mode);
      store.setNotebookShare(copy.id, { shareId: existing.id, sourceNotebookId, sourceRevision: store.shareById(existing.id)?.sourceRevision ?? existing.sourceRevision, shareMode: mode });
      store.markShareNotified(existing.id); // the recipient already has this copy; don't pop again
      return { copyNotebookId: copy.id, shareId: existing.id, keptSnapshot: false };
    }
  }

  const copyId = store.createNotebook({
    courseId: source.courseId,
    studentId: toStudentId,
    lectureId: null,
    title,
    kind: 'shared',
    folderId,
    paper: source.paper,
  });
  for (const page of sourcePages) {
    const background = await copyBackground(store, dataDir, page, copyId);
    store.addCopiedPage({
      notebookId: copyId,
      position: page.position,
      kind: page.kind,
      slideId: page.kind === 'slide' ? page.slideId : null,
      background,
      width: page.width,
      height: page.height,
      link: pageLink(page),
      strokes: copyStrokes(page.strokes, source.studentId),
      items: copyItems(page.items, source.studentId),
      sourcePageId: page.id,
      sourceRevision: page.revision,
    });
  }
  const initialRevision = sourcePageId ? sourcePages[0]!.revision : (source.revision ?? 0);
  const shareId = store.createShare({
    courseId: source.courseId,
    fromStudentId,
    toStudentId,
    sourceNotebookId,
    sourcePageId,
    copyNotebookId: copyId,
    title,
    mode,
    sourceRevision: initialRevision,
  });
  store.setNotebookShare(copyId, { shareId, sourceNotebookId, sourceRevision: initialRevision, shareMode: mode });
  return { copyNotebookId: copyId, shareId, keptSnapshot: false };
}

/**
 * Pull a source notebook's changes into a copy. Shared objects the recipient changed win; their
 * own objects are never touched; erased shared objects stay erased through the page's tombstones.
 */
export async function syncCopy({ store, dataDir, copyNotebookId }: { store: Store; dataDir: string; copyNotebookId: string }) {
  const share = store.shareByCopy(copyNotebookId);
  if (!share || share.sourceDeleted) return { synced: false, reason: 'snapshot' as const };
  if (share.mode !== 'pull') return { synced: false, reason: 'snapshot' as const };
  let source: Notebook;
  try {
    source = store.notebook(share.sourceNotebookId);
  } catch {
    store.updateShareSync(share.id, share.sourceRevision, true);
    store.setShareMode(share.id, 'snapshot');
    store.setNotebookShare(copyNotebookId, { shareId: share.id, sourceNotebookId: share.sourceNotebookId, sourceRevision: share.sourceRevision, shareMode: 'snapshot' });
    return { synced: false, reason: 'source-deleted' as const };
  }
  let sourcePages: Page[];
  try {
    sourcePages = share.sourcePageId ? [store.page(share.sourcePageId)] : store.pages(source.id);
  } catch {
    store.updateShareSync(share.id, share.sourceRevision, true);
    store.setShareMode(share.id, 'snapshot');
    store.setNotebookShare(copyNotebookId, { shareId: share.id, sourceNotebookId: share.sourceNotebookId, sourceRevision: share.sourceRevision, shareMode: 'snapshot' });
    return { synced: false, reason: 'source-deleted' as const };
  }
  const copyPages = store.pages(copyNotebookId);
  const bySource = new Map(copyPages.filter((p) => p.sourcePageId).map((p) => [p.sourcePageId!, p]));
  const deleted = new Set(store.deletedSourcePages(copyNotebookId));
  const sourceIds = new Set(sourcePages.map((p) => p.id));
  for (const src of sourcePages) {
    if (deleted.has(src.id)) continue;
    const copy = bySource.get(src.id);
    if (copy) {
      mergeSharedLayer(store, copy, src, source.studentId);
    } else {
      const background = await copyBackground(store, dataDir, src, copyNotebookId);
      const position = Math.max(0, ...store.pages(copyNotebookId).map((p) => p.position)) + 1;
      store.addCopiedPage({
        notebookId: copyNotebookId,
        position,
        kind: src.kind,
        slideId: src.kind === 'slide' ? src.slideId : null,
        background,
        width: src.width,
        height: src.height,
        link: pageLink(src),
        strokes: copyStrokes(src.strokes, source.studentId),
        items: copyItems(src.items, source.studentId),
        sourcePageId: src.id,
        sourceRevision: src.revision,
      });
    }
  }
  // A source page that disappeared stays if the recipient wrote on it; otherwise it goes away.
  for (const copy of store.pages(copyNotebookId)) {
    if (!copy.sourcePageId || sourceIds.has(copy.sourcePageId)) continue;
    const hasOwn =
      copy.strokes.some((s) => s.origin !== 'shared' || s.localModified) ||
      copy.items.some((i) => i.origin !== 'shared' || i.localModified);
    if (hasOwn) store.setPageOrigin(copy.id, 'own', null, null);
    else store.deletePage(copy.id);
  }
  const syncedRevision = share.sourcePageId ? (sourcePages[0]?.revision ?? 0) : (source.revision ?? 0);
  store.updateShareSync(share.id, syncedRevision);
  store.setNotebookShare(copyNotebookId, { shareId: share.id, sourceNotebookId: source.id, sourceRevision: syncedRevision, shareMode: 'pull' });
  store.bumpNotebookRevision(copyNotebookId);
  return { synced: true, revision: syncedRevision };
}

function mergeSharedLayer(store: Store, copy: Page, src: Page, ownerId: string) {
  const srcStrokes = copyStrokes(src.strokes, ownerId);
  const srcItems = copyItems(src.items, ownerId);
  const srcObjects = new Map([...srcStrokes, ...srcItems].map((o) => [o.sourceId!, o]));
  const tombstones = new Set(copy.sharedTombstones ?? []);
  const keep: (Stroke | Item)[] = [];
  const seen = new Set<string>();
  for (const o of [...copy.strokes, ...copy.items] as (Stroke | Item)[]) {
    if (o.origin !== 'shared') {
      keep.push(o);
      continue;
    }
    const sourceId = o.sourceId ?? o.id;
    if (tombstones.has(sourceId)) continue;
    // A locally edited or moved shared object wins; the source may change underneath it.
    if (o.localModified) {
      keep.push(o);
      seen.add(sourceId);
      continue;
    }
    const next = srcObjects.get(sourceId);
    if (!next) continue;
    seen.add(sourceId);
    keep.push({
      ...next,
      id: o.id,
      origin: 'shared',
      sourceId,
      authorId: o.authorId ?? ownerId,
      localModified: false,
      lastEditedBy: o.lastEditedBy,
    } as Stroke | Item);
  }
  for (const [sourceId, next] of srcObjects) {
    if (seen.has(sourceId) || tombstones.has(sourceId)) continue;
    keep.push({ ...next, id: id(), origin: 'shared', sourceId, authorId: next.authorId ?? ownerId, localModified: false } as Stroke | Item);
  }
  const strokes = keep.filter((o) => !('type' in o)) as Stroke[];
  const items = keep.filter((o) => 'type' in o) as Item[];
  store.replaceCopiedPage(copy.id, strokes, items, src.revision);
}

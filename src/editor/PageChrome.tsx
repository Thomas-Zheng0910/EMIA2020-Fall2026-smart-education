import { useEffect, useState } from 'react';
import type { Lecture } from '../../shared/types';
import { api } from '../api';
import { useBoot } from '../boot';
import { Menu } from '../Home';
import type { EditorPage, SaveState } from './types';

export function PageChrome({
  page,
  index,
  saveState,
  onInsert,
  onDelete,
  onClassmates,
  onLink,
}: {
  page: EditorPage;
  index: number;
  saveState?: SaveState;
  onInsert: (kind: 'blank' | 'ruled' | 'grid') => void;
  onDelete: () => void;
  onClassmates: () => void;
  onLink: (lectureId: string | null, slideId: string | null) => void;
}) {
  const { lectures } = useBoot();
  const [linking, setLinking] = useState(false);
  const slideRef = page.kind === 'slide' ? null : page.link;
  const lec = lectures.find((l) => l.id === page.link.lectureId);
  const status =
    page.indexStatus === 'queued' || page.indexStatus === 'indexing'
      ? { cls: 'busy', text: 'Organizing…', title: 'Your notes are being read and linked to the course' }
      : page.indexStatus === 'failed'
        ? { cls: 'warn', text: 'Not shared', title: page.indexError ?? '' }
        : page.indexStatus === 'indexed' && page.sharedCount > 0
          ? { cls: 'ok', text: `Shared ${page.sharedCount} note${page.sharedCount > 1 ? 's' : ''}`, title: 'Parts of this page help classmates. See what you shared in the suggestions panel.' }
          : null;
  return (
    <div className="page-chrome">
      <span className="page-label">{page.kind === 'slide' ? `Slide ${page.position}` : `Page ${index}`}</span>
      {slideRef && (
        <span className={`link-chip ${slideRef.lectureId ? (slideRef.confirmed ? 'confirmed' : 'guess') : 'none'}`}>
          {slideRef.lectureId ? (
            <>
              {page.linkedSlides > 1 ? (
                // A page that covers several slides: each note is linked separately.
                <>L{lec?.number ?? '?'} · {page.linkedSlides} slides</>
              ) : (
                <>
                  {slideRef.confirmed ? '' : 'Looks like '}L{lec?.number ?? '?'}
                  {slideRef.slidePage ? ` · slide ${slideRef.slidePage}` : ''}
                </>
              )}
              {!slideRef.confirmed && page.linkedSlides <= 1 && (
                <button title="Confirm this course link" onClick={() => onLink(slideRef.lectureId, slideRef.slideId)}>
                  ✓
                </button>
              )}
            </>
          ) : (
            'Not linked'
          )}
          <button onClick={() => setLinking((v) => !v)}>{slideRef.lectureId ? 'change' : 'link'}</button>
        </span>
      )}
      {status &&
        (status.cls === 'ok' ? (
          <button className={`index-chip ${status.cls}`} title={status.title} onClick={onClassmates}>
            {status.text}
          </button>
        ) : (
          <span className={`index-chip ${status.cls}`} title={status.title}>
            {status.text}
          </span>
        ))}
      {saveState === 'error' && <span className="index-chip warn">Save failed</span>}
      <div className="spacer" />
      <Menu
        label="Page options"
        items={[
          { label: 'Insert ruled page after', run: () => onInsert('ruled') },
          { label: 'Insert blank page after', run: () => onInsert('blank') },
          { label: 'Insert grid page after', run: () => onInsert('grid') },
          ...(page.kind !== 'slide' ? [{ label: 'Delete page', danger: true, run: onDelete }] : []),
        ]}
      />
      {linking && <LinkPicker lectures={lectures} initial={page.link.lectureId} onPick={(l, s) => (setLinking(false), onLink(l, s))} onClose={() => setLinking(false)} />}
    </div>
  );
}


function LinkPicker({ lectures, initial, onPick, onClose }: { lectures: Lecture[]; initial: string | null; onPick: (l: string | null, s: string | null) => void; onClose: () => void }) {
  const [lectureId, setLectureId] = useState(initial ?? lectures[0]?.id ?? '');
  const [slides, setSlides] = useState<{ id: string; page: number; digest: { title: string } | null }[]>([]);
  const [slideId, setSlideId] = useState<string>('');
  useEffect(() => {
    if (!lectureId) return;
    api(`/api/lectures/${lectureId}/slides`).then(setSlides);
  }, [lectureId]);
  return (
    <div className="link-picker">
      <select value={lectureId} onChange={(e) => (setLectureId(e.target.value), setSlideId(''))}>
        {lectures.map((l) => (
          <option key={l.id} value={l.id}>
            L{l.number} · {l.title}
          </option>
        ))}
      </select>
      <select value={slideId} onChange={(e) => setSlideId(e.target.value)}>
        <option value="">Whole lecture</option>
        {slides.map((s) => (
          <option key={s.id} value={s.id}>
            Slide {s.page}
            {s.digest?.title ? ` · ${s.digest.title.slice(0, 40)}` : ''}
          </option>
        ))}
      </select>
      <button className="btn small" disabled={!lectureId} onClick={() => onPick(lectureId, slideId || null)}>
        Link
      </button>
      <button className="btn small ghost" onClick={() => onPick(null, null)}>
        Unlink
      </button>
      <button className="btn small ghost" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

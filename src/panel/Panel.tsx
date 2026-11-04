import { useEffect, useRef, useState } from 'react';
import type { Citation, Notebook, OwnNote, PageSuggestions, Suggestion } from '../../shared/types';
import { api } from '../api';
import { Md } from '../Md';
import type { EditorPage } from '../editor/types';

export type AddFn = (
  pageId: string,
  a: { title: string; body: string; source: Suggestion['source']; citations: Citation[] },
  near?: [number, number, number, number] | null,
) => void;

/** Loads this page's suggestions. Shared by the margin markers and the panel so they never disagree. */
export function useSuggestions(page: EditorPage | null, onToast: (m: string) => void) {
  const [data, setData] = useState<PageSuggestions | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const pageId = page?.id ?? null;
  const revision = page?.revision ?? 0;
  const indexStatus = page?.indexStatus ?? 'idle';
  const slideId = page?.link.slideId ?? null;
  const version = page?.suggestVersion ?? '';
  useEffect(() => {
    if (!pageId) return setData(null);
    let live = true;
    setData(null);
    setHidden(new Set());
    api<PageSuggestions>(`/api/pages/${pageId}/suggestions`)
      .then((d) => live && setData(d))
      .catch((e) => onToast((e as Error).message));
    return () => {
      live = false;
    };
  }, [pageId, revision, indexStatus, slideId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const gaps = (data?.gaps ?? []).filter((g) => !hidden.has(g.id));
  const dismiss = async (g: Suggestion) => {
    setHidden((h) => new Set(h).add(g.id));
    if (pageId) await api(`/api/pages/${pageId}/suggestions/${g.id}/dismiss`, { method: 'POST' }).catch(() => {});
  };
  return { data, gaps, dismiss };
}

/**
 * The quiet margin marker: one small dot beside each gap. Nothing else shows until it is tapped,
 * which is what keeps suggestions from shouting at a student who is writing.
 */
export function MarginMarkers({
  page,
  scale,
  gaps,
  onOpen,
}: {
  page: EditorPage;
  scale: number;
  gaps: Suggestion[];
  onOpen: (g: Suggestion) => void;
}) {
  return (
    <div className="margin-markers" style={{ height: page.height * scale }}>
      {gaps.map((g) => {
        // Place the dot at the top of the gap, clamped so it stays reachable on any page.
        const top = Math.max(8, Math.min(page.height - 24, g.bbox[1] * page.height));
        return (
          <button
            key={g.id}
            className={`gap-marker ${g.source}`}
            style={{ top: top * scale }}
            onClick={() => onOpen(g)}
            title={g.missing}
            aria-label={`Suggestion: ${g.missing}`}
          >
            <span />
          </button>
        );
      })}
    </div>
  );
}

/** A suggestion card, inline at the gap it fills. */
export function SuggestionCard({
  suggestion,
  onAdd,
  onDismiss,
  onCitation,
  onReport,
  onClose,
}: {
  suggestion: Suggestion;
  onAdd: () => void;
  onDismiss: () => void;
  onCitation: (c: Citation) => void;
  onReport: () => void;
  onClose: () => void;
}) {
  const [filling, setFilling] = useState(false);
  const [filled, setFilled] = useState<{ title: string; body: string; citations: Citation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [menu, setMenu] = useState(false);
  const title = filled?.title ?? suggestion.title;
  const body = filled?.body ?? suggestion.body;
  const citations = filled?.citations ?? suggestion.citations;

  // A card with no peer entry and no slide text asks for the explanation when it is opened.
  useEffect(() => {
    if (body || filling || filled) return;
    setFilling(true);
    api<{ title: string; body: string; citations: Citation[] }>(`/api/pages/${suggestion.pageId}/suggestions/${suggestion.id}/fill`, { method: 'POST' })
      .then(setFilled)
      .catch((e) => setError((e as Error).message))
      .finally(() => setFilling(false));
  }, [suggestion.id, suggestion.pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <article className="suggest-card" role="dialog" aria-label="Suggestion">
      <div className="suggest-src">{suggestion.sourceLine}</div>
      <h4>{title || suggestion.missing}</h4>
      {filling && <div className="suggest-loading">Reading the slide and classmates’ notes…</div>}
      {error && <div className="error-box">{error}</div>}
      {body ? <Md text={body} /> : !filling && !error ? <p className="muted small">{suggestion.missing}</p> : null}
      {citations.length > 0 && (
        <div className="citations">
          {citations.map((c, i) => (
            <button key={i} className={`cite cite-${c.kind}`} onClick={() => onCitation(c)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <footer>
        <button
          className="btn small"
          disabled={added || !body}
          onClick={() => {
            setAdded(true);
            onAdd();
          }}
        >
          {added ? 'Added ✓' : 'Add to my notes'}
        </button>
        <button className="btn small ghost" onClick={onDismiss}>
          Dismiss
        </button>
        <div className="suggest-more">
          <button className="icon-btn small" onClick={() => setMenu((v) => !v)} aria-label="More actions" aria-expanded={menu}>
            ⋯
          </button>
          {menu && (
            <div className="suggest-menu" role="menu">
              <button role="menuitem" onClick={onDismiss}>
                Not helpful
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  onReport();
                  onDismiss();
                }}
              >
                Looks wrong
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn small" onClick={onClose} aria-label="Close suggestion">
          ×
        </button>
      </footer>
    </article>
  );
}

/** The lasso popover: Explain / Example / Why?, an optional question, and the answer in place. */
export function LassoPopover({
  pageId,
  bbox,
  onAdd,
  onCitation,
  onClose,
}: {
  pageId: string;
  bbox: [number, number, number, number];
  onAdd: (a: { title: string; body: string; source: Suggestion['source']; citations: Citation[] }) => void;
  onCitation: (c: Citation) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<{ id: string; title: string; body: string; source: Suggestion['source']; citations: Citation[] }[]>([]);
  const box = useRef<HTMLDivElement>(null);

  const run = async (q?: string) => {
    setLoading(true);
    setError(null);
    try {
      // Saving first means the model reads the latest ink, not the version 700 ms ago.
      const out = await api<{ cards: typeof cards }>('/api/ask', { method: 'POST', json: { pageId, bbox, question: q || undefined } });
      setCards(out.cards);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Circling a part and choosing Explain is already a question: answer it without another tap.
  useEffect(() => {
    run('Explain this part.');
  }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lasso-pop" ref={box} data-interactive role="dialog" aria-label="Ask about the selection">
      <div className="lasso-chips">
        {['Explain', 'Example', 'Why?'].map((c) => (
          <button key={c} className="chip" disabled={loading} onClick={() => run(c === 'Why?' ? 'Why is this true?' : c === 'Example' ? 'Give a worked example of this.' : 'Explain this part.')}>
            {c}
          </button>
        ))}
        <button className="icon-btn small" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="lasso-ask">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the circled part…"
          onKeyDown={(e) => e.key === 'Enter' && question.trim() && run(question.trim())}
        />
        <button className="btn small" disabled={loading || !question.trim()} onClick={() => run(question.trim())}>
          Ask
        </button>
      </div>
      {loading && <div className="suggest-loading">Reading your notes, the slides and classmates’ notes…</div>}
      {error && <div className="error-box">{error}</div>}
      {cards.map((c) => (
        <article key={c.id} className="suggest-card inline">
          <div className="suggest-src">{SOURCE_LINE[c.source]}</div>
          <h4>{c.title}</h4>
          <Md text={c.body} />
          {c.citations.length > 0 && (
            <div className="citations">
              {c.citations.map((cit, i) => (
                <button key={i} className={`cite cite-${cit.kind}`} onClick={() => onCitation(cit)}>
                  {cit.label}
                </button>
              ))}
            </div>
          )}
          <footer>
            <button
              className="btn small"
              onClick={() => {
                onAdd({ title: c.title, body: c.body, source: c.source, citations: c.citations });
                setCards((cs) => cs.filter((x) => x.id !== c.id));
              }}
            >
              Add to my notes
            </button>
            <button className="btn small ghost" onClick={() => setCards((cs) => cs.filter((x) => x.id !== c.id))}>
              Dismiss
            </button>
          </footer>
        </article>
      ))}
    </div>
  );
}

export const SOURCE_LINE: Record<Suggestion['source'], string> = {
  peer: 'From a classmate’s note',
  slide: 'From the slides',
  ai: 'AI explanation',
};

/**
 * The slim side panel: this page's suggestions as a list, plus — for the author — what happens to
 * their own notes. Closed by default; the margin markers are the indicator that something is there.
 */
export function SuggestionsPanel({
  page,
  notebook,
  pageNumber,
  gaps,
  own,
  unlinked,
  onClose,
  onScrollTo,
  onAdd,
  onCitation,
  onDismiss,
  onReport,
}: {
  page: EditorPage;
  notebook: Notebook;
  pageNumber: number;
  gaps: Suggestion[];
  own: OwnNote[];
  unlinked: boolean;
  onClose: () => void;
  onScrollTo: (g: Suggestion) => void;
  onAdd: AddFn;
  onCitation: (c: Citation) => void;
  onDismiss: (g: Suggestion) => void;
  onReport: (g: Suggestion) => void;
}) {
  return (
    <aside className="panel" aria-label="Suggestions">
      <div className="panel-head">
        <h3>
          Suggestions{gaps.length > 0 && <span className="tab-count">{gaps.length}</span>}
        </h3>
        <button className="icon-btn small" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-context">
        {page.kind === 'slide' ? `Slide ${page.position}` : `Page ${pageNumber}`} · {notebook.title}
      </div>
      <div className="panel-body">
        {unlinked ? (
          <div className="empty">
            <b>Not linked to a lecture yet</b>
            <p>Write something and Notebook links the page to a lecture, or choose one from the chip above the page.</p>
          </div>
        ) : gaps.length === 0 ? (
          <div className="empty">
            <b>Nothing to suggest here</b>
            <p>When classmates’ notes cover something you missed, a small marker appears beside the page.</p>
          </div>
        ) : (
          <ul className="suggest-list">
            {gaps.map((g) => (
              <li key={g.id}>
                <button className="suggest-row" onClick={() => onScrollTo(g)}>
                  <span className={`suggest-dot ${g.source}`} />
                  <span>
                    <b>{g.title || g.missing}</b>
                    <small>{g.sourceLine}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {own.length > 0 && (
          <section className="mine">
            <h4>From this page</h4>
            {own.map((n) => (
              <div key={n.id} className={`mine-item ${n.state}`}>
                <span className="tag">{n.sourceLine}</span>
                {n.disputeExplanation && <div className="conflict">⚠ {n.disputeExplanation}</div>}
                <Md text={n.text} className="small" />
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}

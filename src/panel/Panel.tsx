import { useEffect, useRef, useState } from 'react';
import { ArrowUp, History, Plus } from 'lucide-react';
import type {
  AskMessage,
  AskSession,
  AskSessionSummary,
  Citation,
  Notebook,
  NotebookSuggestions,
  OwnNote,
  PageSuggestions,
  Suggestion,
} from '../../shared/types';
import { api } from '../api';
import { Md } from '../Md';
import { ago } from '../Home';
import { writingColumn } from '../paper';
import { isTouchDevice } from '../ui';
import type { EditorPage } from '../editor/types';

export type AddFn = (
  pageId: string,
  a: { title: string; body: string; source: Suggestion['source']; citations: Citation[] },
  near?: [number, number, number, number] | null,
  /** The gap being answered, so the page knows which suggestion is settled. */
  gap?: { id: string | null; missing: string | null },
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
    api<PageSuggestions>(`/api/pages/${pageId}/suggestions`)
      .then((d) => live && setData(d))
      .catch((e) => onToast((e as Error).message));
    return () => {
      live = false;
    };
  }, [pageId, revision, indexStatus, slideId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hidden ids survive a refetch: dismissing is a choice about this suggestion. Accepting is not
  // recorded here at all — a gap is done when its note is actually on the page, so undo brings the
  // suggestion straight back.
  useEffect(() => setHidden(new Set()), [pageId]);
  const gaps = (data?.gaps ?? []).filter((g) => !hidden.has(g.id));
  /** "Not now": remembered on the server, so this suggestion does not come back for this student. */
  const dismiss = async (g: Suggestion) => {
    setHidden((h) => new Set(h).add(g.id));
    if (pageId) await api(`/api/pages/${pageId}/suggestions/${g.id}/dismiss`, { method: 'POST' }).catch(() => {});
  };
  /** Escape: puts the ghost away for now. It is not a judgement, so nothing is remembered. */
  const hideForNow = (id: string) => setHidden((h) => new Set(h).add(id));
  return { data, gaps, dismiss, hideForNow };
}

/** Gaps whose note is already on the page are answered: the student's merge is the record. */
export function unanswered(gaps: Suggestion[], items: { type: string; gapId?: string | null }[]) {
  const answered = new Set(items.filter((i) => i.type === 'annotation' && i.gapId).map((i) => i.gapId));
  return gaps.filter((g) => !answered.has(g.id));
}

/**
 * The inline suggestion, in the page, where the student is writing.
 *
 * Modelled on an editor completion rather than a notification: the text appears faintly in the
 * writing column at the gap, a small "＋" sits at its start, and Enter/Tab or a click accepts it.
 * Escape hides it. Nothing floats over the page and nothing has to be opened first.
 */
export function InlineGhost({
  page,
  scale,
  suggestion,
  index,
  total,
  onAdd,
  onNotNow,
  onDismiss,
  onDetails,
}: {
  page: EditorPage;
  scale: number;
  suggestion: Suggestion;
  index: number;
  total: number;
  onAdd: (s: Suggestion) => void;
  /** Escape and "Not now": puts the ghost away for now without judging the suggestion. */
  onNotNow: (s: Suggestion) => void;
  /** Same, but remembered for this student. */
  onDismiss: (s: Suggestion) => void;
  onDetails: (s: Suggestion) => void;
}) {
  const [filling, setFilling] = useState(false);
  const [body, setBody] = useState(suggestion.body);
  // A gap with no peer note and no slide text is filled on demand, so the ghost has something to show.
  useEffect(() => {
    if (body || filling) return;
    setFilling(true);
    api<{ title: string; body: string; citations: Citation[] }>(`/api/pages/${suggestion.pageId}/suggestions/${suggestion.id}/fill`, { method: 'POST' })
      .then((r) => setBody(r.body))
      .catch(() => {})
      .finally(() => setFilling(false));
  }, [suggestion.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const col = writingColumn(page.width, page.height, page.kind);
  const top = Math.max(0, Math.min(page.height - 40, suggestion.bbox[1] * page.height));
  const [menu, setMenu] = useState(false);
  // Deliberately not auto-focused: a ghost that grabs the keyboard would swallow what the student
  // is typing. Tab reaches the + in the margin, and Enter accepts, Escape puts it away.
  return (
    <>
      {/* All controls live in the margin, never over the writing: the page stays fully writable. */}
      <div className="ghost-tools" style={{ top: top * scale }}>
        <button className="ghost-accept-gutter" onClick={() => onAdd(suggestion)} title="Add this to my notes" aria-label={`Add suggestion: ${suggestion.missing}`}>
          ＋
        </button>
        <button className="ghost-more" onClick={() => setMenu((v) => !v)} aria-label="Suggestion options" aria-expanded={menu}>
          ⋯
        </button>
        {menu && (
          <div className="ghost-menu" role="menu">
            <button role="menuitem" onClick={() => (setMenu(false), onDetails(suggestion))}>
              Full note
            </button>
            <button role="menuitem" onClick={() => (setMenu(false), onNotNow(suggestion))}>
              Not now
            </button>
            <button role="menuitem" onClick={() => (setMenu(false), onDismiss(suggestion))}>
              Don’t suggest this again
            </button>
          </div>
        )}
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label={`Suggestion: ${suggestion.missing}`}
        className={`inline-ghost source-${suggestion.source}`}
        style={{ top: top * scale, left: `calc(var(--margin-track) + ${col.left * scale}px)`, maxWidth: (col.right - col.left - 40) * scale }}
        data-interactive
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            onAdd(suggestion);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onNotNow(suggestion);
          }
        }}
      >
        <div className="ghost-body">
          <div className="ghost-gap">{suggestion.missing}</div>
          <div className="ghost-text">
            {filling && !body ? <span className="muted">Looking this up…</span> : <Md text={body.length > 220 ? body.slice(0, 220).replace(/\$[^$]*$/, '') + '…' : body} />}
          </div>
          <div className="ghost-foot">
            <span className="ghost-credit">{suggestion.sourceLine}</span>
            {total > 1 && (
              <span className="ghost-count">
                {index + 1} of {total}
              </span>
            )}
            <span className="ghost-hint">{isTouchDevice() ? 'Tap ＋ to add' : 'Enter to add'}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The quiet margin marker: one small tab beside each gap, numbered so the panel and the page refer
 * to the same thing. Nothing else shows until a tab is tapped, which is what keeps suggestions from
 * shouting at a student who is writing.
 */
export function MarginMarkers({
  page,
  scale,
  gaps,
  openId,
  onOpen,
}: {
  page: EditorPage;
  scale: number;
  gaps: Suggestion[];
  openId?: string | null;
  onOpen: (g: Suggestion) => void;
}) {
  return (
    <div className="margin-markers" style={{ height: page.height * scale }}>
      {gaps.map((g, i) => {
        // Place the tab at the top of the gap, clamped so it stays reachable on any page.
        const top = Math.max(8, Math.min(page.height - 24, g.bbox[1] * page.height));
        return (
          <button
            key={g.id}
            className={`gap-marker ${g.source} ${openId === g.id ? 'open' : ''}`}
            style={{ top: top * scale }}
            onClick={() => onOpen(g)}
            title={g.missing}
            aria-label={`Suggestion ${i + 1}: ${g.missing}`}
          >
            <span>{i + 1}</span>
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
  onAdd: (s: Suggestion) => void;
  onDismiss: (s: Suggestion) => void;
  onCitation: (c: Citation) => void;
  onReport: (s: Suggestion) => void;
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
      {/* The gap first, in the student's own words: what is missing where they stopped writing. */}
      <div className="suggest-gap">
        <span className="suggest-gap-mark" aria-hidden />
        {suggestion.missing}
      </div>
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
      <div className="suggest-credit">{suggestion.sourceLine}</div>
      <footer>
        <button
          className="btn small primary"
          disabled={added || !body}
          onClick={() => {
            setAdded(true);
            onAdd(suggestion);
          }}
        >
          {added ? 'Added ✓' : 'Add beside my notes'}
        </button>
        <button className="btn small ghost" onClick={() => onDismiss(suggestion)}>
          Dismiss
        </button>
        <div className="suggest-more">
          <button className="icon-btn small" onClick={() => setMenu((v) => !v)} aria-label="More actions" aria-expanded={menu}>
            ⋯
          </button>
          {menu && (
            <div className="suggest-menu" role="menu">
              <button role="menuitem" onClick={() => onDismiss(suggestion)}>
                Not helpful
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  onReport(suggestion);
                  onDismiss(suggestion);
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
 * Ask about this page, without circling anything. The same endpoint as the lasso popover, with no
 * bounding box: the whole page is the scope, so "explain this" works the moment a page is open.
 */
function AskBox({ page, unlinked, onAdd, onCitation }: { page: EditorPage; unlinked: boolean; onAdd: AddFn; onCitation: (c: Citation) => void }) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<{ id: string; title: string; body: string; source: Suggestion['source']; citations: Citation[] }[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const run = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const out = await api<{ cards: typeof cards }>('/api/ask', { method: 'POST', json: { pageId: page.id, question: q || undefined } });
      setCards(out.cards);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ask-box">
      <div className="ask-row">
        <input
          className="ask-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={unlinked ? 'Link this page to a lecture to ask…' : 'Ask about this page…'}
          disabled={unlinked || loading}
          aria-label="Ask about this page"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading && !unlinked) run(question.trim() || 'What am I missing on this page?');
          }}
        />
        <button
          className="btn small primary"
          disabled={unlinked || loading || !question.trim()}
          onClick={() => run(question.trim())}
        >
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {!unlinked && (
        <div className="ask-chips">
          {[
            ['Explain this page', 'What am I missing on this page?'],
            ['Give an example', 'Give a worked example of the main idea on this page.'],
            ['Why?', 'Why is what I wrote on this page true?'],
          ].map(([chip, q]) => (
            <button key={chip} className="chip" disabled={loading} onClick={() => (setQuestion(q!), run(q!))}>
              {chip}
            </button>
          ))}
        </div>
      )}
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
              disabled={added.has(c.id)}
              onClick={() => {
                onAdd(page.id, { title: c.title, body: c.body, source: c.source, citations: c.citations });
                setAdded((s) => new Set(s).add(c.id));
              }}
            >
              {added.has(c.id) ? 'Added ✓' : 'Add beside my notes'}
            </button>
            <button className="btn small ghost" onClick={() => setCards((cs) => cs.filter((x) => x.id !== c.id))}>
              Dismiss
            </button>
          </footer>
        </article>
      ))}
    </section>
  );
}

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
  onGoToPage,
  tab,
  onTab,
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
  /** Jump from the notebook browser to the page a suggestion sits on. */
  onGoToPage: (pageId: string) => void;
  tab: 'ask' | 'suggestions';
  onTab: (t: 'ask' | 'suggestions') => void;
}) {
  return (
    <aside className="panel" aria-label="Ask and suggestions">
      <div className="panel-head">
        <h3>
          Notebook
          {tab === 'suggestions' && gaps.length > 0 && <span className="tab-count">{gaps.length}</span>}
        </h3>
        <button className="icon-btn small" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'active' : ''} onClick={() => onTab('ask')}>
          Ask
        </button>
        <button role="tab" aria-selected={tab === 'suggestions'} className={tab === 'suggestions' ? 'active' : ''} onClick={() => onTab('suggestions')}>
          Suggestions
        </button>
      </div>
      <div className="panel-context">
        {page.kind === 'slide' ? `Slide ${page.position}` : `Page ${pageNumber}`} · {notebook.title}
      </div>
      <div className={`panel-body ${tab === 'ask' ? 'ask-body' : ''}`}>
        {tab === 'ask' ? (
          <AskChat page={page} pageNumber={pageNumber} notebook={notebook} unlinked={unlinked} onAdd={onAdd} onCitation={onCitation} />
        ) : (
          <SuggestionsTab
            page={page}
            notebook={notebook}
            pageNumber={pageNumber}
            gaps={gaps}
            own={own}
            unlinked={unlinked}
            onScrollTo={onScrollTo}
            onAdd={onAdd}
            onCitation={onCitation}
            onDismiss={onDismiss}
            onReport={onReport}
            onGoToPage={onGoToPage}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * Ask is a conversation, not a one-shot search: a notebook can hold several sessions, and each
 * message remembers the page it was asked about. The thread is persisted server-side, so closing
 * the notebook does not throw the conversation away.
 */
function AskChat({
  page,
  pageNumber,
  notebook,
  unlinked,
  onAdd,
  onCitation,
}: {
  page: EditorPage;
  pageNumber: number;
  notebook: Notebook;
  unlinked: boolean;
  onAdd: AddFn;
  onCitation: (c: Citation) => void;
}) {
  const [sessions, setSessions] = useState<AskSessionSummary[]>([]);
  const [session, setSession] = useState<AskSession | null>(null);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const thread = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const listSessions = () => api<{ sessions: AskSessionSummary[] }>(`/api/notebooks/${notebook.id}/ask/sessions`).then((d) => d.sessions);

  const loadSession = async (id: string) => {
    try {
      const s = await api<AskSession>(`/api/ask/sessions/${id}`);
      setSession(s);
      setMessages(s.messages);
      setHistory(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    let live = true;
    listSessions()
      .then((list) => {
        if (!live) return;
        setSessions(list);
        // Opening the panel continues the last conversation; History has the rest.
        if (list[0]) void loadSession(list[0].id);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // The panel is remounted per notebook, so this only needs the notebook identity.
  }, [notebook.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  useEffect(() => {
    if (!history) return;
    const close = (e: PointerEvent) => !historyRef.current?.contains(e.target as Node) && setHistory(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setHistory(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', esc));
  }, [history]);

  const newChat = () => {
    setSession(null);
    setMessages([]);
    setQuestion('');
    setError(null);
    setHistory(false);
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading || unlinked) return;
    setLoading(true);
    setError(null);
    try {
      const out = await api<{
        sessionId: string;
        sessionTitle: string;
        questionMessage: AskMessage;
        message: AskMessage;
      }>('/api/ask', { method: 'POST', json: { pageId: page.id, question: q, sessionId: session?.id } });
      setMessages((m) => [...m, out.questionMessage, out.message]);
      setQuestion('');
      if (!session) {
        setSession({
          id: out.sessionId,
          notebookId: notebook.id,
          title: out.sessionTitle,
          updatedAt: new Date().toISOString(),
          messageCount: 2,
          lastPageLabel: out.questionMessage.pageLabel,
          messages: [],
        });
      }
      void listSessions().then(setSessions).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const label = page.kind === 'slide' ? `Slide ${page.position}` : `Page ${pageNumber}`;
  const ask = (q: string) => void send(q);
  return (
    <div className="ask-chat">
      <div className="ask-chat-bar">
        <div className="ask-chat-title" title={session?.title}>
          {session?.title ?? 'New conversation'}
        </div>
        <div className="ask-chat-actions" ref={historyRef}>
          <button className="btn ghost small ask-history-btn" onClick={() => setHistory((v) => !v)} aria-expanded={history} title="Conversation history">
            <History size={14} /> History
          </button>
          <button className="icon-btn small" onClick={newChat} aria-label="New chat" title="New chat">
            <Plus size={16} />
          </button>
          {history && (
            <div className="ask-history" role="menu">
              <div className="ask-history-title">Conversations in this notebook</div>
              {sessions.length === 0 ? (
                <p className="muted small">No conversations yet.</p>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    role="menuitem"
                    className={session?.id === s.id ? 'active' : ''}
                    onClick={() => void loadSession(s.id)}
                  >
                    <b>{s.title}</b>
                    <small>
                      {ago(s.updatedAt)} · {s.messageCount} messages{s.lastPageLabel ? ` · ${s.lastPageLabel}` : ''}
                    </small>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ask-thread" ref={thread}>
        {messages.length === 0 && !loading && (
          <div className="ask-empty">
            <b>Ask about this page</b>
            <p>Answers come from the lecture and the course knowledge base. Ask follow-ups in the same conversation.</p>
            <div className="ask-chips">
              {[
                ['Explain this page', 'What am I missing on this page?'],
                ['Give an example', 'Give a worked example of the main idea on this page.'],
                ['Why?', 'Why is what I wrote on this page true?'],
              ].map(([chip, q]) => (
                <button key={chip} className="chip" disabled={unlinked} onClick={() => ask(q!)}>
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="ask-msg user">
              <div>{m.text}</div>
              <small>
                {m.pageLabel ? `${m.pageLabel} · ` : ''}
                {ago(m.createdAt)}
              </small>
            </div>
          ) : (
            <div key={m.id} className="ask-msg assistant">
              {m.cards.map((c) => (
                <article key={c.id} className="suggest-card inline ask-answer">
                  <div className="suggest-src">{SOURCE_LINE[c.source]}</div>
                  <h4>{c.title}</h4>
                  <Md text={c.body} />
                  {c.conflict && <div className="conflict">⚠ {c.conflict}</div>}
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
                      disabled={added.has(c.id)}
                      onClick={() => {
                        onAdd(m.pageId ?? page.id, { title: c.title, body: c.body, source: c.source, citations: c.citations });
                        setAdded((s) => new Set(s).add(c.id));
                      }}
                    >
                      {added.has(c.id) ? 'Added ✓' : 'Add beside my notes'}
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ),
        )}
        {loading && <div className="ask-thinking">Reading the lecture and your notes…</div>}
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="ask-composer">
        {unlinked ? (
          <div className="ask-unlinked">
            This page isn’t linked to a lecture yet. Write something so Notebook can link it, or choose a lecture from the chip above the page.
          </div>
        ) : (
          <>
            <div className="ask-context">Asking about {label}</div>
            <div className="ask-compose-row">
              <textarea
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(question);
                  }
                }}
                placeholder="Ask about this page…"
                aria-label="Ask about this page"
                disabled={loading}
              />
              <button className="btn primary ask-send" disabled={!question.trim() || loading} onClick={() => void send(question)} aria-label="Send question">
                <ArrowUp size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Suggestions live on their own tab: this page first, the whole notebook behind one toggle. */
function SuggestionsTab({
  page,
  notebook,
  pageNumber,
  gaps,
  own,
  unlinked,
  onScrollTo,
  onAdd,
  onCitation,
  onDismiss,
  onReport,
  onGoToPage,
}: {
  page: EditorPage;
  notebook: Notebook;
  pageNumber: number;
  gaps: Suggestion[];
  own: OwnNote[];
  unlinked: boolean;
  onScrollTo: (g: Suggestion) => void;
  onAdd: AddFn;
  onCitation: (c: Citation) => void;
  onDismiss: (g: Suggestion) => void;
  onReport: (g: Suggestion) => void;
  onGoToPage: (pageId: string) => void;
}) {
  const [scope, setScope] = useState<'page' | 'book'>('page');
  return (
    <div className="suggest-tab">
      <div className="suggest-scope" role="tablist">
        <button role="tab" aria-selected={scope === 'page'} className={scope === 'page' ? 'active' : ''} onClick={() => setScope('page')}>
          This page
        </button>
        <button role="tab" aria-selected={scope === 'book'} className={scope === 'book' ? 'active' : ''} onClick={() => setScope('book')}>
          Whole notebook
        </button>
      </div>
      {scope === 'book' ? (
        <NotebookBrowser notebook={notebook} onGoToPage={onGoToPage} onAdd={onAdd} onCitation={onCitation} onDismiss={onDismiss} onReport={onReport} />
      ) : (
        <>
          {unlinked ? (
            <div className="empty">
              <b>Not linked to a lecture yet</b>
              <p>Write something and Notebook links the page to a lecture, or choose one from the chip above the page.</p>
            </div>
          ) : gaps.length === 0 ? (
            <div className="empty">
              <b>Nothing to suggest on this page</b>
              <p>When classmates’ notes cover something you missed, a suggestion appears in the page as you write.</p>
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
        </>
      )}
    </div>
  );
}

/**
 * Every suggestion in the notebook, grouped by the page it sits on: what it suggests, where it is,
 * and the note behind it. Opening one shows the source — the classmate's actual handwriting when
 * there is one — so a suggestion can be judged before it is accepted.
 */
function NotebookBrowser({
  notebook,
  onGoToPage,
  onAdd,
  onCitation,
  onDismiss,
  onReport,
}: {
  notebook: Notebook;
  onGoToPage: (pageId: string) => void;
  onAdd: AddFn;
  onCitation: (c: Citation) => void;
  onDismiss: (g: Suggestion) => void;
  onReport: (g: Suggestion) => void;
}) {
  const [data, setData] = useState<NotebookSuggestions | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const load = useRef(0);

  useEffect(() => {
    const n = ++load.current;
    setData(null);
    api<NotebookSuggestions>(`/api/notebooks/${notebook.id}/suggestions`)
      .then((d) => n === load.current && setData(d))
      .catch((e) => n === load.current && setError((e as Error).message));
  }, [notebook.id]);

  const rows = (data?.groups ?? [])
    .map((g) => ({ ...g, items: g.items.filter((i) => !gone.has(i.id)) }))
    .filter((g) => g.items.length > 0);
  const total = rows.reduce((n, g) => n + g.items.length, 0);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="suggest-loading">Looking through your notebook…</div>;
  if (!total)
    return (
      <div className="empty">
        <b>Nothing waiting anywhere in this notebook</b>
        <p>Suggestions appear on pages that are linked to a slide, once classmates’ notes cover something you missed.</p>
      </div>
    );

  return (
    <div className="nb-browse">
      <div className="nb-browse-head">{total === 1 ? '1 suggestion' : `${total} suggestions`} in this notebook</div>
      {rows.map((g) => (
        <section key={g.pageId} className="nb-group">
          <header className="nb-group-head">
            <img className="nb-thumb" src={g.thumb} alt="" loading="lazy" />
            <b>{g.pageLabel}</b>
            <span className="muted small">
              {g.items.length === 1 ? '1 suggestion' : `${g.items.length} suggestions`}
            </span>
            <button className="nb-go" onClick={() => onGoToPage(g.pageId)}>
              Go to page
            </button>
          </header>
          <ul className="nb-items">
            {g.items.map((s) => {
              const isOpen = open === s.id;
              return (
                <li key={s.id} className={`nb-item ${isOpen ? 'open' : ''}`}>
                  <button className="nb-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)}>
                    <span className={`suggest-dot ${s.source}`} />
                    <span className="nb-what">
                      <b>{s.missing}</b>
                      <small>
                        {s.sourceLine} · {s.title}
                      </small>
                    </span>
                    <span className="nb-chev">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="nb-detail">
                      <Md text={s.body || s.title} />
                      {/* The original note behind the suggestion, when there is one to see. */}
                      {s.fragmentId && (
                        <figure className="nb-source">
                          <img src={`/api/fragments/${s.fragmentId}/crop.png`} alt="The classmate's handwriting this came from" loading="lazy" />
                          <figcaption>A classmate’s original note</figcaption>
                        </figure>
                      )}
                      {s.citations.length > 0 && (
                        <div className="citations">
                          {s.citations.map((c, i) => (
                            <button key={i} className={`cite cite-${c.kind}`} onClick={() => onCitation(c)}>
                              {c.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <footer>
                        <button
                          className="btn small primary"
                          onClick={() => {
                            onAdd(g.pageId, { title: s.title, body: s.body, source: s.source, citations: s.citations }, s.bbox, { id: s.id, missing: s.missing });
                            setGone((v) => new Set(v).add(s.id));
                            setOpen(null);
                          }}
                        >
                          Add to that page
                        </button>
                        <button className="btn small ghost" onClick={() => onGoToPage(g.pageId)}>
                          Open the page
                        </button>
                        <button
                          className="btn small ghost"
                          onClick={() => {
                            onDismiss(s);
                            setGone((v) => new Set(v).add(s.id));
                            setOpen(null);
                          }}
                        >
                          Dismiss
                        </button>
                        {s.entryId && (
                          <button
                            className="btn small ghost"
                            onClick={() => {
                              onReport(s);
                              setGone((v) => new Set(v).add(s.id));
                              setOpen(null);
                            }}
                          >
                            Looks wrong
                          </button>
                        )}
                      </footer>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

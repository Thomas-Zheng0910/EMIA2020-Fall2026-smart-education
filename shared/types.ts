export type AccountRole = 'student' | 'professor';
export type Student = { id: string; name: string; initials: string; color: string; role: AccountRole };
export type Course = {
  id: string;
  code: string;
  name: string;
  description: string;
  instructorName?: string | null;
  /** This account's role in the course; instructor can publish official slides and go live. */
  myRole?: 'student' | 'instructor' | null;
};
export type CourseSummary = Course & {
  lectureCount: number;
  notebookCount: number;
  memberCount: number;
  cover: string | null;
  lastActive: string | null;
};
export type LectureStatus = 'rendering' | 'digesting' | 'ready' | 'failed';
export type LectureProgress = { notebookId: string | null; written: number; peerNotes: number; updatedAt: string | null };
export type Lecture = {
  id: string;
  courseId: string;
  number: number;
  title: string;
  pageCount: number;
  status: LectureStatus;
  error: string | null;
  digested: number;
  /** Named topics for this lecture, built from its slide digests (coverage views, future Quiz me). */
  topics?: LectureTopic[];
  progress?: LectureProgress;
};
export type SlideDigest = { title: string; summary: string; formulas: string[]; topics: string[] };
export type Slide = {
  id: string;
  lectureId: string;
  page: number;
  width: number;
  height: number;
  text: string;
  digest: SlideDigest | null;
};

export type Tool = 'pen' | 'highlighter';
/** Where a copied object came from. Direct shares are editable, but the AI bank only reads `own`. */
export type InkOrigin = 'own' | 'shared';
/** Provenance every stroke and item can carry once a note is copied or co-owned. */
export type ObjectMeta = {
  authorId?: string;
  origin?: InkOrigin;
  /** The source object's id, for objects copied by a share. */
  sourceId?: string;
  /** Set when the owner of this copy edited a shared object; updates leave it alone. */
  localModified?: boolean;
  lastEditedBy?: string;
};
/** Points are flat [x, y, pressure, ...] in page units (page width = 1000). */
export type Stroke = { id: string; tool: Tool; color: string; size: number; points: number[] } & ObjectMeta;
export type Citation =
  | { kind: 'slide'; slideId: string; lectureNumber: number; page: number; label: string }
  | { kind: 'entry'; entryId: string; slideId: string; lectureNumber: number; page: number; label: string }
  | { kind: 'fragment'; fragmentId: string; author: string; label: string };
export type Basis = 'official' | 'peer' | 'ai';
/** What a suggestion is grounded in, in the order the card prefers them. */
export type SuggestionSource = 'peer' | 'slide' | 'ai';

export type Item =
  | ({
      id: string;
      type: 'text';
      x: number;
      y: number;
      w: number;
      text: string;
      color: string;
      size: number;
      /** Rule spacing this box was written against, so typed lines sit on the paper instead of over it. */
      lineHeight?: number;
    } & ObjectMeta)
  | ({ id: string; type: 'image'; x: number; y: number; w: number; h: number; fileId: string } & ObjectMeta)
  /**
   * A memo: a small note the student sticks onto the page — a reminder, a question to ask, something
   * from elsewhere. It is the student's own writing, so unlike an annotation it is not excluded from
   * indexing and it can be shared as their knowledge.
   */
  | ({
      id: string;
      type: 'memo';
      x: number;
      y: number;
      w: number;
      text: string;
      color: string;
      size: number;
      /** Tint family, picked from a small set so memos read as one kind of thing. */
      tint: MemoTint;
      collapsed?: boolean;
    } & ObjectMeta)
  | ({
      id: string;
      type: 'annotation';
      x: number;
      y: number;
      w: number;
      title: string;
      body: string;
      /** Where the text came from, in neutral words: a classmate, the slides, or the AI. */
      source: SuggestionSource;
      citations: Citation[];
      collapsed?: boolean;
      /** Set when the item was added at a gap: the marker it answers, so the page can draw a tie. */
      gapId?: string | null;
      /** The gap in the student's own words, shown above the quoted text. */
      forGap?: string | null;
    } & ObjectMeta);

/** Sticky-note tints. A student's own memos are paper, not UI, so the set stays small and warm. */
export type MemoTint = 'yellow' | 'pink' | 'blue' | 'green';

/** Paper a student can choose for a notebook. */
export type PaperKind = 'ruled' | 'grid' | 'blank';
export type PageKind = 'slide' | 'pdf' | PaperKind;
export type IndexStatus = 'idle' | 'queued' | 'indexing' | 'indexed' | 'failed';
export type PageLink = {
  lectureId: string | null;
  slideId: string | null;
  confidence: number;
  confirmed: boolean;
  slidePage?: number | null;
};
export type Page = {
  id: string;
  notebookId: string;
  position: number;
  kind: PageKind;
  slideId: string | null;
  background: string | null; // relative URL to background image
  /** Server-side raw asset path; not sent to the client (the API strips it). */
  image?: string | null;
  width: number;
  height: number;
  strokes: Stroke[];
  items: Item[];
  revision: number;
  indexStatus: IndexStatus;
  indexError: string | null;
  link: PageLink;
  sharedCount: number;
  linkedSlides: number;
  /** `shared` when this page is a copy received through a direct share. */
  origin?: InkOrigin;
  /** The page in the source notebook this copy was made from. */
  sourcePageId?: string | null;
  sourceRevision?: number | null;
  /** Source object ids the recipient erased; a later pull must not bring them back. */
  sharedTombstones?: string[];
};
/** How a received copy relates to the note it came from. */
export type ShareMode = 'pull' | 'snapshot';
export type NotebookShare = {
  id: string;
  mode: ShareMode;
  fromName: string;
  sourceNotebookId: string;
  sourceRevision: number;
  currentSourceRevision: number;
  updatesAvailable: boolean;
  sourceDeleted: boolean;
};
export type NotebookMember = {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: 'owner' | 'editor';
  status: 'active' | 'invited';
  pageId?: string | null;
  updatedAt?: string | null;
};
export type Notebook = {
  id: string;
  courseId: string;
  /** The owner/creator. Kept for older clients; the same value as ownerId. */
  studentId: string;
  ownerId?: string;
  lectureId: string | null;
  title: string;
  kind: 'lecture' | 'pdf' | 'blank' | 'shared' | 'group';
  pageCount: number;
  cover: string | null;
  updatedAt: string;
  /** Folder inside "My notes"; null = top level. */
  folderId: string | null;
  /** Paper new pages are made from. A lecture or PDF notebook keeps its pages' own paper. */
  paper: PaperKind;
  /** Pages with the student's ink or text (listing only). */
  written?: number;
  /** Most recently edited page with content (listing only). */
  lastPageId?: string | null;
  /** Content version, bumped on every page change; used by pullable copies. */
  revision?: number;
  /** Direct-share provenance, stored on a received copy or a group note grown from one. */
  shareId?: string | null;
  sourceNotebookId?: string | null;
  sourceRevision?: number;
  shareMode?: ShareMode | null;
  /** This student's relationship to the notebook. */
  role?: 'owner' | 'editor';
  memberCount?: number;
  members?: NotebookMember[];
  /** Set when this notebook is a copy received through a direct share. */
  share?: NotebookShare | null;
};
/** A student's own folder inside "My notes" of one course. */
export type Folder = { id: string; courseId: string; parentId: string | null; name: string };

/** An official lecture deck: one shared record per course, plus this student's notebook once they open it. */
export type Deck = {
  lectureId: string;
  courseId: string;
  number: number;
  title: string;
  pageCount: number;
  status: LectureStatus;
  /** This student's editable notebook, or null until they open the deck. */
  notebookId: string | null;
  /** Where the deck is filed for this student; unopened decks sit in the course's Lectures folder. */
  folderId: string | null;
  /** Slides the student wrote on. */
  written: number;
  lastPageId: string | null;
  updatedAt: string | null;
};
/** Where a course's files are: their folders, their notebooks, and the official decks. */
export type CourseFiles = {
  /** The folder the decks were seeded into, while it still exists (null once renamed away or deleted). */
  lecturesFolderId: string | null;
  /** The loose "Shared with me" folder, created on the first received copy. */
  sharedFolderId?: string | null;
  unreadShares?: number;
  folders: Folder[];
  notes: Notebook[];
  decks: Deck[];
};

export type PrivateReason = 'unclear' | 'unlinked' | 'on_slide' | 'withheld';
export type FragmentKind = 'explanation' | 'example' | 'derivation' | 'definition' | 'question' | 'other';
export type Fragment = {
  id: string;
  pageId: string;
  studentId: string;
  authorName: string;
  authorColor: string;
  courseId: string;
  lectureId: string | null;
  slideId: string | null;
  kind: FragmentKind;
  text: string;
  topic: string;
  confidence: number;
  bbox: [number, number, number, number]; // normalized 0..1
  shared: boolean;
  /** Why an item is private: unreadable, uncertain link, repeats the slide, or the author stopped sharing it. */
  reason: PrivateReason | null;
  /** The knowledge base entry this note feeds, once the merge job has grouped it. */
  entryId: string | null;
  createdAt: string;
};

export type AskCard = {
  id: string;
  title: string;
  body: string;
  source: SuggestionSource;
  citations: Citation[];
  conflict: string | null;
};

/**
 * One point of knowledge on a slide, written by the merge job from the notes that make it.
 * Students never see the sources listed; they see the summary and a neutral source line.
 */
export type KnowledgeEntry = {
  id: string;
  lectureId: string;
  slideId: string;
  title: string;
  summary: string;
  /** How many classmates' notes feed it; 1 means the summary is one note verbatim. */
  sourceCount: number;
  /** True when the AI judged it to contradict the slide; excluded from suggestions and prompts. */
  disputed: boolean;
  disputeExplanation: string | null;
};

/** A gap in a page's notes, with the content that fills it. */
export type Suggestion = {
  /** The gap's id (stable while the page is unchanged) — what Dismiss and Add refer to. */
  id: string;
  pageId: string;
  /** Where on the page the gap sits, normalized 0..1. */
  bbox: [number, number, number, number];
  missing: string;
  source: SuggestionSource;
  /** Neutral, student-facing line: "From 3 classmates' notes", "From slide 12", "AI explanation". */
  sourceLine: string;
  title: string;
  /** Empty when the card still needs a fill-gap call (source 'ai' with nothing prepared yet). */
  body: string;
  citations: Citation[];
  entryId: string | null;
  /** A classmate's note to crop for the original handwriting, when the entry is single-source. */
  fragmentId: string | null;
};

/**
 * One suggestion anywhere in a notebook, for the browser: the same card, plus where in the notebook
 * it lives, so a student can see everything waiting for them without scrolling page by page.
 */
export type NotebookSuggestion = Suggestion & {
  pageNumber: number;
  /** "Slide 12" for a page that came from a deck, "Page 3" for one of the student's own sheets. */
  pageLabel: string;
  /** Drives the thumbnail in the list: an image of the page as it is now. */
  thumb: string;
};

export type NotebookSuggestions = {
  notebookId: string;
  /** Grouped by page, in the notebook's own order, so the list reads like the notebook does. */
  groups: { pageId: string; pageNumber: number; pageLabel: string; thumb: string; items: NotebookSuggestion[] }[];
  total: number;
};

/** A student's own contribution on a page, as the panel lists it for the author. */
export type OwnNote = {
  id: string;
  text: string;
  state: 'shared' | 'private' | 'disputed';
  sourceLine: string;
  disputeExplanation: string | null;
};

export type PageSuggestions = {
  pageId: string;
  gaps: Suggestion[];
  own: OwnNote[];
  /** Set when the page is not linked to a slide yet, so there is nothing to suggest against. */
  unlinked: boolean;
};

export type LectureTopic = { id: string; name: string; slideIds: string[] };
export type AskMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: AskCard[];
  pageId: string | null;
  pageLabel: string | null;
  createdAt: string;
};
export type AskSessionSummary = {
  id: string;
  notebookId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastPageLabel: string | null;
};
export type AskSession = AskSessionSummary & { messages: AskMessage[] };
export type AskResult = { id: string; pageId: string; pageRevision: number; cards: AskCard[] };

export type QuizScope = { kind: 'lecture' | 'page' | 'selection'; lectureId: string; pageId?: string };
export type QuizQuestion = {
  id: string;
  question: string;
  options: string[];
  citations: Citation[];
};
export type Quiz = { id: string; scope: QuizScope; questions: QuizQuestion[] };
export type QuizResult = {
  score: number;
  total: number;
  results: { questionId: string; correct: boolean; correctIndex: number; explanation: string }[];
};

export type RecentNotebook = { id: string; title: string; kind: string; courseId: string; courseCode: string; updatedAt: string; lastPageId: string | null };

/** A copy that has arrived but has not been announced to the recipient yet. */
export type ShareNotice = {
  shareId: string;
  notebookId: string;
  courseId: string;
  fromName: string;
  title: string;
  mode: ShareMode;
  kind: 'copy' | 'live';
  createdAt: string;
};
/** A co-edit invitation waiting for the recipient. */
export type InviteNotice = {
  notebookId: string;
  courseId: string;
  fromName: string;
  title: string;
  createdAt: string;
};

export type LiveSession = {
  id: string;
  courseId: string;
  hostId: string;
  hostName: string;
  notebookId: string;
  title: string;
  currentPageId: string | null;
  currentPageLabel: string | null;
  renderVersion: string;
  pullable: boolean;
  startedAt: string;
  endedAt: string | null;
  audience: number;
  /** The copy the viewer will get (or already has) after the session ends. */
  copyNotebookId?: string | null;
};
export type Notices = {
  shares: ShareNotice[];
  invites: InviteNotice[];
  live: LiveSession | null;
};

export type Bootstrap = {
  recent: RecentNotebook[];
  courses: CourseSummary[];
  enrolled: string[];
  course: Course | null;
  lectures: Lecture[];
  students: Student[];
  me: Student;
  ai: { configured: boolean; model: string | null };
};

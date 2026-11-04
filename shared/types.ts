export type Student = { id: string; name: string; initials: string; color: string };
export type Course = { id: string; code: string; name: string; description: string };
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
/** Points are flat [x, y, pressure, ...] in page units (page width = 1000). */
export type Stroke = { id: string; tool: Tool; color: string; size: number; points: number[] };
export type Citation =
  | { kind: 'slide'; slideId: string; lectureNumber: number; page: number; label: string }
  | { kind: 'entry'; entryId: string; slideId: string; lectureNumber: number; page: number; label: string }
  | { kind: 'fragment'; fragmentId: string; author: string; label: string };
export type Basis = 'official' | 'peer' | 'ai';
/** What a suggestion is grounded in, in the order the card prefers them. */
export type SuggestionSource = 'peer' | 'slide' | 'ai';

export type Item =
  | { id: string; type: 'text'; x: number; y: number; w: number; text: string; color: string; size: number }
  | { id: string; type: 'image'; x: number; y: number; w: number; h: number; fileId: string }
  | {
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
    };

export type PageKind = 'slide' | 'pdf' | 'blank' | 'ruled' | 'grid';
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
};
export type Notebook = {
  id: string;
  courseId: string;
  studentId: string;
  lectureId: string | null;
  title: string;
  kind: 'lecture' | 'pdf' | 'blank';
  pageCount: number;
  cover: string | null;
  updatedAt: string;
  /** Folder inside "My notes"; null = top level. */
  folderId: string | null;
  /** Pages with the student's ink or text (listing only). */
  written?: number;
  /** Most recently edited page with content (listing only). */
  lastPageId?: string | null;
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
export type Bootstrap = {
  recent: RecentNotebook[];
  courses: CourseSummary[];
  enrolled: string[];
  course: Course | null;
  lectures: Lecture[];
  students: Student[];
  ai: { configured: boolean; model: string | null };
};

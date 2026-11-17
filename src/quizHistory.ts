import { useSyncExternalStore } from "react";
import { api } from "./api";
import { QuizRecord } from "./quiz";

/* Finished quizzes live on the notes they covered, in canvas.quizHistory. The open note writes
   through the editor (so autosave and undo of other edits stay in one place); other notes are
   loaded, appended to and saved. */

export const QUIZ_HISTORY_MAX = 30;

export type OpenQuizNote = {
  path: string;
  title: string;
  history: QuizRecord[];
  /** Add or replace `record`, or with null remove the record `id`. */
  write: (record: QuizRecord | null, id?: string) => void;
};

let open: OpenQuizNote | null = null;
const listeners = new Set<() => void>();

export function setOpenQuizNote(next: OpenQuizNote | null) {
  open = next;
  listeners.forEach((fn) => fn());
}

export function openQuizNote(): OpenQuizNote | null {
  return open;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useOpenQuizNote(): OpenQuizNote | null {
  return useSyncExternalStore(subscribe, openQuizNote);
}

export function quizHistoryOf(list: unknown): QuizRecord[] {
  return Array.isArray(list) ? (list as QuizRecord[]).filter((r) => r && Array.isArray(r.cards) && r.report) : [];
}

export function withQuiz(list: unknown, record: QuizRecord | null, id?: string): QuizRecord[] {
  const cur = quizHistoryOf(list);
  const drop = record?.id ?? id;
  const kept = cur.filter((r) => r.id !== drop);
  return (record ? [...kept, record] : kept).slice(-QUIZ_HISTORY_MAX);
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** Save the quiz on every note it covered. Returns how many notes took it. */
export async function recordQuiz(paths: string[], record: QuizRecord): Promise<number> {
  let saved = 0;
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (!path.trim() || seen.has(key)) continue;
    seen.add(key);
    try {
      if (open && samePath(open.path, path)) {
        open.write(record);
        saved += 1;
        continue;
      }
      const note = await api.loadNote(path);
      if (note.read_only) continue;
      note.doc.canvas.quizHistory = withQuiz(note.doc.canvas.quizHistory, record);
      await api.saveNote(note);
      saved += 1;
    } catch {
      /* A note that cannot be written keeps no history; the quiz itself still shows. */
    }
  }
  return saved;
}

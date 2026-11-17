import { PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, newId, Paragraph } from "./api";
import {
  ATTACHED_LINE,
  BriefDepth,
  BriefTask,
  DEPTHS,
  TASKS,
  buildPrompt,
  hitSnippet,
  matchLine,
  noteText,
  summaryHtml,
  wordCount,
} from "./brief";
import { askInBackground, CHAT_NAME, ChatHost, savableNotePath } from "./chat";
import { IcAttach, IcClose, IcDoc, IcSend } from "./icons";
import { QuizDesk } from "./QuizDesk";
import {
  chatQuizPrompt,
  loadQuizPrefs,
  parseCards,
  parseReview,
  QUIZ_COUNTS,
  QUIZ_KINDS,
  QuizCard,
  QuizCount,
  QuizKind,
  QuizRecord,
  QuizReport,
  QuizScope,
  quizGradePrompt,
  quizScore,
  quizStudyPrompt,
} from "./quiz";
import { recordQuiz } from "./quizHistory";
import { ProviderSwitch, useDefaultHost } from "./StudyMenu";

/** A quiz started from the Study menu: what to ask, and for the marked-area scope, the pictures. */
export type QuizStart = {
  count: QuizCount;
  kind: QuizKind;
  scope: QuizScope;
  /** Rendered PNGs of the marked area (noteRender), attached instead of whole notes. */
  images?: string[];
  areaNote?: string;
  areaTitle?: string;
  /** Write the cards as soon as the notes are read. */
  autoStart?: boolean;
};

type Prefs = { task: BriefTask; depth: BriefDepth; lane: ChatHost };

function loadPrefs(): Prefs {
  const fallback: Prefs = { task: "sheet", depth: "study", lane: "claude" };
  try {
    const saved = JSON.parse(localStorage.getItem("pl.brief.prefs") ?? "{}") as Partial<Prefs>;
    return {
      task: TASKS.some((t) => t.id === saved.task) ? saved.task! : fallback.task,
      depth: DEPTHS.some((d) => d.id === saved.depth) ? saved.depth! : fallback.depth,
      lane: saved.lane === "gemini" || saved.lane === "chatgpt" ? saved.lane : "claude",
    };
  } catch {
    return fallback;
  }
}

type Row = {
  path: string;
  title: string;
  notebook?: string | null;
  text: string;
  checked: boolean;
  why: string;
};

type Props = {
  notebookPath?: string;
  notebookName?: string;
  initialPaths: string[];
  onClose: () => void;
  onOpenNote: (path: string, notebookPath?: string | null) => void;
  onToast: (msg: string) => void;
  /** Open the in-app browser beside the note and attach the real files. */
  onAskHere: (host: ChatHost, notePaths: string[], question: string) => void;
  quiz?: QuizStart;
};

export function BriefView({ notebookPath, notebookName, initialPaths, onClose, onOpenNote, onToast, onAskHere, quiz }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState("");
  const [prefs] = useState(loadPrefs);
  const [task, setTask] = useState<BriefTask>(quiz ? "quiz" : prefs.task === "quiz" ? "sheet" : prefs.task);
  const [quizPrefs] = useState(loadQuizPrefs);
  const [quizCount, setQuizCount] = useState<QuizCount>(quiz?.count ?? quizPrefs.count);
  const [quizKind, setQuizKind] = useState<QuizKind>(quiz?.kind ?? quizPrefs.kind);
  const areaImages = quiz?.images?.length ? quiz.images : null;
  const answersRef = useRef<Record<string, string>>({});
  const autoRef = useRef(!!quiz?.autoStart);
  const [depth, setDepth] = useState<BriefDepth>(prefs.depth);
  // The AI is the one the Study menu, the quick field and the Ask pane share.
  const lane = useDefaultHost();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState("");
  const [cards, setCards] = useState<QuizCard[] | null>(null);
  const [report, setReport] = useState<QuizReport | null>(null);
  const [error, setError] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [promptKey, setPromptKey] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [resultView, setResultView] = useState<"read" | "text">("read");
  const [leftW, setLeftW] = useState(420);
  const [topH, setTopH] = useState(380);
  const [floated, setFloated] = useState(false);
  const [floatBox, setFloatBox] = useState(() => ({
    x: Math.max(24, window.innerWidth - 580),
    y: 64,
    w: 540,
    h: Math.min(740, Math.max(420, window.innerHeight - 110)),
  }));
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const primaryRef = useRef<() => void>(() => {});

  useEffect(() => {
    localStorage.setItem("pl.brief.prefs", JSON.stringify({ task, depth, lane } satisfies Prefs));
  }, [task, depth, lane]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        primaryRef.current();
      } else if (e.key === "Escape") {
        if (e.target instanceof HTMLTextAreaElement) e.target.blur();
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        if (notebookPath) {
          const info = await api.openNotebook(notebookPath);
          if (cancel) return;
          const wanted = new Set(initialPaths);
          const listed: Row[] = info.notes.map((n) => ({
            path: n.path,
            title: n.display_title || n.title || "Untitled",
            text: "",
            checked: wanted.has(n.path) || (wanted.size === 0 && info.notes.length === 1),
            why: "",
          }));
          setRows(listed);
          const texts = await mapPool(info.notes, 4, async (n) => {
            try {
              const note = await api.loadNote(n.path);
              return noteText(note);
            } catch {
              return "";
            }
          });
          if (cancel) return;
          setRows((cur) => cur.map((r, i) => ({ ...r, text: texts[i] ?? "" })));
        } else if (initialPaths.length) {
          const loaded = await mapPool(initialPaths, 4, async (p) => {
            const note = await api.loadNote(p);
            return {
              path: p,
              title: note.display_title || note.title || "Untitled",
              text: noteText(note),
              checked: true,
              why: "",
            } satisfies Row;
          });
          if (!cancel) setRows(loaded);
        }
      } catch (e) {
        if (!cancel) onToast(String(e));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
    // initialPaths is joined so a fresh array from the parent does not reload the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookPath, initialPaths.join("|"), onToast]);

  useEffect(() => {
    if (notebookPath || initialPaths.length) return;
    const q = topic.trim();
    if (q.length < 2) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancel = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const hits = await api.searchGlobal(q);
        if (cancel) return;
        const seen = new Set<string>();
        const next: Row[] = [];
        for (const hit of hits) {
          if (seen.has(hit.note_path)) continue;
          seen.add(hit.note_path);
          next.push({
            path: hit.note_path,
            title: hit.note_title || "Untitled",
            notebook: hit.notebook_name,
            text: "",
            checked: true,
            why: hitSnippet(hit),
          });
          if (next.length >= 24) break;
        }
        setRows(next);
        const texts = await mapPool(next, 4, async (row) => {
          try {
            return noteText(await api.loadNote(row.path));
          } catch {
            return "";
          }
        });
        if (cancel) return;
        setRows((cur) => cur.map((r, i) => ({ ...r, text: texts[i] ?? r.text })));
      } catch (e) {
        if (!cancel) onToast(String(e));
      } finally {
        if (!cancel) setLoading(false);
      }
    }, 280);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [topic, notebookPath, initialPaths.length, onToast]);

  const q = topic.trim().toLowerCase();
  const homeSearch = !notebookPath && initialPaths.length === 0;
  const visible = useMemo(() => {
    if (homeSearch || !q) return rows;
    return rows.filter((r) => r.title.toLowerCase().includes(q) || r.text.toLowerCase().includes(q));
  }, [rows, q, homeSearch]);

  const picked = rows.filter((r) => r.checked);
  const pickedWords = picked.reduce((n, r) => n + wordCount(r.text), 0);
  const sheetTitle = topic.trim() || picked[0]?.title || "Study sheet";

  const notesFor = (typedOnly: boolean) =>
    rows.filter((r) => r.checked && (!typedOnly || r.text.trim())).map((r) => ({ title: r.title, text: r.text }));

  /* The prompt shown is the one for the chat beside the note, where the notes go as files. */
  const generated = useMemo(() => {
    const notes = rows.filter((r) => r.checked).map((r) => ({ title: r.title, text: r.text }));
    if (!notes.length && !(task === "quiz" && areaImages)) return null;
    if (task === "quiz") {
      const prompt = quizStudyPrompt({ count: quizCount, kind: quizKind, topic, notes, attached: true, area: !!areaImages });
      return { prompt, file: "", pastedAll: true };
    }
    return buildPrompt({ task, depth, topic, notes, attached: true });
  }, [rows, task, depth, topic, quizCount, quizKind, areaImages]);
  const generatedKey = `${task}|${depth}|${quizCount}|${quizKind}|${topic}|${rows
    .filter((r) => r.checked)
    .map((r) => `${r.path}:${r.text.length}`)
    .join(",")}`;

  useEffect(() => {
    if (!generated || generatedKey === promptKey) return;
    setPromptDraft(generated.prompt);
    setPromptKey(generatedKey);
  }, [generated, generatedKey, promptKey]);

  /** Written here, the chat gets no files, so the notes' text replaces the line about them. */
  const inlinePrompt = () => {
    const inline = buildPrompt({ task, depth, topic, notes: notesFor(true) }).prompt;
    const notesBlock = inline.slice(inline.indexOf("Notes:\n"));
    const draft = promptDraft.trim();
    const at = draft.indexOf(ATTACHED_LINE);
    if (!draft) return inline;
    return at >= 0 ? `${draft.slice(0, at).trimEnd()}\n\n${notesBlock}` : `${draft}\n\n${notesBlock}`;
  };

  const requireNotes = (typedOnly: boolean) => {
    if (!typedOnly && task === "quiz" && areaImages) {
      setError("");
      return true;
    }
    if (!picked.length) {
      setError("Check at least one note.");
      return false;
    }
    if (typedOnly && !picked.some((r) => r.text.trim())) {
      setError("The checked notes have no typed text. Send them beside the note instead: the chat gets the pages as PDFs.");
      return false;
    }
    setError("");
    return true;
  };

  const openWeb = (which: ChatHost) => {
    if (!requireNotes(false)) return;
    const prompt =
      task === "quiz"
        ? chatQuizPrompt({ count: quizCount, kind: quizKind, topic })
        : promptDraft.trim() || buildPrompt({ task, depth, topic, notes: notesFor(false), attached: true }).prompt;
    onAskHere(which, picked.map((r) => r.path), prompt);
  };

  const writeHere = async () => {
    if (busy || !requireNotes(true)) return;
    setBusy("write");
    setError("");
    setStatus(`${CHAT_NAME[lane]} is writing it…`);
    setResult("");
    setResultView("read");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = "";
    try {
      const reply = await askInBackground({
        host: lane,
        text: inlinePrompt(),
        fresh: true,
        signal: ctrl.signal,
        onText: (soFar) => {
          text = soFar;
          setResult(soFar);
        },
      });
      text = reply.text || text;
      setResult(text);
      setStatus(
        ctrl.signal.aborted
          ? text
            ? "Stopped. What arrived so far is below."
            : "Stopped."
          : "Done. Save it as a PDF or as a note, or copy it.",
      );
    } catch (e) {
      setStatus("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setBusy(null);
      void api.quickRelease();
    }
  };

  const makeCards = async () => {
    if (busy || !requireNotes(false)) return;
    setBusy("write");
    setError("");
    setCards(null);
    setReport(null);
    setResult("");
    setStatus(`${CHAT_NAME[lane]} is writing the cards…`);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const notes = notesFor(false);
      const canonical = quizStudyPrompt({ count: quizCount, kind: quizKind, topic, notes, attached: false, area: !!areaImages });
      const edited = promptDraft.trim() && generated && promptDraft !== generated.prompt;
      const notesAt = areaImages && !notes.length ? -1 : canonical.indexOf("Notes:");
      const prompt =
        edited && notesAt >= 0 ? `${promptDraft.trim()}\n\n${canonical.slice(notesAt)}` : canonical;
      const reply = await askInBackground({
        host: lane,
        text: prompt,
        fresh: true,
        notePaths: picked.length ? picked.map((r) => r.path) : undefined,
        filePaths: areaImages ?? undefined,
        signal: ctrl.signal,
        onText: () => setStatus(`${CHAT_NAME[lane]} is writing the cards…`),
      });
      if (ctrl.signal.aborted) {
        setStatus(reply.text ? "Stopped." : "Stopped.");
        return;
      }
      const parsed = parseCards(reply.text);
      if (!parsed.length) {
        setResult(reply.text);
        setError("The reply didn't include cards the app could read. The text is below.");
        setStatus("");
        return;
      }
      answersRef.current = {};
      setCards(parsed);
      setStatus("Answer the cards, then submit them for review.");
    } catch (e) {
      setStatus("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setBusy(null);
      void api.quickRelease();
    }
  };

  const gradeCards = async (answers: Record<string, string>) => {
    if (!cards || busy) return;
    answersRef.current = answers;
    setBusy("grade");
    setError("");
    setStatus(`${CHAT_NAME[lane]} is marking the cards…`);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const reply = await askInBackground({
        host: lane,
        text: quizGradePrompt(cards, answers),
        fresh: true,
        signal: ctrl.signal,
        onText: () => {},
      });
      const parsed = parseReview(reply.text, cards);
      if (!parsed) {
        setError("The review didn't come back in a form the app could read. Submit again.");
        setStatus("");
        return;
      }
      setReport(parsed);
      setStatus("");
      const record: QuizRecord = {
        id: newId("q"),
        at: new Date().toISOString(),
        host: lane,
        kind: quizKind,
        count: cards.length,
        scope: quiz?.scope ?? (areaImages ? "area" : picked.length === 1 ? "note" : "notes"),
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        notes: areaImages ? [quiz?.areaTitle || "Marked area"] : picked.map((r) => r.title),
        cards,
        answers: answersRef.current,
        report: parsed,
      };
      const paths = areaImages ? (quiz?.areaNote ? [quiz.areaNote] : []) : picked.map((r) => r.path);
      const score = quizScore(parsed).pct;
      void recordQuiz(paths, record).then((n) => {
        if (n) setStatus(`${score}% · kept in the quiz history of ${n === 1 ? "the note" : `${n} notes`} (Study → Review results).`);
      });
    } catch (e) {
      setStatus("");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setBusy(null);
      void api.quickRelease();
    }
  };

  useEffect(() => {
    if (!autoRef.current || loading || busy) return;
    if (!areaImages && !picked.some((r) => r.text.trim() || savableNotePath(r.path))) return;
    autoRef.current = false;
    void makeCards();
  });

  primaryRef.current = () => {
    if (busy) return;
    if (task === "quiz") {
      void makeCards();
      return;
    }
    if (!promptDraft.trim()) return;
    openWeb(lane);
  };

  const savePdf = async () => {
    if (!result.trim()) return;
    const dest = await saveDialog({
      defaultPath: `${sheetTitle}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!dest) return;
    setBusy("pdf");
    try {
      await api.writeSummaryPdf(sheetTitle, result, dest);
      onToast("PDF saved");
      setStatus(`PDF saved to ${dest}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveNote = async () => {
    if (!result.trim()) return;
    setBusy("note");
    try {
      let path: string;
      if (notebookPath) {
        const made = await api.createNote(notebookPath);
        path = made.path;
      } else {
        path = await api.createBlankNote();
      }
      path = await api.renameNote(path, `Summary — ${sheetTitle}`);
      const note = await api.loadNote(path);
      note.doc.canvas.objects = [
        {
          type: "text",
          id: newId("t"),
          x: 72,
          y: 56,
          z: 1,
          width: 680,
          blocks: summaryBlocks(result),
        },
      ];
      await api.saveNote(note);
      onToast("Summary note saved");
      onOpenNote(path, notebookPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const checkVisible = (on: boolean) => {
    const ids = new Set(visible.map((r) => r.path));
    setRows((cur) => cur.map((r) => (ids.has(r.path) ? { ...r, checked: on } : r)));
  };

  const dragBetween = (e: ReactPointerEvent<HTMLDivElement>, axis: "x" | "y") => {
    e.preventDefault();
    const handle = e.currentTarget;
    const start = axis === "x" ? e.clientX : e.clientY;
    const origin = axis === "x" ? leftW : topH;
    const cap = axis === "x"
      ? (bodyRef.current?.clientWidth ?? 1100) - 300
      : (handle.parentElement?.clientHeight ?? 800) - 160;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const next = origin + ((axis === "x" ? ev.clientX : ev.clientY) - start);
      const clamped = Math.min(Math.max(next, axis === "x" ? 280 : 180), Math.max(axis === "x" ? 280 : 180, cap));
      if (axis === "x") setLeftW(clamped);
      else setTopH(clamped);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const dragFloat = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = floatBox;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(8, origin.x + ev.clientX - startX), window.innerWidth - 160);
      const y = Math.min(Math.max(8, origin.y + ev.clientY - startY), window.innerHeight - 80);
      setFloatBox({ ...origin, x, y });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const resizeFloat = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = floatBox;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setFloatBox({
        ...origin,
        w: Math.max(340, origin.w + ev.clientX - startX),
        h: Math.max(280, origin.h + ev.clientY - startY),
      });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const produced = !!(cards || result);
  const stage = (
    <>
      <div className="brief-col-bar">
        <span>{cards ? "Quiz" : result ? "Summary" : "Result"}</span>
        {!floated && (
          <button className="btn" type="button" disabled={!produced} onClick={() => setFloated(true)}>
            Pop out
          </button>
        )}
      </div>
      {status && <p className="brief-status">{status}</p>}
      {error && <p className="brief-error">{error}</p>}
      {cards && (
        <QuizDesk cards={cards} busy={busy === "grade"} report={report} onSubmit={(answers) => void gradeCards(answers)} />
      )}
      {result && !cards && (
        <div className="brief-result">
          <div className="brief-col-bar">
            <div className="ask-hosts">
              <button type="button" className={resultView === "read" ? "on" : ""} onClick={() => setResultView("read")}>
                Read
              </button>
              <button type="button" className={resultView === "text" ? "on" : ""} onClick={() => setResultView("text")}>
                Markdown
              </button>
            </div>
            <span>{busy === "write" ? "Writing…" : `${wordCount(result).toLocaleString()} words`}</span>
            <button className="btn primary" type="button" disabled={!!busy} onClick={savePdf}>
              {busy === "pdf" ? "Saving…" : "Save PDF"}
            </button>
            <button className="btn" type="button" disabled={!!busy} onClick={saveNote}>
              {busy === "note" ? "Saving…" : notebookPath ? "Save as note" : "Save as note on Home"}
            </button>
            <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(result).then(() => onToast("Copied"))}>
              Copy
            </button>
          </div>
          {resultView === "read" ? (
            <div className="brief-read md-read" dangerouslySetInnerHTML={{ __html: summaryHtml(result) }} />
          ) : (
            <pre>{result}</pre>
          )}
        </div>
      )}
      {!produced && <p className="muted brief-empty">The quiz or the summary shows up here.</p>}
    </>
  );

  const popped = floated && produced;

  return (
    <div className={popped ? "brief-float-host" : "brief-desk"}>
      {!popped && (
      <header key="top" className="brief-top">
        <div>
          <div className="brief-kicker">{quiz ? "Quiz" : "Brief"}</div>
          <h1>{quiz ? (areaImages ? "Quiz me on the marked area" : "Quiz me on the notes you pick") : "Summaries from the notes you pick"}</h1>
          <p>
            {areaImages
              ? `From “${quiz?.areaTitle || "this note"}”: what you selected or marked, as the app draws it.`
              : notebookPath
              ? `Pick notes from ${notebookName || "this notebook"}, choose what to make, and send. Nothing leaves the computer before that.`
              : initialPaths.length
                ? "This note is checked. Add others, choose what to make, and send."
                : "Search a topic across your notebooks, check the notes, and send."}
          </p>
        </div>
        <button className="btn icon" title="Close (Esc)" onClick={onClose}>
          <IcClose size={16} />
        </button>
      </header>
      )}

      <div key="body" className="brief-body" ref={bodyRef}>
        <div key="stack" className="brief-stack" style={{ width: leftW, display: popped ? "none" : undefined }}>
        <section className="brief-col brief-work" style={{ flex: "none", height: topH }}>
          {!quiz && (
          <div className="brief-choices">
            {TASKS.filter((t) => t.id !== "quiz").map((t) => (
              <button
                key={t.id}
                type="button"
                className={`brief-chip ${task === t.id ? "on" : ""}`}
                title={t.hint}
                onClick={() => setTask(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          )}
          {task === "quiz" ? (
            <div className="brief-choices">
              {QUIZ_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`brief-chip ${quizCount === n ? "on" : ""}`}
                  onClick={() => setQuizCount(n)}
                >
                  {n} cards
                </button>
              ))}
              {QUIZ_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className={`brief-chip ${quizKind === k.id ? "on" : ""}`}
                  title={k.hint}
                  onClick={() => setQuizKind(k.id)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          ) : (
          <div className="brief-choices">
            {DEPTHS.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`brief-chip ${depth === d.id ? "on" : ""}`}
                onClick={() => setDepth(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          )}
          <p className="brief-hint">
            {task === "quiz" ? QUIZ_KINDS.find((k) => k.id === quizKind)?.hint : TASKS.find((t) => t.id === task)?.hint}
          </p>

          <ProviderSwitch compact />

          <div className="brief-prompt-bar">
            <span>
              {promptDraft.trim()
                ? `Prompt · ${wordCount(promptDraft).toLocaleString()} words${promptKey && promptDraft !== generated?.prompt ? " · edited" : ""}`
                : picked.length
                  ? "Reading the notes…"
                  : "Check a note to build the prompt"}
            </span>
            {promptDraft.trim() && (
              <button className="btn" type="button" onClick={() => setShowPrompt((v) => !v)}>
                {showPrompt ? "Hide prompt" : "Read or edit"}
              </button>
            )}
            {showPrompt && generated && promptDraft !== generated.prompt && (
              <button className="btn" type="button" onClick={() => setPromptDraft(generated.prompt)}>
                Reset
              </button>
            )}
          </div>
          {showPrompt && (
            <textarea className="brief-prompt-text" value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} />
          )}

          <div className="brief-panel">
            <div className="brief-actions">
              {task === "quiz" ? (
                busy === "write" || busy === "grade" ? (
                  <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    type="button"
                    disabled={(!picked.length && !areaImages) || !!busy}
                    onClick={() => void makeCards()}
                  >
                    Make cards
                  </button>
                )
              ) : (
                <button
                  className="btn primary"
                  type="button"
                  disabled={!promptDraft.trim() || !!busy}
                  title="Places the prompt and notes in the chat beside the note. Press Enter there to send. Ctrl+Enter."
                  onClick={() => openWeb(lane)}
                >
                  <IcSend size={14} /> Prepare in {CHAT_NAME[lane]}
                </button>
              )}
              {task !== "quiz" &&
                (busy === "write" ? (
                  <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>
                    Stop
                  </button>
                ) : (
                  <button className="btn" type="button" disabled={!promptDraft.trim() || !!busy} onClick={writeHere}>
                    Write it here
                  </button>
                ))}
              {task === "quiz" && (
                <button
                  className="btn"
                  type="button"
                  disabled={!picked.length || !!busy}
                  title="Opens Ask beside the note with the checked notes attached; the chat asks one question at a time."
                  onClick={() => openWeb(lane)}
                >
                  <IcSend size={14} /> Quiz in {CHAT_NAME[lane]} chat
                </button>
              )}
            </div>
            {task === "quiz" ? (
              <p className="brief-fine">
                {areaImages
                  ? "Make cards writes the questions from the marked area (sent as pictures). Answer them, then one submit sends the set back for a mark, the solution, and what to revise."
                  : "Make cards writes the questions here from the checked notes. Answer them, then one submit sends the set back for a mark, the solution, and what to revise."}{" "}
                Marked quizzes are kept on the note: Study → Review results.
              </p>
            ) : (
              <>
            <p className="brief-attach-line">
              <IcAttach size={14} />
              {picked.length
                ? `Prepare opens Ask and attaches ${
                    picked.length === 1 ? `“${picked[0].title}”` : `${picked.length} notes`
                  } as PDF and Markdown. Check the message, then press Enter in ${CHAT_NAME[lane]}.`
                : "Prepare opens Ask and attaches the checked notes as PDF and Markdown."}
            </p>
            <p className="brief-fine">
              Write it here keeps the reply in this window (typed text only — drawings and slides stay out), ready to save as a PDF or a note.
            </p>
              </>
            )}
          </div>
        </section>

        <div className="brief-split is-row" title="Drag to resize" onPointerDown={(e) => dragBetween(e, "y")} />

        <section className="brief-col brief-notes">
          {areaImages && (
            <p className="brief-attach-line">
              <IcAttach size={14} />
              {`The marked area goes along as ${areaImages.length === 1 ? "one picture" : `${areaImages.length} pictures`}. Check notes below only to add their full text.`}
            </p>
          )}
          <label className="brief-topic">
            <span>Topic</span>
            <input
              value={topic}
              autoFocus
              placeholder={notebookPath ? "Filter this notebook, or leave blank" : "orbital mechanics"}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <div className="brief-col-bar">
            <span>
              {loading ? "Reading notes…" : `${visible.length} shown · ${picked.length} checked · ${pickedWords.toLocaleString()} words`}
            </span>
            <button className="btn" type="button" onClick={() => checkVisible(true)} disabled={!visible.length}>
              Check shown
            </button>
            <button className="btn" type="button" onClick={() => checkVisible(false)} disabled={!visible.length}>
              Clear
            </button>
          </div>
          <div className="brief-list">
            {!notebookPath && topic.trim().length < 2 && (
              <p className="muted">Type at least two letters. Matches come from note titles and text on Home.</p>
            )}
            {!loading && notebookPath && !visible.length && <p className="muted">No notes match that topic.</p>}
            {!loading && !notebookPath && topic.trim().length >= 2 && !visible.length && (
              <p className="muted">Nothing on Home matches that.</p>
            )}
            {visible.map((r) => {
              const why = homeSearch ? r.why : matchLine(r.text, topic);
              return (
                <label key={r.path} className={`brief-row ${r.checked ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) =>
                      setRows((cur) => cur.map((x) => (x.path === r.path ? { ...x, checked: e.target.checked } : x)))
                    }
                  />
                  <IcDoc size={15} />
                  <span>
                    <strong>{r.title}</strong>
                    {r.notebook && <em>{r.notebook}</em>}
                    {why && <small>{why}</small>}
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        </div>

        <div
          key="vsplit"
          className="brief-split is-col"
          title="Drag to resize"
          style={{ display: popped ? "none" : undefined }}
          onPointerDown={(e) => dragBetween(e, "x")}
        />

        <section
          key="stage"
          className={popped ? "brief-float" : "brief-col brief-stage"}
          style={popped ? { left: floatBox.x, top: floatBox.y, width: floatBox.w, height: floatBox.h } : undefined}
        >
          {popped && (
            <div key="bar" className="brief-float-bar" onPointerDown={dragFloat}>
              <span>{cards ? "Quiz" : "Summary"}</span>
              <button className="btn" type="button" onClick={() => setFloated(false)}>
                Back
              </button>
              <button className="btn icon" title="Close" onClick={onClose}>
                <IcClose size={14} />
              </button>
            </div>
          )}
          <div key="stage-body" className={popped ? "brief-float-body" : "brief-stage-body"}>
            {stage}
          </div>
          {popped && <div key="resize" className="brief-float-resize" title="Drag to resize" onPointerDown={resizeFloat} />}
        </section>
      </div>
    </div>
  );
}

function summaryBlocks(body: string): Paragraph[] {
  return body.split("\n").map((line) => {
    const trimmed = line.trim();
    const heading = /^(#{1,3})\s+/.exec(trimmed);
    const bullet = !heading && (trimmed.startsWith("- ") || trimmed.startsWith("* "));
    const text = heading ? trimmed.slice(heading[0].length) : bullet ? trimmed.slice(2) : line;
    const size = heading ? (heading[1].length === 1 ? 18 : 14) : 12;
    return {
      kind: "p",
      bullet: bullet ? "disc" : null,
      align: "left",
      runs: [{ text, ...(heading ? { b: true, size } : { size }) }],
    };
  });
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

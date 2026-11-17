import { KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CHAT_HOSTS, CHAT_NAME, ChatHost, defaultHost, setDefaultHost, subscribeDefaultHost } from "./chat";
import { checkSignIn, SIGNIN_LABEL, SignIn, useSignIn } from "./chatStatus";
import { loadQuizPrefs, QUIZ_COUNTS, QUIZ_KINDS, QuizPrefs, QuizScope, saveQuizPrefs } from "./quiz";
import { openQuizNote, useOpenQuizNote } from "./quizHistory";
import { MenuItem, Modal } from "./ui";

/* One Study menu for the AI tools: the toolbar button, Ctrl+J and the canvas right-click all
   show the same entries. The App registers what each entry does. */

export type StudyActions = {
  askOpen: boolean;
  /** Open or close the chat beside the note. */
  onAskPane: () => void;
  onQuiz: () => void;
  /** Brief: study sheet, formulas, explain from picked notes. */
  onBrief: () => void;
  onReview: () => void;
};

let actions: StudyActions | null = null;

export function setStudyActions(next: StudyActions | null) {
  actions = next;
}

type Entry = { id: string; key: string; label: string; hint: string; disabled?: boolean; run: () => void };

function entries(): Entry[] {
  const a = actions;
  if (!a) return [];
  const note = openQuizNote();
  const kept = note?.history.length ?? 0;
  return [
    { id: "ask", key: "A", label: a.askOpen ? "Close the Ask pane" : "Ask in pane", hint: "Chat beside the note, with it attached", run: a.onAskPane },
    { id: "quiz", key: "Q", label: "Quiz me…", hint: "Scope, number of cards and question type", run: a.onQuiz },
    { id: "brief", key: "S", label: "Study sheet, formulas, explain…", hint: "From the notes you pick", run: a.onBrief },
    {
      id: "review",
      key: "R",
      label: kept ? `Review results (${kept})` : "Review results",
      hint: note ? "Marked quizzes kept on this note" : "Open a note to see its quizzes",
      disabled: !note,
      run: a.onReview,
    },
  ];
}

/** The same entries as items of a canvas context menu; the last one opens the full menu there. */
export function studyMenuItems(at: { x: number; y: number }): MenuItem[] {
  const list = entries();
  if (!list.length) return [];
  const host = defaultHost();
  return [
    ...list.map((e) => ({ label: e.label, hint: e.key, disabled: e.disabled, title: e.hint, onClick: e.run })),
    { label: `AI: ${CHAT_NAME[host]}…`, title: "Switch the AI and see whether you are signed in", onClick: () => openStudyMenu(at) },
  ];
}

type At = { x: number; y: number } | { anchor: DOMRect };
const EVENT = "pl:study-menu";

/** Show the Study menu at a point, under a button, or under the toolbar's Study button. Shown again, it closes. */
export function openStudyMenu(at?: At) {
  window.dispatchEvent(new CustomEvent<At | undefined>(EVENT, { detail: at }));
}

export function useDefaultHost(): ChatHost {
  return useSyncExternalStore(subscribeDefaultHost, defaultHost);
}

const DOT: Record<SignIn, string> = { in: "in", out: "out", unknown: "unknown", checking: "checking" };

/** One switcher for the AI every Study tool uses, with what the app knows of each sign-in. */
export function ProviderSwitch({ compact }: { compact?: boolean }) {
  const host = useDefaultHost();
  const signIn = useSignIn();
  const step = (dir: number) => {
    const i = CHAT_HOSTS.indexOf(host);
    setDefaultHost(CHAT_HOSTS[(i + dir + CHAT_HOSTS.length) % CHAT_HOSTS.length]);
  };
  return (
    <div className={`study-provider${compact ? " compact" : ""}`}>
      <div
        className="study-provider-hosts"
        role="radiogroup"
        aria-label="AI for Study tools"
        title="Scroll to switch"
        onWheel={(e) => {
          if (!e.deltaY) return;
          step(e.deltaY > 0 ? 1 : -1);
        }}
      >
        {CHAT_HOSTS.map((h) => (
          <button
            key={h}
            type="button"
            role="radio"
            aria-checked={h === host}
            className={h === host ? "on" : ""}
            title={`${CHAT_NAME[h]}: ${SIGNIN_LABEL[signIn[h]]}`}
            onClick={() => setDefaultHost(h)}
          >
            <i className={`study-dot ${DOT[signIn[h]]}`} aria-hidden />
            {CHAT_NAME[h]}
          </button>
        ))}
      </div>
      <div className="study-provider-status">
        <span>{SIGNIN_LABEL[signIn[host]]}</span>
        <button type="button" className="link" disabled={signIn[host] === "checking"} onClick={() => void checkSignIn(host)}>
          {signIn[host] === "unknown" ? "Check" : "Check again"}
        </button>
        {signIn[host] === "out" && <span className="muted">· sign in once in Ask in pane</span>}
      </div>
    </div>
  );
}

/** The popup. Mounted once by the App; opened by openStudyMenu. */
export function StudyMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const note = useOpenQuizNote();
  void note; // re-render when the open note's history changes

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<At | undefined>).detail;
      setAt((cur) => {
        if (cur) return null;
        if (d && "x" in d) return { x: d.x, y: d.y };
        const r = d && "anchor" in d ? d.anchor : document.querySelector("[data-study-button]")?.getBoundingClientRect();
        if (r && r.width) return { x: r.right - 300, y: r.bottom + 6 };
        return { x: window.innerWidth / 2 - 150, y: 64 };
      });
    };
    window.addEventListener(EVENT, onOpen);
    return () => window.removeEventListener(EVENT, onOpen);
  }, []);

  useLayoutEffect(() => {
    if (!at) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 300;
    const h = el?.offsetHeight ?? 360;
    setPos({
      x: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)),
    });
    el?.querySelector<HTMLButtonElement>("button.study-item:not(:disabled)")?.focus();
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      // The toolbar button toggles the menu itself on click.
      if (e.target instanceof Element && e.target.closest("[data-study-button]")) return;
      setAt(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [at]);

  if (!at) return null;
  const list = entries();
  const run = (e: Entry) => {
    if (e.disabled) return;
    setAt(null);
    e.run();
  };
  const onKey = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setAt(null);
      return;
    }
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button.study-item:not(:disabled)") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      next?.focus();
      return;
    }
    if (/^[1-3]$/.test(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
      setDefaultHost(CHAT_HOSTS[Number(ev.key) - 1]);
      return;
    }
    const hit = list.find((e) => e.key === ev.key.toUpperCase());
    if (hit) {
      ev.preventDefault();
      ev.stopPropagation();
      run(hit);
    }
  };
  const group = (ids: string[]) =>
    list
      .filter((e) => ids.includes(e.id))
      .map((e) => (
        <button key={e.id} type="button" className="study-item" disabled={e.disabled} title={e.hint} onClick={() => run(e)}>
          <span>
            {e.label}
            <small>{e.hint}</small>
          </span>
          <kbd>{e.key}</kbd>
        </button>
      ));
  return (
    <div
      ref={ref}
      className="menu study-menu"
      role="menu"
      aria-label="Study"
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? undefined : "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKey}
    >
      <div className="study-head">
        Study <span className="muted">Ctrl+J</span>
      </div>
      {group(["ask"])}
      <hr />
      {group(["quiz", "brief", "review"])}
      <hr />
      <ProviderSwitch />
    </div>
  );
}

/** Study → Quiz me: what to cover, how many cards, what kind, and where to answer. */
export function QuizSetupDialog({
  hasNote,
  hasArea,
  onStart,
  onClose,
}: {
  hasNote: boolean;
  /** Something is selected on the page, so "Selection" can be quizzed (rendered from the note). */
  hasArea: boolean;
  onStart: (prefs: QuizPrefs) => void;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState<QuizPrefs>(() => {
    const p = loadQuizPrefs();
    const scope: QuizScope =
      hasArea ? "area" : p.scope === "area" || (p.scope === "note" && !hasNote) ? (hasNote ? "note" : "notes") : p.scope;
    return { ...p, scope };
  });
  const set = (patch: Partial<QuizPrefs>) => setPrefs((cur) => ({ ...cur, ...patch }));
  const start = () => {
    saveQuizPrefs(prefs);
    onStart(prefs);
  };
  const scopes: { id: QuizScope; label: string; hint: string; off?: boolean }[] = [
    { id: "note", label: "This note", hint: "The whole open note, sent as PDF and Markdown", off: !hasNote },
    { id: "area", label: "Selection", hint: "What you selected on the page, drawn from the note", off: !hasArea },
    { id: "notes", label: "Choose notes…", hint: "Pick several notes, or search them on Home" },
  ];
  return (
    <Modal
      title="Quiz me"
      onClose={onClose}
      className="quiz-setup"
      actions={
        <>
          <button className="btn outline" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={start}>
            {prefs.scope === "notes" ? "Pick notes" : prefs.chat ? "Start in chat" : "Make cards"}
          </button>
        </>
      }
    >
      <div
        className="quiz-setup-body"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault();
            start();
          }
        }}
      >
        <label className="quiz-setup-label">Cover</label>
        <div className="brief-choices">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`brief-chip ${prefs.scope === s.id ? "on" : ""}`}
              disabled={s.off}
              title={s.off ? (s.id === "area" ? "Select something on the page first" : "Open a note first") : s.hint}
              onClick={() => set({ scope: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="quiz-setup-label">Cards</label>
        <div className="brief-choices">
          {QUIZ_COUNTS.map((n) => (
            <button key={n} type="button" className={`brief-chip ${prefs.count === n ? "on" : ""}`} onClick={() => set({ count: n })}>
              {n}
            </button>
          ))}
        </div>
        <label className="quiz-setup-label">Type</label>
        <div className="brief-choices">
          {QUIZ_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`brief-chip ${prefs.kind === k.id ? "on" : ""}`}
              title={k.hint}
              onClick={() => set({ kind: k.id })}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="brief-hint">{QUIZ_KINDS.find((k) => k.id === prefs.kind)?.hint}</p>
        <label className="quiz-setup-label">Answer</label>
        <div className="brief-choices">
          <button type="button" className={`brief-chip ${!prefs.chat ? "on" : ""}`} onClick={() => set({ chat: false })}>
            Cards here, marked together
          </button>
          <button type="button" className={`brief-chip ${prefs.chat ? "on" : ""}`} onClick={() => set({ chat: true })}>
            In chat, one at a time
          </button>
        </div>
        <p className="brief-hint">
          {prefs.chat
            ? "The chat asks, waits for each answer, and scores at the end. Chat quizzes are not kept in Review results."
            : "Marked quizzes are kept on the note: Study → Review results."}
        </p>
        <label className="quiz-setup-label">AI</label>
        <ProviderSwitch compact />
      </div>
    </Modal>
  );
}

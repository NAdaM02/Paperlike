import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { analyzePrompt, AnalyzeAction } from "./Analyze";
import { noteText, summaryHtml } from "./brief";
import { askInBackground, CHAT_NAME, ChatError, ChatHost, privateChats, setPrivateChats } from "./chat";
import { IcCalc, IcCheck, IcClose, IcCopy, IcDoc, IcHistory, IcIncognito, IcScan, IcSend, IcSpark, IcStop, IcWide } from "./icons";

/** Added to the first message of a conversation; the chat sites have no other place for it. */
const BRIEFLY =
  "Answer briefly by default: a few sentences or a short list. Keep formulas and symbols in their original notation; LaTeX is fine. Say when the given context does not settle the answer.";

/* Text last selected in the note; the quick field and Ctrl+K take it as context. */
let noteSelection = "";

/** Tracks the note selection. Selections in the quick field, card or chat pane are ignored. */
export function useNoteSelection() {
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const node = sel?.anchorNode;
      if (!node) return;
      const el = node instanceof Element ? node : node.parentElement;
      if (!el || el.closest(".qa-field, .qa-card, .ask-pane, .calc-card, .analyze-overlay") || !el.closest(".app-frame")) return;
      noteSelection = (sel?.toString() ?? "").trim().slice(0, 4000);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);
}

export type QuickTurn = { role: "user" | "model"; text: string };

export type QuickSeed = {
  id: number;
  question: string;
  selection: string;
  /** Analyze screenshot attached to the first question. */
  imagePath?: string;
  imagePreview?: string;
  analyze?: AnalyzeAction;
  /** Reopen a past session chat. */
  prior?: { host: ChatHost; turns: QuickTurn[]; url?: string | null };
};

export type QuickHistoryEntry = {
  id: number;
  question: string;
  selection: string;
  host: ChatHost;
  turns: QuickTurn[];
  url: string | null;
  at: number;
  imagePreview?: string;
  analyze?: AnalyzeAction;
};

const historyListeners = new Set<() => void>();
let sessionHistory: QuickHistoryEntry[] = [];

export function subscribeQuickHistory(fn: () => void): () => void {
  historyListeners.add(fn);
  return () => {
    historyListeners.delete(fn);
  };
}

function sameChat(a: QuickHistoryEntry, b: QuickHistoryEntry): boolean {
  if (a.id === b.id) return true;
  // Reopening from history used to mint a new id; collapse those duplicates.
  if (a.analyze !== b.analyze) return false;
  if (a.question !== b.question) return false;
  if ((a.imagePreview ?? "") !== (b.imagePreview ?? "")) return false;
  if (a.turns.length !== b.turns.length) return false;
  return a.turns.every((t, i) => t.role === b.turns[i]?.role && t.text === b.turns[i]?.text);
}

function pushHistory(entry: QuickHistoryEntry) {
  sessionHistory = [entry, ...sessionHistory.filter((h) => !sameChat(h, entry))].slice(0, 40);
  historyListeners.forEach((fn) => fn());
}

export function recordQuickHistory(entry: QuickHistoryEntry) {
  if (!entry.turns.some((t) => t.role === "user")) return;
  pushHistory(entry);
}

/** The small "Quick question" field in the header, with calculator / history / analyze. */
export function QuickAskField({
  onAsk,
  onCalc,
  onAnalyze,
  disabled = false,
}: {
  onAsk: (seed: QuickSeed) => void;
  onCalc?: () => void;
  onAnalyze?: () => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [histOpen, setHistOpen] = useState(false);
  const [hist, setHist] = useState(sessionHistory);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeQuickHistory(() => setHist([...sessionHistory]));
  }, []);

  useEffect(() => {
    if (!histOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setHistOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [histOpen]);

  return (
    <div className="qa-wrap" ref={wrapRef}>
      <div className="qa-tools" data-tour="quick-tools">
        {onCalc && (
          <button
            type="button"
            className="btn icon qa-tool"
            title="Calculator"
            aria-label="Calculator"
            disabled={disabled}
            onClick={onCalc}
          >
            <IcCalc size={15} />
          </button>
        )}
        {onAnalyze && (
          <button
            type="button"
            className="btn icon qa-tool"
            title="Analyze an area of the screen"
            aria-label="Analyze"
            disabled={disabled}
            onClick={onAnalyze}
          >
            <IcScan size={15} />
          </button>
        )}
      </div>
      <form data-tour="quick-ask"
        className="qa-field"
        title={disabled ? "Ask stays off after the trial. You can still view and export notes." : "Quick answer in a card (Ctrl+K). Text selected in the note goes along."}
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || !q.trim()) return;
          onAsk({ id: Date.now(), question: q.trim(), selection: noteSelection });
          setQ("");
          setHistOpen(false);
        }}
      >
        <IcSpark size={14} />
        <input
          value={q}
          disabled={disabled}
          placeholder="Quick question…"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              setHistOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
        <kbd>Ctrl K</kbd>
      </form>
      <button
        type="button"
        className={`btn icon qa-tool ${histOpen ? "on" : ""}`}
        title="Quick question history (this session)"
        aria-label="Quick question history"
        aria-expanded={histOpen}
        disabled={disabled}
        onClick={() => setHistOpen((v) => !v)}
      >
        <IcHistory size={15} />
      </button>
      {histOpen && (
        <div className="qa-hist" role="listbox" aria-label="Session history">
          {!hist.length && <div className="qa-hist-empty">No quick questions yet this session.</div>}
          {hist.map((h) => {
            const label = h.analyze
              ? h.analyze === "factcheck"
                ? "Fact-check"
                : h.analyze[0]!.toUpperCase() + h.analyze.slice(1)
              : h.question;
            return (
              <button
                key={h.id}
                type="button"
                className="qa-hist-item"
                role="option"
                onClick={() => {
                  setHistOpen(false);
                  // Keep the same history id so closing the card updates the
                  // entry instead of appending a duplicate.
                  onAsk({
                    id: h.id,
                    question: h.question,
                    selection: h.selection,
                    imagePreview: h.imagePreview,
                    analyze: h.analyze,
                    prior: { host: h.host, turns: h.turns, url: h.url },
                  });
                }}
              >
                {h.imagePreview && <img src={h.imagePreview} alt="" className="qa-hist-thumb" />}
                <span className="qa-hist-q">{label}</span>
                <span className="qa-hist-meta">{CHAT_NAME[h.host]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Focus the header field from anywhere. */
export function focusQuickField() {
  const input = document.querySelector<HTMLInputElement>(".qa-field input");
  input?.focus();
  input?.select();
}

type Turn = QuickTurn;

/**
 * Floating card with the answer and a follow-up line. The question goes to a supported chat site
 * through the web login, in a view kept out of sight; the reply is read back as it is written.
 */
export function QuickAskCard({
  seed,
  initialHost,
  notePath,
  noteTitle,
  beforeAsk,
  onHost,
  onOpenPanel,
  onClose,
}: {
  seed: QuickSeed;
  initialHost: ChatHost;
  notePath?: string;
  noteTitle?: string;
  beforeAsk?: () => Promise<void>;
  onHost: (host: ChatHost) => void;
  /** Continue in the Ask pane: the conversation's address when there is one, else the question. */
  onOpenPanel: (host: ChatHost, question: string, url: string | null) => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState<ChatHost>(seed.prior?.host ?? initialHost);
  const [turns, setTurns] = useState<Turn[]>(seed.prior?.turns ?? []);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; signin: boolean } | null>(null);
  const [follow, setFollow] = useState("");
  const [useNote, setUseNote] = useState(() => localStorage.getItem("pl.quick.note") === "on");
  const [priv, setPriv] = useState(privateChats);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(seed.prior?.url ?? null);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped by every question; only the newest one may end the wait or show its error. */
  const reqRef = useRef(0);
  const busyRef = useRef(false);
  const startedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const noteSent = useRef(false);
  /** Host of the conversation the next question continues; null starts a new one. */
  const convo = useRef<ChatHost | null>(seed.prior ? seed.prior.host : null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const hostRef = useRef(host);
  hostRef.current = host;
  const urlRef = useRef(url);
  urlRef.current = url;
  const name = CHAT_NAME[host];

  useEffect(
    () => () => {
      abortRef.current?.abort();
      void api.quickRelease();
      const cur = turnsRef.current;
      if (cur.length) {
        recordQuickHistory({
          id: seed.id,
          question: seed.question,
          selection: seed.selection,
          host: hostRef.current,
          turns: cur,
          url: urlRef.current,
          at: Date.now(),
          imagePreview: seed.imagePreview,
          analyze: seed.analyze,
        });
      }
    },
    [seed.id, seed.question, seed.selection, seed.imagePreview, seed.analyze],
  );

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live, error]);

  const ask = async (question: string, selection = "", via: ChatHost = host, files?: string[]) => {
    if (!question.trim() || busyRef.current) return;
    const req = ++reqRef.current;
    const current = () => reqRef.current === req;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    setLive("");
    const fresh = convo.current !== via;
    if (fresh) noteSent.current = false;
    const parts: string[] = [];
    if (useNote && notePath && !noteSent.current && !files?.length) {
      try {
        await beforeAsk?.().catch(() => {});
        const text = noteText(await api.loadNote(notePath));
        if (text.trim()) parts.push(`My note "${noteTitle || "Untitled"}":\n"""\n${text.slice(0, 20000)}\n"""`);
        noteSent.current = true;
      } catch {
        /* answer without the note */
      }
    }
    // Selection is only extra context text — not the note file. Don't imply a note is attached.
    if (selection) parts.push(`Context:\n"""\n${selection}\n"""`);
    parts.push(question.trim());
    if (fresh) parts.push(BRIEFLY);
    setTurns((cur) => [...(fresh ? [] : cur), { role: "user", text: question.trim() }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let soFar = "";
    try {
      const reply = await askInBackground({
        host: via,
        text: parts.join("\n\n"),
        fresh,
        signal: ctrl.signal,
        filePaths: files,
        onText: (t) => {
          if (!current()) return;
          // A blank poll, or a scrape that is only "Claude is responding…", must
          // not replace an answer that is already on screen. The status row below
          // the transcript stays up for the whole wait.
          const status =
            /^(?:(?:\S+\s+){0,4}is (?:responding|thinking|typing|writing|working)|responding|thinking|typing|writing|just now)[.…]*$/i;
          if (!t.trim() || t.split(/\n+/).every((line) => !line.trim() || status.test(line.trim()))) return;
          soFar = t;
          setLive(t);
        },
      });
      // A run that a newer question replaced ends with an empty "done"; it must not
      // clear the waiting row of the question that is still being answered.
      if (!current()) return;
      convo.current = via;
      setUrl(reply.url);
      const text = (reply.text || soFar).trim();
      if (text) setTurns((cur) => [...cur, { role: "model", text }]);
    } catch (e) {
      if (!current()) return;
      if (e instanceof ChatError && e.url) setUrl(e.url);
      setError({ text: e instanceof Error ? e.message : String(e), signin: e instanceof ChatError && e.code === "signin" });
      convo.current = null;
    } finally {
      if (current()) {
        setLive("");
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    }
  };

  useEffect(() => {
    // Strict Mode mounts twice in development; a second ask would race the first one.
    if (seed.prior || startedRef.current) return;
    startedRef.current = true;
    const q = seed.analyze ? analyzePrompt(seed.analyze) : seed.question;
    const files = seed.imagePath ? [seed.imagePath] : undefined;
    void ask(q, seed.selection, host, files);
    // once per seed; the card is keyed by it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchHost = (next: ChatHost) => {
    if (next === host || busy) return;
    setHost(next);
    onHost(next);
    setUrl(null);
    const last = [...turns].reverse().find((t) => t.role === "user")?.text ?? seed.question;
    convo.current = null;
    void ask(last, turns.length ? "" : seed.selection, next, seed.imagePath && !turns.length ? [seed.imagePath] : undefined);
  };

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    // The chat pane is a native view drawn over everything, so the card stays left of it.
    const askW = parseFloat(getComputedStyle(card).getPropertyValue("--ask-w")) || 0;
    const move = (ev: PointerEvent) => {
      const x = Math.max(4, Math.min(ev.clientX - dx, window.innerWidth - askW - r.width - 4));
      const y = Math.max(4, Math.min(ev.clientY - dy, window.innerHeight - 60));
      setPos({ x, y });
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  };

  const lastAnswer = [...turns].reverse().find((t) => t.role === "model")?.text ?? "";
  const firstQuestion = turns.find((t) => t.role === "user")?.text ?? seed.question;
  /** What the Ask pane's box gets when the chat has no address to open (a private one). */
  const carried = turns.some((t) => t.role === "model")
    ? `${turns.map((t) => `${t.role === "user" ? "I asked" : "You answered"}:\n${t.text}`).join("\n\n")}\n\n`
    : firstQuestion;

  return (
    <div
      ref={cardRef}
      className="qa-card"
      style={pos ? { left: pos.x, top: pos.y, right: "auto" } : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="qa-head" onPointerDown={startDrag}>
        <IcSpark size={14} />
        <div className="qa-hosts" role="tablist">
          {(["claude", "chatgpt", "gemini"] as const).map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={host === h}
              className={host === h ? "on" : ""}
              disabled={busy && host !== h}
              title={host === h ? undefined : `Ask ${CHAT_NAME[h]} instead`}
              onClick={() => switchHost(h)}
            >
              {CHAT_NAME[h]}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          className="btn icon"
          type="button"
          title={copied ? "Copied" : "Copy the answer"}
          disabled={!lastAnswer}
          onClick={() =>
            void navigator.clipboard.writeText(lastAnswer).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? <span className="qa-ok"><IcCheck size={14} /></span> : <IcCopy size={14} />}
        </button>
        <button
          className="btn icon"
          type="button"
          title={
            url
              ? "Continue this chat in the Ask panel"
              : turns.length > 1
                ? "Continue in the Ask panel (a new chat that starts with this conversation)"
                : "Ask in the Ask panel"
          }
          onClick={() => onOpenPanel(host, url ? firstQuestion : carried, url)}
        >
          <IcWide size={14} />
        </button>
        <button className="btn icon" type="button" title="Close (Esc)" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </header>

      <div className="qa-body" ref={bodyRef}>
        {seed.imagePreview && (
          <div className="qa-shot">
            <img src={seed.imagePreview} alt="Captured area" />
            {seed.analyze && (
              <span className="qa-shot-tag">
                {seed.analyze === "factcheck" ? "Fact-check" : seed.analyze[0]!.toUpperCase() + seed.analyze.slice(1)}
              </span>
            )}
          </div>
        )}
        {seed.selection && !seed.imagePreview && (
          <div className="qa-sel" title={seed.selection}>
            “{seed.selection.length > 120 ? `${seed.selection.slice(0, 120)}…` : seed.selection}”
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="qa-q">
              {t.text}
            </div>
          ) : (
            <div key={i} className="qa-a md-read" dangerouslySetInnerHTML={{ __html: summaryHtml(t.text) }} />
          ),
        )}
        {busy && live.trim() && (
          <div className="qa-a md-read live" dangerouslySetInnerHTML={{ __html: summaryHtml(live) }} />
        )}
        {error && (
          <div className="qa-error">
            <p>{error.text}</p>
            <button className="btn" type="button" onClick={() => onOpenPanel(host, firstQuestion, error.signin ? null : url)}>
              {error.signin ? `Sign in to ${name}` : "Open the Ask panel"}
            </button>
          </div>
        )}
      </div>

      {busy && (
        <div className="qa-thinking" role="status" aria-live="polite">
          <IcSpark size={14} />
          <span className="qa-thinking-label">{name} is responding…</span>
          <span className="qa-thinking-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </div>
      )}

      <form
        className="qa-foot"
        onSubmit={(e) => {
          e.preventDefault();
          const q = follow;
          setFollow("");
          void ask(q);
        }}
      >
        <button
          type="button"
          className={`qa-note ${useNote && notePath ? "on" : ""}`}
          disabled={!notePath || !!seed.imagePath}
          title={
            seed.imagePath
              ? "This question already includes a screen capture"
              : notePath
                ? useNote
                  ? `“${noteTitle || "Untitled"}” goes along with the next question. Click to leave it out.`
                  : "Include the open note's text with the next question"
                : "No note open"
          }
          onClick={() =>
            setUseNote((v) => {
              localStorage.setItem("pl.quick.note", v ? "off" : "on");
              if (v) noteSent.current = false;
              return !v;
            })
          }
        >
          <IcDoc size={13} /> Note
        </button>
        <button
          type="button"
          className={`qa-note ${priv ? "on" : ""}`}
          title={
            priv
              ? `New chats are private: ${host === "claude" ? "incognito" : "temporary"} in ${name}, kept out of its history. Click to keep them.`
              : `New chats are kept in ${name}'s history. Click to make them private.`
          }
          onClick={() =>
            setPriv((v) => {
              setPrivateChats(!v);
              return !v;
            })
          }
        >
          <IcIncognito size={13} /> Private
        </button>
        <input
          value={follow}
          autoFocus
          placeholder={turns.length ? "Follow up…" : `Ask ${name}…`}
          onChange={(e) => setFollow(e.target.value)}
        />
        {busy ? (
          <button className="btn icon" type="button" title="Stop" onClick={() => abortRef.current?.abort()}>
            <IcStop size={13} />
          </button>
        ) : (
          <button className="btn icon" type="submit" title="Send (Enter)" disabled={!follow.trim()}>
            <IcSend size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

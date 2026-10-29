import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { AnalyzeAction, AnalyzeIcon, analyzeLabel, analyzePrompt, AnalyzeRect, areaOnScreen, captureArea, promptAction, visiblePart } from "./Analyze";
import { NoteArea, screenOf, subscribeCanvas } from "./canvasAnchor";
import { noteText, summaryHtml } from "./brief";
import { askInBackground, CHAT_HOSTS, CHAT_NAME, ChatError, ChatHost, defaultHost, privateChats, setDefaultHost, setPrivateChats, subscribeDefaultHost } from "./chat";
import { HostLogo, IcCalc, IcCheck, IcChevron, IcClose, IcCopy, IcDoc, IcHistory, IcIncognito, IcReload, IcScan, IcSend, IcSpark, IcStop, IcWide } from "./icons";

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

export type QuickTurn = { role: "user" | "model"; text: string; /** The model's visible reasoning, when the site showed it. */ thinking?: string };

export type QuickSeed = {
  id: number;
  question: string;
  selection: string;
  /** Analyze screenshot attached to the first question. */
  imagePath?: string;
  imagePreview?: string;
  analyze?: AnalyzeAction;
  /** Screen area the capture came from: the card opens beside it, and Rescan captures it again. */
  anchor?: AnalyzeRect;
  /** The same area in note coordinates, when it was over a canvas: Rescan follows it there. */
  area?: NoteArea | null;
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
  const [host, setHost] = useState<ChatHost>(defaultHost);
  const [modelsOpen, setModelsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeQuickHistory(() => setHist([...sessionHistory]));
  }, []);

  // The card and the Ask pane change the model too; show what the next question uses.
  useEffect(() => subscribeDefaultHost(() => setHost(defaultHost())), []);

  useEffect(() => {
    if (!histOpen && !modelsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setHistOpen(false);
      setModelsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [histOpen, modelsOpen]);

  // Keyboard users land on the current model when the menu opens.
  useEffect(() => {
    if (!modelsOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [modelsOpen]);

  // Scrolling over the model button steps through the models (no request is sent from here).
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    const btn = modelBtnRef.current;
    if (!btn) return;
    const order = ["claude", "chatgpt", "gemini"] as const;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (disabledRef.current) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      acc += e.deltaMode === 1 ? d * 33 : d;
      if (Math.abs(acc) < 40) return;
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      const now = Math.max(0, order.indexOf(defaultHost()));
      const next = order[(now + dir + order.length) % order.length];
      setDefaultHost(next);
      setHost(next);
    };
    btn.addEventListener("wheel", onWheel, { passive: false });
    return () => btn.removeEventListener("wheel", onWheel);
  }, []);

  const menuLeft = () => {
    const btn = modelBtnRef.current?.getBoundingClientRect();
    const wrap = wrapRef.current?.getBoundingClientRect();
    return btn && wrap ? Math.max(0, btn.left - wrap.left - 6) : 0;
  };

  const pickModel = (h: ChatHost) => {
    setDefaultHost(h);
    setHost(h);
    setModelsOpen(false);
    inputRef.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      setModelsOpen(false);
      modelBtnRef.current?.focus();
    }
  };

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
        className={`qa-field ${modelsOpen ? "open" : ""}`}
        title={disabled ? "Ask stays off after the trial. You can still view and export notes." : "Quick answer in a card (Ctrl+K). Text selected in the note goes along."}
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || !q.trim()) return;
          onAsk({ id: Date.now(), question: q.trim(), selection: noteSelection });
          setQ("");
          setHistOpen(false);
        }}
      >
        <button
          ref={modelBtnRef}
          type="button"
          className={`qa-model ${modelsOpen ? "on" : ""}`}
          title={`Asking ${CHAT_NAME[host]}. Click or scroll to change the model.`}
          aria-label={`Model: ${CHAT_NAME[host]}`}
          aria-haspopup="listbox"
          aria-expanded={modelsOpen}
          disabled={disabled}
          onClick={() => {
            setHistOpen(false);
            setModelsOpen((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !modelsOpen) {
              e.preventDefault();
              setHistOpen(false);
              setModelsOpen(true);
            }
          }}
        >
          <HostLogo host={host} size={15} />
          <IcChevron size={10} />
        </button>
        <input
          ref={inputRef}
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
      {modelsOpen && (
        <div
          className="qa-models"
          role="listbox"
          aria-label="Model"
          ref={menuRef}
          onKeyDown={onMenuKey}
          // Lined up under the picker, which sits after the tool buttons.
          style={{ left: menuLeft() }}
        >
          {CHAT_HOSTS.map((h) => (
            <button
              key={h}
              type="button"
              role="option"
              aria-selected={h === host}
              className={`qa-models-item ${h === host ? "on" : ""}`}
              onClick={() => pickModel(h)}
            >
              <HostLogo host={h} size={16} />
              <span>{CHAT_NAME[h]}</span>
              {h === host && <IcCheck size={13} />}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`btn icon qa-tool ${histOpen ? "on" : ""}`}
        title="Quick question history (this session)"
        aria-label="Quick question history"
        aria-expanded={histOpen}
        disabled={disabled}
        onClick={() => {
          setModelsOpen(false);
          setHistOpen((v) => !v);
        }}
      >
        <IcHistory size={15} />
      </button>
      {histOpen && (
        <div className="qa-hist" role="listbox" aria-label="Session history">
          {!hist.length && <div className="qa-hist-empty">No quick questions yet this session.</div>}
          {hist.map((h) => {
            const label = h.analyze ? analyzeLabel(h.analyze) : h.question;
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

type CardSize = { w: number; h: number };
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const MIN_W = 300;
const MIN_H = 180;

const GAP = 14;
const EDGE = 8;

/**
 * Where a card of width `w` goes beside the area: right of it, else left of it. When neither side
 * fits the card, it narrows to the roomier side (down to MIN_W) instead of covering the area.
 */
function besideArea(a: AnalyzeRect, w: number, askW: number): { side: "right" | "left"; x: number; w: number } {
  const right = window.innerWidth - askW - EDGE;
  const roomR = right - (a.x + a.w + GAP);
  const roomL = a.x - GAP - EDGE;
  if (w <= roomR) return { side: "right", x: a.x + a.w + GAP, w };
  if (w <= roomL) return { side: "left", x: a.x - GAP - w, w };
  const side = roomR >= roomL ? "right" : "left";
  const room = Math.floor(Math.max(roomR, roomL));
  if (room >= MIN_W) return { side, x: side === "right" ? a.x + a.w + GAP : a.x - GAP - room, w: room };
  return { side, x: side === "right" ? Math.max(EDGE, right - w) : EDGE, w };
}

/** The size the card was last resized to; every new card opens at it. */
function savedCardSize(): CardSize | null {
  try {
    const v = JSON.parse(localStorage.getItem("pl.quick.size") ?? "null") as CardSize | null;
    return v && v.w >= MIN_W && v.h >= MIN_H ? v : null;
  } catch {
    return null;
  }
}

const TEXT_K_KEY = "paperlike.quickTextSize";
const TEXT_K_MIN = 0.75;
const TEXT_K_MAX = 2;
function readTextK(): number {
  try {
    const v = Number(localStorage.getItem(TEXT_K_KEY));
    if (v >= TEXT_K_MIN && v <= TEXT_K_MAX) return v;
  } catch {
    /* ignore */
  }
  return 1;
}

/** The model's reasoning, folded above its answer like the chat sites do; click to read it. */
function ThoughtProcess({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`qa-thought ${open ? "open" : ""}`}>
      <button type="button" className="qa-thought-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Thought process
        <IcChevron size={10} />
      </button>
      {open && <p className="qa-thought-text">{text}</p>}
    </div>
  );
}

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
  /** The model's reasoning for the question being answered, as the site shows it. */
  const [thinking, setThinking] = useState("");
  /** Sent Analyze prompts the user expanded (by turn index); collapsed they read as the action name. */
  const [openPrompts, setOpenPrompts] = useState<ReadonlySet<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; signin: boolean } | null>(null);
  const [follow, setFollow] = useState("");
  const [useNote, setUseNote] = useState(() => localStorage.getItem("pl.quick.note") === "on");
  const [priv, setPriv] = useState(privateChats);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<CardSize | null>(savedCardSize);
  /** A narrower width for this card only, when the saved size doesn't fit beside the area. */
  const [fitW, setFitW] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(seed.prior?.url ?? null);
  /** The latest capture of the area; Rescan replaces it. */
  const [shot, setShot] = useState(seed.imagePreview);
  const [rescanning, setRescanning] = useState(false);
  const [rescanErr, setRescanErr] = useState("");
  const shotRef = useRef(shot);
  shotRef.current = shot;
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped by every question; only the newest one may end the wait or show its error. */
  const reqRef = useRef(0);
  const busyRef = useRef(false);
  const startedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Text size in the card, its own setting: zooming the note leaves it alone. */
  const [textK, setTextK] = useState(readTextK);
  const [zoomTip, setZoomTip] = useState(false);
  const zoomTipTimer = useRef(0);
  // Ctrl + wheel, or wheel with the middle button held, sizes the card's text (not the app or the note).
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && (e.buttons & 4) === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const step = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.0012));
      setTextK((k) => {
        const next = Math.round(Math.min(TEXT_K_MAX, Math.max(TEXT_K_MIN, k * step)) * 100) / 100;
        try {
          localStorage.setItem(TEXT_K_KEY, String(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      setZoomTip(true);
      window.clearTimeout(zoomTipTimer.current);
      zoomTipTimer.current = window.setTimeout(() => setZoomTip(false), 900);
    };
    // Holding the middle button over the text is for sizing, not the browser's autoscroll.
    const onDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    card.addEventListener("wheel", onWheel, { passive: false });
    card.addEventListener("mousedown", onDown);
    return () => {
      card.removeEventListener("wheel", onWheel);
      card.removeEventListener("mousedown", onDown);
      window.clearTimeout(zoomTipTimer.current);
    };
  }, []);
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
          imagePreview: shotRef.current,
          analyze: seed.analyze,
        });
      }
    },
    [seed.id, seed.question, seed.selection, seed.analyze],
  );

  /**
   * The card's place and size in note units, measured from the area: it sits on the note like
   * something drawn there, so panning, zooming and window resizes keep it where it was put.
   * `h` is null while the card grows with its answer.
   */
  /** The image this card asks about: the first capture, then the latest rescan. */
  const imageRef = useRef<string | undefined>(seed.imagePath);
  const relRef = useRef<{ side: "right" | "left"; gap: number; oy: number; w: number; h: number | null } | null>(null);
  /** Note zoom when the card was first placed: its text is 100% there and scales with the note from it. */
  const zBaseRef = useRef<number | null>(null);

  /** Remember where the card is (screen px) relative to the area, as shown at `r` and zoom `z`. */
  const pin = (c: { x: number; y: number; w: number; h: number }, r: AnalyzeRect, z: number, fixedH: boolean) => {
    if (!(z > 0)) return;
    if (zBaseRef.current == null) zBaseRef.current = z;
    const side = c.x + c.w / 2 >= r.x + r.w / 2 ? "right" : "left";
    relRef.current = {
      side,
      gap: (side === "right" ? c.x - (r.x + r.w) : r.x - (c.x + c.w)) / z,
      oy: (c.y - r.y) / z,
      w: c.w / z,
      h: fixedH ? c.h / z : null,
    };
  };

  /** Re-pin after the card was dragged or resized, from where the area is now. */
  const repin = (c: { x: number; y: number; w: number; h: number }, fixedH: boolean) => {
    const area = seed.area;
    const at = area && screenOf(area);
    if (!area || !at || !area.w) return;
    pin(c, at.rect, at.rect.w / area.w, fixedH);
  };

  // The card travels and scales with the outlined area when the note pans or zooms.
  useEffect(() => {
    const area = seed.area;
    if (!area || !area.w) return;
    return subscribeCanvas(() => {
      const card = cardRef.current;
      const rel = relRef.current;
      const at = screenOf(area);
      if (!card || !rel || !at || card.classList.contains("resizing")) return;
      const r = at.rect;
      const z = r.w / area.w;
      const w = Math.max(MIN_W, rel.w * z);
      const x = rel.side === "right" ? r.x + r.w + rel.gap * z : r.x - rel.gap * z - w;
      card.style.left = `${x}px`;
      card.style.top = `${r.y + rel.oy * z}px`;
      card.style.right = "auto";
      card.style.width = `${w}px`;
      if (rel.h != null) card.style.height = `${Math.max(MIN_H, rel.h * z)}px`;
      // The text grows and shrinks with the note too, so the answer wraps the same at any zoom.
      const base = zBaseRef.current;
      if (base) card.style.setProperty("--qa-z", String(Math.min(4, Math.max(0.3, z / base))));
    });
  }, [seed.area]);

  // An Analyze card opens just right of the captured area (left of it when there's no room),
  // so the answer sits next to what it is about.
  useLayoutEffect(() => {
    const a = seed.anchor;
    const card = cardRef.current;
    if (!a || !card) return;
    const r = card.getBoundingClientRect();
    const askW = parseFloat(getComputedStyle(card).getPropertyValue("--ask-w")) || 0;
    const spot = besideArea(a, r.width, askW);
    if (spot.w < Math.floor(r.width)) setFitW(spot.w);
    const x = spot.x;
    const y = Math.max(EDGE, Math.min(a.y, window.innerHeight - Math.min(r.height, 320) - EDGE));
    setPos({ x, y });
    if (seed.area?.w) pin({ x, y, w: spot.w, h: r.height }, a, a.w / seed.area.w, !!size);
    // once, when the card opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Follow the newest text only while the reader is at the bottom; scrolling up to reread stops it. */
  const stickRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, live, thinking, error]);

  const ask = async (question: string, selection = "", via: ChatHost = host, files?: string[]) => {
    if (!question.trim() || busyRef.current) return;
    const req = ++reqRef.current;
    const current = () => reqRef.current === req;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    setLive("");
    setThinking("");
    stickRef.current = true;
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
        onThinking: (t) => {
          if (current()) setThinking(t);
        },
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
      if (text) setTurns((cur) => [...cur, { role: "model", text, ...(reply.thinking ? { thinking: reply.thinking } : null) }]);
    } catch (e) {
      if (!current()) return;
      if (e instanceof ChatError && e.url) setUrl(e.url);
      setError({ text: e instanceof Error ? e.message : String(e), signin: e instanceof ChatError && e.code === "signin" });
      convo.current = null;
    } finally {
      if (current()) {
        setLive("");
        setThinking("");
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

  /** Capture the same area again (after an edit) and ask about the new image in this chat. */
  const rescan = async () => {
    if (!seed.anchor || !seed.analyze || busyRef.current || rescanning) return;
    setRescanErr("");
    const at = areaOnScreen(seed.anchor, seed.area);
    const a = at && visiblePart(at.rect, at.clip);
    if (!a) {
      setRescanErr("The marked area isn't on screen. Scroll back to it, then rescan.");
      return;
    }
    setRescanning(true);
    try {
      // The outline sits just outside the area, so only a card dragged over it needs hiding.
      const c = cardRef.current?.getBoundingClientRect();
      const over = !!c && c.left < a.x + a.w && c.right > a.x && c.top < a.y + a.h && c.bottom > a.y;
      const next = await captureArea(a, over ? [cardRef.current] : []);
      setShot(next.previewUrl);
      imageRef.current = next.filePath;
      const q = `I changed the area; this is a new capture of it. ${analyzePrompt(seed.analyze)}`;
      void ask(q, "", host, [next.filePath]);
    } catch (e) {
      setRescanErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  };

  const switchHost = (next: ChatHost) => {
    if (next === host || busyRef.current) return;
    setHost(next);
    onHost(next);
    setUrl(null);
    convo.current = null;
    // The other model starts a fresh chat, so it gets what this card is about: the latest capture
    // of the area with its prompt, or the last question with its context.
    const image = imageRef.current;
    const last = [...turns].reverse().find((t) => t.role === "user")?.text ?? seed.question;
    const q = seed.analyze && image ? analyzePrompt(seed.analyze) : last;
    void ask(q, seed.selection, next, image ? [image] : undefined);
  };

  /** Scrolling over the model tabs walks through them; the request goes out once the wheel settles. */
  const hostsRef = useRef<HTMLDivElement>(null);
  const [wheelHost, setWheelHost] = useState<ChatHost | null>(null);
  const wheelRef = useRef({ acc: 0, timer: 0, at: null as ChatHost | null });
  const switchRef = useRef(switchHost);
  switchRef.current = switchHost;
  const hostRef2 = useRef(host);
  hostRef2.current = host;
  useEffect(() => {
    const el = hostsRef.current;
    if (!el) return;
    const order = ["claude", "chatgpt", "gemini"] as const;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || (e.buttons & 4) !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (busyRef.current) return;
      const w = wheelRef.current;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      w.acc += e.deltaMode === 1 ? d * 33 : d;
      if (Math.abs(w.acc) < 40) return;
      const dir = w.acc > 0 ? 1 : -1;
      w.acc = 0;
      const from = order.indexOf(w.at ?? hostRef2.current);
      const to = order[(Math.max(0, from) + dir + order.length) % order.length];
      w.at = to;
      setWheelHost(to);
      window.clearTimeout(w.timer);
      w.timer = window.setTimeout(() => {
        const pick = w.at;
        w.at = null;
        w.acc = 0;
        setWheelHost(null);
        if (pick) switchRef.current(pick);
      }, 450);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(wheelRef.current.timer);
    };
  }, []);

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
      repin({ x, y, w: r.width, h: r.height }, relRef.current?.h != null);
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

  /** Drag any edge or corner. The card stays inside the window and left of the Ask pane. */
  const startResize = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    const r = card.getBoundingClientRect();
    const askW = parseFloat(getComputedStyle(card).getPropertyValue("--ask-w")) || 0;
    const maxR = window.innerWidth - askW - 4;
    const maxB = window.innerHeight - 4;
    const sx = e.clientX;
    const sy = e.clientY;
    let next = { x: r.left, y: r.top, w: r.width, h: r.height };
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    card.classList.add("resizing");
    // Written straight to the element while dragging: re-rendering the answer at 240 Hz stutters.
    const apply = () => {
      card.style.left = `${next.x}px`;
      card.style.top = `${next.y}px`;
      card.style.right = "auto";
      card.style.width = `${next.w}px`;
      card.style.height = `${next.h}px`;
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { left, top, right, bottom } = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      if (edge.includes("e")) right = Math.min(maxR, Math.max(left + MIN_W, r.right + dx));
      if (edge.includes("w")) left = Math.max(4, Math.min(right - MIN_W, r.left + dx));
      if (edge.includes("s")) bottom = Math.min(maxB, Math.max(top + MIN_H, r.bottom + dy));
      if (edge.startsWith("n")) top = Math.max(4, Math.min(bottom - MIN_H, r.top + dy));
      next = { x: left, y: top, w: right - left, h: bottom - top };
      apply();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      card.classList.remove("resizing");
      const sz = { w: Math.round(next.w), h: Math.round(next.h) };
      setPos({ x: next.x, y: next.y });
      setSize(sz);
      setFitW(null);
      // Keep following the area from where, and at the size, the card now is.
      repin(next, true);
      localStorage.setItem("pl.quick.size", JSON.stringify(sz));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  /** Double-click an edge: back to the default size. */
  const resetSize = () => {
    const card = cardRef.current;
    if (card) {
      card.style.width = "";
      card.style.height = "";
      const c = card.getBoundingClientRect();
      repin({ x: c.left, y: c.top, w: c.width, h: c.height }, false);
    }
    setSize(null);
    setFitW(null);
    localStorage.removeItem("pl.quick.size");
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
      style={{
        ...(pos ? { left: pos.x, top: pos.y, right: "auto" } : null),
        ...(size ? { width: size.w, height: size.h } : null),
        ...(fitW ? { width: fitW } : null),
        ["--qa-k" as string]: textK,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`qa-rz qa-rz-${edge}`}
          aria-hidden
          title={edge.length === 2 ? "Drag to resize. Double-click for the default size." : undefined}
          onPointerDown={startResize(edge)}
          onDoubleClick={resetSize}
        />
      ))}
      <header className="qa-head" onPointerDown={startDrag}>
        <IcSpark size={14} />
        <div className="qa-hosts" role="tablist" ref={hostsRef} title="Scroll to switch models">
          {(["claude", "chatgpt", "gemini"] as const).map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={host === h}
              className={(wheelHost ?? host) === h ? "on" : ""}
              disabled={busy && host !== h}
              title={host === h ? undefined : `Ask ${CHAT_NAME[h]} instead`}
              onClick={() => switchHost(h)}
            >
              <HostLogo host={h} size={12} />
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

      <div
        className="qa-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {zoomTip && (
          <span className="qa-zoom-tip" aria-live="polite">
            {Math.round(textK * 100)}%
          </span>
        )}
        {shot && (
          <div className="qa-shot">
            <img src={shot} alt="Captured area" />
            {seed.analyze && (
              <span className="qa-shot-tag">
                <AnalyzeIcon action={seed.analyze} size={12} />
                {analyzeLabel(seed.analyze)}
              </span>
            )}
            {seed.analyze && seed.anchor && (
              <button
                type="button"
                className="btn qa-shot-rescan"
                disabled={busy || rescanning}
                title={busy ? "Wait for the answer to finish" : "Capture the marked area again and ask about the new version"}
                onClick={() => void rescan()}
              >
                <IcReload size={13} />
                {rescanning ? "Capturing…" : "Rescan"}
              </button>
            )}
          </div>
        )}
        {rescanErr && <div className="qa-error"><p>{rescanErr}</p></div>}
        {seed.selection && !seed.imagePreview && (
          <div className="qa-sel" title={seed.selection}>
            “{seed.selection.length > 120 ? `${seed.selection.slice(0, 120)}…` : seed.selection}”
          </div>
        )}
        {turns.map((t, i) => {
          if (t.role === "user") {
            const act = promptAction(t.text);
            if (!act) {
              return (
                <div key={i} className="qa-q">
                  {t.text}
                </div>
              );
            }
            const open = openPrompts.has(i);
            return (
              <button
                key={i}
                type="button"
                className={`qa-q qa-q-act ${open ? "open" : ""}`}
                aria-expanded={open}
                title={open ? "Hide the prompt" : "Show the full prompt"}
                onClick={() =>
                  setOpenPrompts((cur) => {
                    const next = new Set(cur);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
              >
                <span className="qa-q-act-head">
                  <AnalyzeIcon action={act.action} size={12} />
                  <b>{act.rescan ? `${analyzeLabel(act.action)} again` : analyzeLabel(act.action)}</b>
                  <IcChevron size={10} />
                </span>
                {open && <span className="qa-q-act-text">{t.text}</span>}
              </button>
            );
          }
          return (
            <div key={i} className="qa-turn-a">
              {t.thinking && <ThoughtProcess text={t.thinking} />}
              <div className="qa-a md-read" dangerouslySetInnerHTML={{ __html: summaryHtml(t.text) }} />
            </div>
          );
        })}
        {busy && (
          <div className="qa-turn-a" role="status" aria-live="polite">
            {live.trim() ? (
              <>
                {thinking && <ThoughtProcess text={thinking} />}
                <div className="qa-a md-read live" dangerouslySetInnerHTML={{ __html: summaryHtml(live) }} />
                <span className="qa-typing" aria-label={`${name} is writing`}>
                  <span />
                  <span />
                  <span />
                </span>
              </>
            ) : (
              <div className="qa-pending">
                <span className="qa-pending-head">
                  <IcSpark size={14} />
                  <span className="qa-shimmer">{thinking ? `${name} is thinking` : `${name} is responding`}</span>
                </span>
                {thinking && (
                  <div className="qa-pending-thoughts">
                    <p>{thinking}</p>
                  </div>
                )}
              </div>
            )}
          </div>
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

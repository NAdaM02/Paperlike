import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AssistantEvent } from "./api";
import { ATTACHED_LINE, QUICK_ASKS } from "./brief";
import { savableNotePath } from "./chat";
import { IcAttach, IcBack, IcChevron, IcClose, IcNewChat, IcReload, IcSend, IcWide } from "./icons";

export type AskHost = "claude" | "gemini" | "chatgpt";
export type AskNote = { path: string; title: string };

export const HOST_NAME: Record<AskHost, string> = { claude: "Claude", gemini: "Gemini", chatgpt: "ChatGPT" };

export const ASK_MIN_W = 340;
export const ASK_DEFAULT_W = 460;
/** The note keeps at least this much room beside the pane. */
const NOTE_MIN_W = 480;

export function clampAskWidth(w: number): number {
  return Math.round(Math.max(ASK_MIN_W, Math.min(w, window.innerWidth - NOTE_MIN_W)));
}

type Tone = "info" | "ok" | "warn";

type AttachReply = { files: string[]; found_box: boolean; attached: boolean; notice?: string | null };

function noteLabel(title: string): string {
  const t = title.trim();
  if (!t || /[\\/]/.test(t)) return "Untitled note";
  return t;
}

function attachErrorText(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, "");
  if (text.includes("isn't saved yet")) return "This note isn't saved yet, so it can't be attached.";
  if (/[A-Za-z]:\\|\\\\|panicked at|stack backtrace|\.rs:\d+/.test(text)) return "Couldn't prepare this note for the chat.";
  return text;
}

/**
 * The chat sits in a browser pane beside the note; the login stays in its own profile.
 * Sending exports the notes to files the chat can read, pastes them into the chat's
 * message box with the question, and leaves them on the clipboard as a fallback.
 */
export function AskPane({
  host,
  notes,
  fromBrief,
  initialQuestion,
  sendOnOpen,
  startUrl,
  width,
  beforeSend,
  onWidth,
  onHost,
  onClose,
}: {
  host: AskHost;
  /** What gets attached: the open note, or the notes picked in Brief. */
  notes: AskNote[];
  fromBrief: boolean;
  initialQuestion: string;
  sendOnOpen: boolean;
  /** Conversation to show first, on the same host. */
  startUrl?: string;
  width: number;
  /** Saves the open note, so the files match what is on screen. */
  beforeSend?: () => Promise<void>;
  onWidth: (w: number, done: boolean) => void;
  onHost: (host: AskHost) => void;
  onClose: () => void;
}) {
  const name = HOST_NAME[host];
  const slotRef = useRef<HTMLDivElement>(null);
  const [question, setQuestion] = useState(initialQuestion);
  const [foldPrompt, setFoldPrompt] = useState(initialQuestion.length > 400);
  const [attachOn, setAttachOn] = useState(true);
  const [selection, setSelection] = useState("");
  const [composer, setComposer] = useState(() => localStorage.getItem("pl.ask.composer") !== "closed");
  const [loading, setLoading] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [status, setStatus] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const initialHost = useRef(host);

  const place = async (create: boolean) => {
    const slot = slotRef.current;
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    if (create && !shown.current) {
      shown.current = true;
      const fresh = await api.assistantShow(host, r.x, r.y, r.width, r.height);
      if (fresh) setLoading(true);
      if (startUrl && host === initialHost.current) await api.assistantOpen(host, startUrl);
    } else {
      await api.assistantBounds(host, r.x, r.y, r.width, r.height);
    }
  };

  useEffect(() => {
    shown.current = false;
    setStatus(null);
    setSignIn(false);
    setLoading(false);
    const id = window.setTimeout(() => {
      place(true).catch((e) => setStatus({ tone: "warn", text: String(e) }));
    }, 40);
    const onResize = () => {
      place(false).catch(() => {});
    };
    window.addEventListener("resize", onResize);
    const obs = new ResizeObserver(onResize);
    if (slotRef.current) obs.observe(slotRef.current);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", onResize);
      obs.disconnect();
    };
    // host changes should rebuild the pane's browser
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useEffect(() => {
    return () => {
      api.assistantHide().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const off = listen<AssistantEvent>("assistant", ({ payload }) => {
      if (payload.host !== hostRef.current) return;
      if (payload.kind === "loading") setLoading(true);
      if (payload.kind === "loaded") {
        setLoading(false);
        setSignIn(/login|signin|sign-in|accounts\.google\./i.test(payload.detail));
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, []);

  /* Text selected in the note becomes the context of the next question. */
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!text || !sel?.anchorNode) return;
      const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
      if (!el?.closest(".app-frame") || el.closest(".ask-pane")) return;
      setSelection(text.slice(0, 4000));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const attachable = attachOn ? notes : [];

  const compose = (base: string) => {
    const parts: string[] = [];
    if (selection) parts.push(`About this part of my notes:\n"""\n${selection}\n"""`);
    parts.push(
      base.trim() ||
        "Help me study the attached notes briefly. Keep every formula and symbol in the notes' notation, and say when the notes do not settle something.",
    );
    if (attachable.length && !base.includes(ATTACHED_LINE)) parts.push(ATTACHED_LINE);
    return parts.join("\n\n");
  };

  const send = async (base: string) => {
    if (busy) return;
    setBusy(true);
    setStatus({
      tone: "info",
      text: attachable.length
        ? `Preparing ${attachable.length === 1 ? `“${noteLabel(attachable[0].title)}”` : `${attachable.length} notes`} for ${name}…`
        : `Sending your question to ${name}…`,
    });
    try {
      await beforeSend?.().catch(() => {});
      const paths = attachable.map((n) => n.path.trim()).filter(savableNotePath);
      if (attachable.length > 0 && paths.length === 0) {
        setStatus({ tone: "warn", text: "This note isn't saved yet, so it can't be attached." });
        return;
      }
      const res = (await api.assistantAttach(host, paths, compose(base))) as AttachReply;
      const paste = `The files are on the clipboard: click ${name}'s message box and press Ctrl+V.`;
      const noteBit = res.notice ? ` ${res.notice}` : "";
      if (!res.found_box) {
        setStatus({ tone: "warn", text: `${name}'s message box didn't appear. Sign in if asked, then send again. ${paste}${noteBit}` });
        return;
      }
      setSelection("");
      if (base === question && !fromBrief) setQuestion("");
      const n = res.files.length;
      const tone: Tone = res.notice ? "warn" : "ok";
      if (!n) setStatus({ tone, text: `Your question is in ${name}'s message box. Press Enter there to send it.${noteBit}` });
      else if (res.attached)
        setStatus({ tone, text: `Attached ${n} file${n === 1 ? "" : "s"} and your question. Check them, then press Enter in ${name}.${noteBit}` });
      else setStatus({ tone: "warn", text: `Your question is in the message box, but ${name} didn't take the files. ${paste}${noteBit}` });
    } catch (e) {
      setStatus({ tone: "warn", text: attachErrorText(e) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!sendOnOpen) return;
    const id = window.setTimeout(() => {
      void send(initialQuestion);
    }, 600);
    return () => window.clearTimeout(id);
    // once, when this pane is opened from Brief
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleComposer = () => {
    setComposer((open) => {
      localStorage.setItem("pl.ask.composer", open ? "closed" : "open");
      return !open;
    });
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onWidth(clampAskWidth(window.innerWidth - ev.clientX), false);
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onWidth(clampAskWidth(window.innerWidth - ev.clientX), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const half = clampAskWidth(window.innerWidth / 2);
  const wide = width >= half - 8;
  const toggleWide = () => onWidth(wide ? clampAskWidth(ASK_DEFAULT_W) : half, true);

  const words = question.trim() ? question.trim().split(/\s+/).length : 0;

  return (
    <aside className="ask-pane" style={{ width }}>
      <div
        className="ask-resize"
        title="Drag to resize · double-click for half the window"
        onPointerDown={startResize}
        onDoubleClick={toggleWide}
      />
      <header className="ask-head">
        <div className="ask-hosts" role="tablist">
          {(["claude", "chatgpt", "gemini"] as const).map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={host === h}
              className={host === h ? "on" : ""}
              onClick={() => onHost(h)}
            >
              {HOST_NAME[h]}
            </button>
          ))}
        </div>
        <div className="ask-tools">
          <button className="btn icon" type="button" title="Back" onClick={() => void api.assistantNav(host, "back")}>
            <IcBack size={15} />
          </button>
          <button className="btn icon" type="button" title="Reload" onClick={() => void api.assistantNav(host, "reload")}>
            <IcReload size={15} />
          </button>
          <button className="btn icon" type="button" title={`New ${name} chat`} onClick={() => void api.assistantNav(host, "new")}>
            <IcNewChat size={15} />
          </button>
          <span className="ask-sep" />
          <button
            className={`btn icon ${composer ? "" : "flip"}`}
            type="button"
            title={composer ? "Hide the question box for more chat room" : "Show the question box"}
            onClick={toggleComposer}
          >
            <IcChevron size={15} />
          </button>
          <button className={`btn icon ${wide ? "active" : ""}`} type="button" title={wide ? "Narrow pane" : "Half the window"} onClick={toggleWide}>
            <IcWide size={15} />
          </button>
          <button className="btn icon" type="button" title="Close (Ctrl+J)" onClick={onClose}>
            <IcClose size={15} />
          </button>
        </div>
      </header>

      {composer && (
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(question);
          }}
        >
          {!fromBrief && (
            <div className="ask-quick">
              {QUICK_ASKS.map((q) => (
                <button key={q.id} type="button" className="brief-chip" title={q.text} disabled={busy} onClick={() => void send(q.text)}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          {selection && (
            <div className="ask-pill" title={selection}>
              <span>
                <b>Selection</b> “{selection.length > 90 ? `${selection.slice(0, 90)}…` : selection}”
              </span>
              <button type="button" className="btn icon" title="Don't include the selection" onClick={() => setSelection("")}>
                <IcClose size={12} />
              </button>
            </div>
          )}
          {foldPrompt ? (
            <button type="button" className="ask-folded" onClick={() => setFoldPrompt(false)}>
              <b>Brief prompt</b>
              <span>{words.toLocaleString()} words · click to read or edit</span>
            </button>
          ) : (
            <textarea
              value={question}
              placeholder={notes.length ? `Ask ${name} about this note…` : `Ask ${name}…`}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(question);
                }
              }}
            />
          )}
          <div className="ask-send">
            {notes.length ? (
              <button
                type="button"
                className={`ask-attach ${attachOn ? "on" : ""}`}
                title={
                  attachOn
                    ? `Attached as PDF and Markdown, plus PDFs on the page:\n${notes.map((n) => noteLabel(n.title)).join("\n")}\nClick to send the question alone.`
                    : "Click to attach the note again"
                }
                onClick={() => setAttachOn((v) => !v)}
              >
                <IcAttach size={14} />
                <span>
                  {attachOn
                    ? notes.length === 1
                      ? noteLabel(notes[0].title)
                      : `${notes.length} notes`
                    : "Not attached"}
                </span>
              </button>
            ) : (
              <span className="ask-attach muted">No note open</span>
            )}
            <button
              className="btn primary"
              type="submit"
              disabled={busy}
              title="Places your question (and attached notes) in the chat box. Press Enter there to send. Shift+Enter for a new line here."
            >
              <IcSend size={14} /> {busy ? "Preparing…" : `Prepare in ${name}`}
            </button>
          </div>
        </form>
      )}
      {(status || signIn) && (
        <p className={`ask-status ${status?.tone ?? "info"}`}>
          {status?.text ?? `Sign in to ${name} once. The login stays on this computer.`}
        </p>
      )}
      <div className={`ask-progress ${loading ? "on" : ""}`} />
      <div className="ask-slot" ref={slotRef} />
    </aside>
  );
}

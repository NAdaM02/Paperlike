import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { messages } from "./copy/messages";
import { IcClose } from "./icons";

/** One row: a task with a checkbox, or a plain note line. */
type Item = { id: string; text: string; done: boolean; note?: boolean };

const newItemId = () => Math.random().toString(36).slice(2, 10);

function parseList(raw: string): Item[] {
  try {
    const v = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(v.items)) return [];
    return v.items
      .filter((i): i is Item => !!i && typeof (i as Item).id === "string" && typeof (i as Item).text === "string")
      .map((i) => ({ id: i.id, text: i.text, done: !!i.done, ...(i.note ? { note: true } : {}) }));
  } catch {
    return [];
  }
}

function moveItem(list: Item[], from: number, to: number): Item[] {
  if (from === to || from < 0 || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

const Tick = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
    <circle className="cl-ring" cx="10" cy="10" r="8.6" />
    <path className="cl-tick" d="M6.2 10.4 8.8 13l5-5.6" />
  </svg>
);

const Grip = () => (
  <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden>
    {[3, 8, 13].map((y) => (
      <g key={y}>
        <circle cx="3" cy={y} r="1.15" />
        <circle cx="7" cy={y} r="1.15" />
      </g>
    ))}
  </svg>
);

/** App-wide checklist under the top-right tools. Saved to %APPDATA%\Paperlike\checklist.json. */
export function ChecklistPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const tops = useRef(new Map<string, number>());
  const latest = useRef<Item[] | null>(null);
  const saveTimer = useRef(0);

  useEffect(() => {
    let alive = true;
    api
      .checklistLoad()
      .then((raw) => {
        if (!alive) return;
        const list = parseList(raw);
        latest.current = list;
        setItems(list);
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  const flush = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    const list = latest.current;
    if (!list) return;
    api
      .checklistSave(JSON.stringify({ version: 1, items: list }, null, 2))
      .then(() => setErr(""))
      .catch(() => setErr(messages.checklistSaveFailed));
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Closing the panel saves what is still waiting.
  useEffect(() => () => {
    if (saveTimer.current) flushRef.current();
  }, []);

  /* Rows glide to their new place when the order changes. */
  const remember = () => {
    tops.current.clear();
    rowEls.current.forEach((el, id) => tops.current.set(id, el.getBoundingClientRect().top));
  };
  useLayoutEffect(() => {
    if (!tops.current.size) return;
    rowEls.current.forEach((el, id) => {
      const before = tops.current.get(id);
      if (before === undefined || id === dragId) return;
      const dy = before - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = "";
      });
    });
    tops.current.clear();
  }, [items, dragId]);

  const change = (next: Item[], animate = false) => {
    if (animate) remember();
    setItems(next);
    latest.current = next;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flushRef.current(), 400);
  };
  const current = () => latest.current ?? items ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || panelRef.current?.contains(t) || t.closest?.(".qa-checklist-btn")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const add = (note: boolean) => {
    const text = draft.trim();
    if (!text || !items) return;
    change([...current(), { id: newItemId(), text, done: false, ...(note ? { note: true } : {}) }]);
    setDraft("");
  };
  const update = (id: string, patch: Partial<Item>) => change(current().map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id: string) => change(current().filter((x) => x.id !== id), true);
  const shift = (id: string, by: number) => {
    const list = current();
    const i = list.findIndex((x) => x.id === id);
    change(moveItem(list, i, i + by), true);
  };

  /* Drag the grip to reorder; the list follows the pointer live. */
  const startDrag = (id: string, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragId(id);
    const startY = e.clientY;
    let base = rowEls.current.get(id)?.getBoundingClientRect().top ?? 0;
    const move = (ev: PointerEvent) => {
      const el = rowEls.current.get(id);
      if (!el) return;
      const list = current();
      const from = list.findIndex((x) => x.id === id);
      let to = from;
      list.forEach((x, i) => {
        if (x.id === id) return;
        const r = rowEls.current.get(x.id)?.getBoundingClientRect();
        if (!r) return;
        const mid = r.top + r.height / 2;
        if (i < from && ev.clientY < mid) to = Math.min(to, i);
        if (i > from && ev.clientY > mid) to = Math.max(to, i);
      });
      if (to !== from) {
        change(moveItem(list, from, to), true);
      }
      // keep the lifted row under the pointer after the list moves
      requestAnimationFrame(() => {
        const node = rowEls.current.get(id);
        if (!node) return;
        node.style.transform = "";
        const natural = node.getBoundingClientRect().top;
        node.style.transform = `translateY(${base + (ev.clientY - startY) - natural}px)`;
      });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const node = rowEls.current.get(id);
      if (node) node.style.transform = "";
      setDragId(null);
      flushRef.current();
    };
    base = rowEls.current.get(id)?.getBoundingClientRect().top ?? base;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const tasks = items?.filter((i) => !i.note) ?? [];
  const doneCount = tasks.filter((i) => i.done).length;
  const left = tasks.length - doneCount;

  return (
    <div className={`checklist${dragId ? " is-dragging" : ""}`} ref={panelRef} role="dialog" aria-label={messages.checklistTitle}>
      <svg className="checklist-mottle" aria-hidden>
        <filter id="cl-rough" x="-4%" y="-4%" width="108%" height="108%">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="4" seed="4" result="t" />
          <feDisplacementMap in="SourceGraphic" in2="t" scale="5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div className="checklist-head">
        <div className="checklist-titles">
          <span className="checklist-title">{messages.checklistTitle}</span>
          {items && tasks.length > 0 && <span className="checklist-count">{messages.checklistLeft(left)}</span>}
        </div>
        {doneCount > 0 && (
          <button
            type="button"
            className="checklist-clear"
            onClick={() => change(current().filter((i) => !(i.done && !i.note)), true)}
          >
            {messages.checklistClearDone(doneCount)}
          </button>
        )}
        <button type="button" className="checklist-close" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <IcClose size={13} />
        </button>
      </div>
      <div className="checklist-list">
        {items && !items.length && <p className="checklist-empty">{messages.checklistEmpty}</p>}
        {items?.map((it) => (
          <div
            key={it.id}
            ref={(el) => {
              if (el) rowEls.current.set(it.id, el);
              else rowEls.current.delete(it.id);
            }}
            className={`checklist-row${it.note ? " note" : ""}${it.done ? " done" : ""}${dragId === it.id ? " lifted" : ""}`}
          >
            <button
              type="button"
              className="checklist-grip"
              title="Drag to reorder (Alt+↑/↓ while editing)"
              aria-label="Reorder"
              onPointerDown={(e) => startDrag(it.id, e)}
            >
              <Grip />
            </button>
            {it.note ? (
              <span className="checklist-bullet" aria-hidden />
            ) : (
              <button
                type="button"
                role="checkbox"
                aria-checked={it.done}
                className="checklist-check"
                aria-label={it.done ? "Mark as not done" : "Mark as done"}
                onClick={() => update(it.id, { done: !it.done })}
              >
                <Tick />
              </button>
            )}
            <textarea
              rows={1}
              value={it.text}
              spellCheck={false}
              onChange={(e) => update(it.id, { text: e.target.value })}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  const ta = e.currentTarget;
                  shift(it.id, e.key === "ArrowUp" ? -1 : 1);
                  requestAnimationFrame(() => ta.focus());
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addRef.current?.focus();
                }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.value.trim()) remove(it.id);
              }}
            />
            <button type="button" className="checklist-del" title="Delete" aria-label="Delete" onClick={() => remove(it.id)}>
              <IcClose size={11} />
            </button>
          </div>
        ))}
      </div>
      <form
        className="checklist-add"
        onSubmit={(e) => {
          e.preventDefault();
          add(false);
        }}
      >
        <button
          type="button"
          className="checklist-plus"
          title={messages.checklistAdd}
          aria-label={messages.checklistAdd}
          onClick={() => {
            if (draft.trim()) add(false);
            addRef.current?.focus();
          }}
        >
          +
        </button>
        <input
          ref={addRef}
          value={draft}
          autoFocus
          title={messages.checklistHint}
          placeholder={messages.checklistAdd}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              add(true);
            }
          }}
        />
      </form>
      {(err || (draft && !items?.length)) && <div className={`checklist-hint${err ? " warn" : ""}`}>{err || messages.checklistHint}</div>}
    </div>
  );
}
import { useEffect, useRef, useState } from "react";
import "@fontsource-variable/newsreader/opsz.css";
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

/** An eraser pass across a row: slanted up-down strokes from right to left, a little different each time. */
function scribblePath(w: number, h: number): string {
  let x = w - 4;
  let top = Math.random() < 0.5;
  const pts = [`M${x.toFixed(1)} ${(h * (top ? 0.8 : 0.2)).toFixed(1)}`];
  while (x > -4) {
    x -= 8 + Math.random() * 6;
    const y = h * (top ? 0.12 + Math.random() * 0.1 : 0.78 + Math.random() * 0.1);
    pts.push(`L${x.toFixed(1)} ${y.toFixed(1)}`);
    top = !top;
  }
  return pts.join(" ");
}

const ERASE_MS = 520;

/** App-wide checklist under the top-right tools. Saved to %APPDATA%\Paperlike\checklist.json. */
export function ChecklistPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [erasing, setErasing] = useState<Record<string, { d: string; w: number; h: number; left: number; top: number }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
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

  const change = (next: Item[]) => {
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
  const drop = (id: string) => change(current().filter((x) => x.id !== id));
  /* Deleting erases only the text (zig-zag mask), then folds the row away. */
  const remove = (id: string) => {
    const el = rowEls.current.get(id);
    if (!el || erasing[id] || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return drop(id);
    const row = el.getBoundingClientRect();
    const ta = el.querySelector("textarea");
    const box = (ta ?? el).getBoundingClientRect();
    const w = Math.max(1, box.width);
    const h = Math.max(1, box.height);
    setErasing((m) => ({
      ...m,
      [id]: { d: scribblePath(w, h), w, h, left: box.left - row.left, top: box.top - row.top },
    }));
    window.setTimeout(() => {
      el.style.height = `${row.height}px`;
      el.classList.add("folding");
      requestAnimationFrame(() => (el.style.height = "0px"));
    }, ERASE_MS);
    window.setTimeout(() => {
      drop(id);
      setErasing((m) => {
        const { [id]: _gone, ...rest } = m;
        return rest;
      });
    }, ERASE_MS + 200);
  };
  const shift = (id: string, by: number) => {
    const list = current();
    const i = list.findIndex((x) => x.id === id);
    change(moveItem(list, i, i + by));
  };

  /* Drag the grip to reorder: the row follows the pointer, the others make room, the order is saved on drop. */
  const startDrag = (id: string, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const list = current();
    const from = list.findIndex((x) => x.id === id);
    const dragged = rowEls.current.get(id);
    if (from < 0 || !dragged) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const slots = list.map((x) => {
      const r = rowEls.current.get(x.id)?.getBoundingClientRect();
      return { id: x.id, mid: r ? r.top + r.height / 2 : 0 };
    });
    const start = dragged.getBoundingClientRect();
    const h = start.height;
    const startY = e.clientY;
    let to = from;
    setDragId(id);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      dragged.style.transform = `translateY(${dy}px)`;
      const center = start.top + h / 2 + dy;
      to = 0;
      slots.forEach((sl, i) => {
        if (i !== from && sl.mid < center) to++;
      });
      slots.forEach((sl, i) => {
        if (i === from) return;
        const el = rowEls.current.get(sl.id);
        if (!el) return;
        const off = i > from && i <= to ? -h : i < from && i >= to ? h : 0;
        el.style.transform = off ? `translateY(${off}px)` : "";
      });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      rowEls.current.forEach((el) => {
        el.style.transition = "none";
        el.style.transform = "";
      });
      if (to !== from) change(moveItem(current(), from, to));
      setDragId(null);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => rowEls.current.forEach((el) => (el.style.transition = ""))),
      );
      flushRef.current();
    };
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
        {/* Ink soaked into rag paper: a soft bleed around the letters and ink that is a little
            thinner in places, instead of jagged edges. */}
        <filter id="cl-ink" x="-2%" y="-10%" width="104%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.35" numOctaves="2" seed="11" result="g" />
          <feDisplacementMap in="SourceGraphic" in2="g" scale="0.6" xChannelSelector="R" yChannelSelector="G" result="d" />
          <feGaussianBlur in="d" stdDeviation="0.45" result="bleed" />
          <feComponentTransfer in="bleed" result="halo">
            <feFuncA type="linear" slope="0.35" />
          </feComponentTransfer>
          <feMerge result="inked">
            <feMergeNode in="halo" />
            <feMergeNode in="d" />
          </feMerge>
          <feTurbulence type="fractalNoise" baseFrequency="0.06 0.12" numOctaves="2" seed="5" result="w" />
          <feComponentTransfer in="w" result="wear">
            <feFuncA type="linear" slope="0.5" intercept="0.68" />
          </feComponentTransfer>
          <feComposite in="inked" in2="wear" operator="in" />
        </filter>
      </svg>
      <div
        className="checklist-head"
        ref={(el) => {
          // The paper starts under the header; its height depends on the title's wrap.
          if (el) el.parentElement?.style.setProperty("--cl-head", `${el.offsetHeight}px`);
        }}
      >
        <div className="checklist-titles">
          <span className="checklist-title">{messages.checklistTitle}</span>
          {items && tasks.length > 0 && <span className="checklist-count">{messages.checklistLeft(left)}</span>}
        </div>
        {doneCount > 0 && (
          <button
            type="button"
            className="checklist-clear"
            onClick={() => change(current().filter((i) => !(i.done && !i.note)))}
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
            className={`checklist-row${it.note ? " note" : ""}${it.done ? " done" : ""}${dragId === it.id ? " lifted" : ""}${erasing[it.id] ? " erasing" : ""}`}
          >
            {erasing[it.id] && (
              <svg
                className="checklist-erase"
                viewBox={`0 0 ${erasing[it.id].w} ${erasing[it.id].h}`}
                width={erasing[it.id].w}
                height={erasing[it.id].h}
                style={{ left: erasing[it.id].left, top: erasing[it.id].top }}
                aria-hidden
              >
                <defs>
                  <mask id={`cl-erase-${it.id}`} maskUnits="userSpaceOnUse" x={0} y={0} width={erasing[it.id].w} height={erasing[it.id].h}>
                    <rect width={erasing[it.id].w} height={erasing[it.id].h} fill="#fff" />
                    <path
                      className="checklist-erase-stroke"
                      d={erasing[it.id].d}
                      pathLength={1}
                      style={{ strokeWidth: Math.max(12, erasing[it.id].h * 0.7) }}
                    />
                  </mask>
                </defs>
              </svg>
            )}
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
              style={
                erasing[it.id]
                  ? { maskImage: `url(#cl-erase-${it.id})`, WebkitMaskImage: `url(#cl-erase-${it.id})` }
                  : undefined
              }
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
                if (!e.currentTarget.value.trim()) drop(it.id);
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
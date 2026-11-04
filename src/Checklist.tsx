import { useEffect, useRef, useState } from "react";
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

/** App-wide checklist under the top-right tools. Saved to %APPDATA%\Paperlike\checklist.json. */
export function ChecklistPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const latest = useRef<Item[] | null>(null);
  const saveTimer = useRef(0);

  useEffect(() => {
    let alive = true;
    api
      .checklistLoad()
      .then((raw) => alive && setItems(parseList(raw)))
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
    change([...items, { id: newItemId(), text, done: false, ...(note ? { note: true } : {}) }]);
    setDraft("");
  };
  const update = (id: string, patch: Partial<Item>) =>
    change((latest.current ?? items ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id: string) => change((latest.current ?? items ?? []).filter((x) => x.id !== id));
  const doneCount = items?.filter((i) => i.done && !i.note).length ?? 0;

  return (
    <div className="checklist" ref={panelRef} role="dialog" aria-label={messages.checklistTitle}>
      <div className="checklist-head">
        <span>{messages.checklistTitle}</span>
        {doneCount > 0 && (
          <button
            type="button"
            className="btn checklist-clear"
            onClick={() => items && change(items.filter((i) => !(i.done && !i.note)))}
          >
            {messages.checklistClearDone(doneCount)}
          </button>
        )}
        <button type="button" className="btn icon" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="checklist-list">
        {items && !items.length && <p className="checklist-empty">{messages.checklistEmpty}</p>}
        {items?.map((it) => (
          <div key={it.id} className={`checklist-row${it.note ? " note" : ""}${it.done ? " done" : ""}`}>
            {!it.note && (
              <input
                type="checkbox"
                checked={it.done}
                aria-label={it.done ? "Mark as not done" : "Mark as done"}
                onChange={() => update(it.id, { done: !it.done })}
              />
            )}
            <textarea
              rows={1}
              value={it.text}
              onChange={(e) => update(it.id, { text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.value.trim()) remove(it.id);
              }}
            />
            <button type="button" className="checklist-del" title="Delete" aria-label="Delete" onClick={() => remove(it.id)}>
              <IcClose size={12} />
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
        <input
          value={draft}
          autoFocus
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
      <div className="checklist-hint">{err || messages.checklistHint}</div>
    </div>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AssistantEvent } from "./api";
import { ASK_DEFAULT_W, clampAskWidth } from "./AskPane";
import { IcBack, IcClose, IcReload, IcWide } from "./icons";

const HOST = "calendar";

let available = true;
const subs = new Set<() => void>();
/** Mirrors the Google Calendar setting so the toolbar can hide its button. */
export function setCalendarAvailable(on: boolean) {
  if (on === available) return;
  available = on;
  subs.forEach((f) => f());
}
export function useCalendarAvailable() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => available,
  );
}

/** Opens or closes the Google Calendar pane from anywhere in the app. */
export function toggleCalendar() {
  window.dispatchEvent(new Event("pl:calendar"));
}

/**
 * Google Calendar in a browser pane on the right, the same kind of view as Ask.
 * The sign-in stays in its own profile on this PC.
 */
export function CalendarPane({
  width,
  onWidth,
  onClose,
}: {
  width: number;
  onWidth: (w: number, done: boolean) => void;
  onClose: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const [loading, setLoading] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const place = async () => {
      const r = slotRef.current?.getBoundingClientRect();
      if (!r || r.width < 40 || r.height < 40) return;
      if (!shown.current) {
        shown.current = true;
        if (await api.assistantShow(HOST, r.x, r.y, r.width, r.height)) setLoading(true);
      } else {
        await api.assistantBounds(HOST, r.x, r.y, r.width, r.height);
      }
    };
    const id = window.setTimeout(() => {
      place().catch((e) => setError(String(e)));
    }, 40);
    const onResize = () => {
      place().catch(() => {});
    };
    window.addEventListener("resize", onResize);
    const obs = new ResizeObserver(onResize);
    if (slotRef.current) obs.observe(slotRef.current);
    const off = listen<AssistantEvent>("assistant", ({ payload }) => {
      if (payload.host !== HOST) return;
      if (payload.kind === "loading") setLoading(true);
      if (payload.kind === "loaded") {
        setLoading(false);
        setSignIn(/accounts\.google\.|ServiceLogin|signin/i.test(payload.detail));
      }
    });
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", onResize);
      obs.disconnect();
      void off.then((f) => f());
      api.assistantHide().catch(() => {});
    };
  }, []);

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

  return (
    <aside className="ask-pane calendar-pane" style={{ width }}>
      <div
        className="ask-resize"
        title="Drag to resize · double-click for half the window"
        onPointerDown={startResize}
        onDoubleClick={toggleWide}
      />
      <header className="ask-head">
        <div className="ask-hosts">
          <button type="button" className="on" onClick={() => void api.assistantNav(HOST, "new")} title="Back to the calendar">
            Google Calendar
          </button>
        </div>
        <div className="ask-tools">
          <button className="btn icon" type="button" title="Back" onClick={() => void api.assistantNav(HOST, "back")}>
            <IcBack size={15} />
          </button>
          <button className="btn icon" type="button" title="Reload" onClick={() => void api.assistantNav(HOST, "reload")}>
            <IcReload size={15} />
          </button>
          <span className="ask-sep" />
          <button className={`btn icon ${wide ? "active" : ""}`} type="button" title={wide ? "Narrow pane" : "Half the window"} onClick={toggleWide}>
            <IcWide size={15} />
          </button>
          <button className="btn icon" type="button" title="Close" onClick={onClose}>
            <IcClose size={15} />
          </button>
        </div>
      </header>
      {(error || signIn) && (
        <p className={`ask-status ${error ? "warn" : "info"}`}>
          {error || "Sign in to Google once. The login stays on this computer."}
        </p>
      )}
      <div className={`ask-progress ${loading ? "on" : ""}`} />
      <div className="ask-slot" ref={slotRef} />
    </aside>
  );
}

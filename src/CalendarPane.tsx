import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AssistantEvent } from "./api";
import { ASK_DEFAULT_W, clampAskWidth } from "./AskPane";
import { IcBack, IcClose, IcDock, IcFloat, IcReload, IcWide } from "./icons";

const HOST = "calendar";
const FLOAT_KEY = "pl.calendar.float";
const FLOAT_BOUNDS_KEY = "pl.calendar.floatBounds";

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

type FloatBounds = { left: number; top: number; width: number; height: number };

function readFloat(): boolean {
  return localStorage.getItem(FLOAT_KEY) === "1";
}

function readFloatBounds(): FloatBounds {
  try {
    const v = JSON.parse(localStorage.getItem(FLOAT_BOUNDS_KEY) || "") as FloatBounds;
    if (
      v &&
      typeof v.left === "number" &&
      typeof v.top === "number" &&
      typeof v.width === "number" &&
      typeof v.height === "number"
    ) {
      return v;
    }
  } catch {
    /* ignore */
  }
  return {
    left: Math.max(40, window.innerWidth - 520),
    top: 56,
    width: 440,
    height: Math.min(640, window.innerHeight - 80),
  };
}

function clampFloat(b: FloatBounds): FloatBounds {
  const margin = 8;
  const width = Math.max(280, Math.min(b.width, window.innerWidth - margin * 2));
  const height = Math.max(200, Math.min(b.height, window.innerHeight - margin * 2));
  return {
    width,
    height,
    left: Math.max(margin, Math.min(b.left, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(b.top, window.innerHeight - height - margin)),
  };
}

/**
 * Google Calendar in a browser pane on the right, or popped out as a floating overlay.
 * The sign-in stays in its own profile on this PC.
 */
export function CalendarPane({
  width,
  onWidth,
  onClose,
  floating,
  onFloating,
}: {
  width: number;
  onWidth: (w: number, done: boolean) => void;
  onClose: () => void;
  floating: boolean;
  onFloating: (on: boolean) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const shown = useRef(false);
  const [loading, setLoading] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [error, setError] = useState("");
  const [bounds, setBounds] = useState<FloatBounds>(() => clampFloat(readFloatBounds()));

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

  // Keep the embedded calendar webview lined up with the floating frame.
  useEffect(() => {
    if (!floating) return;
    const onWin = () => setBounds((b) => {
      const next = clampFloat(b);
      localStorage.setItem(FLOAT_BOUNDS_KEY, JSON.stringify(next));
      return next;
    });
    window.addEventListener("resize", onWin);
    return () => window.removeEventListener("resize", onWin);
  }, [floating]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    if (floating) {
      const start = bounds;
      const ox = e.clientX;
      const oy = e.clientY;
      const edge = (handle.dataset.edge || "w") as string;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - ox;
        const dy = ev.clientY - oy;
        let next = { ...start };
        if (edge.includes("e")) next.width = start.width + dx;
        if (edge.includes("s")) next.height = start.height + dy;
        if (edge.includes("w")) {
          next.left = start.left + dx;
          next.width = start.width - dx;
        }
        if (edge.includes("n")) {
          next.top = start.top + dy;
          next.height = start.height - dy;
        }
        setBounds(clampFloat(next));
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        setBounds((b) => {
          const next = clampFloat(b);
          localStorage.setItem(FLOAT_BOUNDS_KEY, JSON.stringify(next));
          return next;
        });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
      return;
    }
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

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!floating || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const ox = e.clientX - bounds.left;
    const oy = e.clientY - bounds.top;
    const move = (ev: PointerEvent) => setBounds(clampFloat({ ...bounds, left: ev.clientX - ox, top: ev.clientY - oy }));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const next = clampFloat({ ...bounds, left: ev.clientX - ox, top: ev.clientY - oy });
      setBounds(next);
      localStorage.setItem(FLOAT_BOUNDS_KEY, JSON.stringify(next));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const half = clampAskWidth(window.innerWidth / 2);
  const wide = width >= half - 8;
  const toggleWide = () => onWidth(wide ? clampAskWidth(ASK_DEFAULT_W) : half, true);

  const setFloat = (on: boolean) => {
    localStorage.setItem(FLOAT_KEY, on ? "1" : "0");
    if (on) {
      const next = clampFloat(bounds);
      setBounds(next);
      localStorage.setItem(FLOAT_BOUNDS_KEY, JSON.stringify(next));
    }
    onFloating(on);
  };

  return (
    <aside
      ref={paneRef}
      className={`ask-pane calendar-pane${floating ? " is-floating" : ""}`}
      style={
        floating
          ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
          : { width }
      }
    >
      {!floating && (
        <div
          className="ask-resize"
          title="Drag to resize · double-click for half the window"
          onPointerDown={startResize}
          onDoubleClick={toggleWide}
        />
      )}
      {floating &&
        (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((edge) => (
          <div key={edge} className={`cal-float-grip ${edge}`} data-edge={edge} onPointerDown={startResize} />
        ))}
      <header className="ask-head" onPointerDown={startDrag} title={floating ? "Drag to move" : undefined}>
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
          {floating ? (
            <button className="btn icon" type="button" title="Dock beside the note" onClick={() => setFloat(false)}>
              <IcDock size={15} />
            </button>
          ) : (
            <>
              <button className={`btn icon ${wide ? "active" : ""}`} type="button" title={wide ? "Narrow pane" : "Half the window"} onClick={toggleWide}>
                <IcWide size={15} />
              </button>
              <button className="btn icon" type="button" title="Pop out as a floating window" onClick={() => setFloat(true)}>
                <IcFloat size={15} />
              </button>
            </>
          )}
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

export { readFloat as calendarStartsFloating };

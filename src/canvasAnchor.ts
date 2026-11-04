/**
 * Lets screen overlays stick to a spot in a note: canvas editors register their view, and an
 * area captured on screen can be turned into note coordinates and back as the view pans or zooms.
 */
import type { AnalyzeRect } from "./Analyze";

type Cam = { x: number; y: number; z: number };

type Entry = {
  /** The note shown; areas only map back into the same note. */
  key: string;
  wrap: HTMLElement;
  cam: () => Cam;
};

/** An area in note coordinates. */
export type NoteArea = { key: string; x: number; y: number; w: number; h: number };

const entries = new Set<Entry>();
const listeners = new Set<() => void>();

/** One paint's worth of wrap/cam/clip reads, shared by every pinned card's place(). */
type ViewSnap = { b: DOMRect; c: Cam; clip: DOMRect };
let viewSnapGen = 0;
let viewSnap = new Map<string, ViewSnap>();
let notifyRaf = 0;

const flushListeners = () => {
  notifyRaf = 0;
  viewSnapGen++;
  viewSnap.clear();
  listeners.forEach((fn) => fn());
};

/** Coalesce bursty pan/zoom notifies into one listener pass per frame. */
const notify = () => {
  if (!listeners.size) return;
  if (notifyRaf) return;
  notifyRaf = requestAnimationFrame(flushListeners);
};

export function registerCanvas(entry: Entry): () => void {
  entries.add(entry);
  notify();
  return () => {
    entries.delete(entry);
    notify();
  };
}

/** A registered view moved (pan, zoom). Cheap when nothing listens. */
export function canvasMoved() {
  if (listeners.size) notify();
}

/** Runs `fn` whenever a view moves, scrolls or resizes, or an editor comes or goes. */
export function subscribeCanvas(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1) {
    window.addEventListener("scroll", notify, true);
    window.addEventListener("resize", notify);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      window.removeEventListener("scroll", notify, true);
      window.removeEventListener("resize", notify);
      if (notifyRaf) {
        cancelAnimationFrame(notifyRaf);
        notifyRaf = 0;
      }
    }
  };
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** The note area under a screen rect, when its center is over a canvas. */
export function noteAreaAt(rect: AnalyzeRect): NoteArea | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (const e of entries) {
    const b = e.wrap.getBoundingClientRect();
    if (!inside(b, cx, cy)) continue;
    const c = e.cam();
    return {
      key: e.key,
      x: (rect.x - b.left - c.x) / c.z,
      y: (rect.y - b.top - c.y) / c.z,
      w: rect.w / c.z,
      h: rect.h / c.z,
    };
  }
  return null;
}

/** The nearest scrolling ancestor, or the view itself; marks are clipped to it. */
function clipBox(wrap: HTMLElement): DOMRect {
  for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if (o === "auto" || o === "scroll") {
      const s = el.getBoundingClientRect();
      // A page view scrolls; a plain canvas fills its own box.
      if (s.height > wrap.getBoundingClientRect().height) return s;
      break;
    }
  }
  return wrap.getBoundingClientRect();
}

function snapOf(e: Entry): ViewSnap {
  let s = viewSnap.get(e.key);
  if (s) return s;
  s = { b: e.wrap.getBoundingClientRect(), c: e.cam(), clip: clipBox(e.wrap) };
  viewSnap.set(e.key, s);
  return s;
}

/** Where a note area is on screen now, and the visible box it is clipped to; null when its note isn't shown. */
export function screenOf(area: NoteArea): { rect: AnalyzeRect; clip: DOMRect } | null {
  let best: { rect: AnalyzeRect; clip: DOMRect } | null = null;
  for (const e of entries) {
    if (e.key !== area.key) continue;
    const { b, c, clip } = snapOf(e);
    const rect = { x: b.left + c.x + area.x * c.z, y: b.top + c.y + area.y * c.z, w: area.w * c.z, h: area.h * c.z };
    const hit = { rect, clip };
    // Several page editors can show one note; prefer the one the area sits in.
    if (inside(b, rect.x + rect.w / 2, rect.y + rect.h / 2)) return hit;
    best ??= hit;
  }
  return best;
}

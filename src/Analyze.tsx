import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { NoteArea, screenOf, subscribeCanvas } from "./canvasAnchor";
import { IcClose, IcExplain, IcSolve, IcVerify } from "./icons";

export type AnalyzeAction = "explain" | "solve" | "factcheck";

export type AnalyzeResult = {
  action: AnalyzeAction;
  pngB64: string;
  filePath: string;
  previewUrl: string;
  /** The captured area, in CSS pixels of the window. */
  rect: AnalyzeRect;
};

export type AnalyzeRect = { x: number; y: number; w: number; h: number };
type Rect = AnalyzeRect;

export type AnalyzeShot = { pngB64: string; filePath: string; previewUrl: string };

const MIN = 24;

const PROMPT: Record<AnalyzeAction, string> = {
  explain: "Explain what is shown in this image clearly and briefly. Keep formulas in their original notation.",
  solve: "Solve the problem shown in this image. Show the main steps, keep the original notation, and give the final answer.",
  factcheck:
    "Verify the claims or work shown in this image. Identify for yourself each mistake, missing unit, or wrong step and locate where it is. For wrong facts, list the corrections. For wrong reasoning, explain step by step how to correct my work. If everything is correct, say so briefly. Otherwise, begin with \"Corrections:\", start directly with the first mistake, and explain each correction clearly.",
};

export function analyzePrompt(action: AnalyzeAction): string {
  return PROMPT[action];
}

/** First words of each prompt, current and earlier wordings, so a sent prompt reads back as its action. */
const PROMPT_START: [AnalyzeAction, string][] = [
  ["explain", "Explain what is shown in this image"],
  ["solve", "Solve the problem shown in this image"],
  ["factcheck", "Verify the claims or work shown in this image"],
];

/** The action a sent question is the prompt of (also after a rescan's lead-in), or null. */
export function promptAction(text: string): { action: AnalyzeAction; rescan: boolean } | null {
  const rescan = text.startsWith("I changed the area;");
  const body = rescan ? text.slice(text.indexOf(".") + 1).trim() : text.trim();
  const hit = PROMPT_START.find(([, start]) => body.startsWith(start));
  return hit ? { action: hit[0], rescan } : null;
}

const LABEL: Record<AnalyzeAction, string> = { explain: "Explain", solve: "Solve", factcheck: "Verify" };

/** The button name of an action ("factcheck" is kept as the key so older history still reads). */
export function analyzeLabel(action: AnalyzeAction): string {
  return LABEL[action];
}

export function AnalyzeIcon({ action, size = 14 }: { action: AnalyzeAction; size?: number }) {
  if (action === "explain") return <IcExplain size={size} />;
  if (action === "solve") return <IcSolve size={size} />;
  return <IcVerify size={size} />;
}

/** Where an Analyze area is on screen now: it follows its note while the view moves. */
export function areaOnScreen(rect: AnalyzeRect, area?: NoteArea | null): { rect: AnalyzeRect; clip: DOMRect | null } | null {
  if (!area) return { rect, clip: null };
  return screenOf(area);
}

/** The visible part of an area (inside its view and the window), or null when none of it shows. */
export function visiblePart(rect: AnalyzeRect, clip: DOMRect | null): AnalyzeRect | null {
  const l = Math.max(rect.x, clip?.left ?? 0, 0);
  const t = Math.max(rect.y, clip?.top ?? 0, 0);
  const r = Math.min(rect.x + rect.w, clip?.right ?? Infinity, window.innerWidth);
  const b = Math.min(rect.y + rect.h, clip?.bottom ?? Infinity, window.innerHeight);
  return r - l >= MIN && b - t >= MIN ? { x: l, y: t, w: r - l, h: b - t } : null;
}

/** Dashed outline around the area an open answer is about. It sits just outside the area,
 *  so it is never in a capture, and it follows the note when the area was on a canvas. */
export function AnalyzeMark({ rect, area }: { rect: AnalyzeRect; area?: NoteArea | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const PAD = 4;
    const place = () => {
      const at = areaOnScreen(rect, area);
      if (!at) {
        el.style.display = "none";
        return;
      }
      const L = at.rect.x - PAD;
      const T = at.rect.y - PAD;
      const W = at.rect.w + PAD * 2;
      const H = at.rect.h + PAD * 2;
      let inset = "";
      if (at.clip) {
        const c = at.clip;
        const it = Math.max(0, c.top - T);
        const il = Math.max(0, c.left - L);
        const ib = Math.max(0, T + H - c.bottom);
        const ir = Math.max(0, L + W - c.right);
        if (it + ib >= H || il + ir >= W) {
          el.style.display = "none";
          return;
        }
        if (it || il || ib || ir) inset = `inset(${it}px ${ir}px ${ib}px ${il}px)`;
      }
      el.style.display = "";
      el.style.left = `${L}px`;
      el.style.top = `${T}px`;
      el.style.width = `${W}px`;
      el.style.height = `${H}px`;
      el.style.clipPath = inset;
    };
    place();
    return area ? subscribeCanvas(place) : undefined;
  }, [rect, area]);
  return <div ref={ref} className="analyze-mark" aria-hidden />;
}

/**
 * Capture what is on the display under `rect` (CSS pixels of the window) and stage it as a PNG.
 * `hide` elements are made invisible for the shot so app chrome isn't in it.
 */
export async function captureArea(rect: AnalyzeRect, hide: (HTMLElement | null | undefined)[] = []): Promise<AnalyzeShot> {
  const els = hide.filter((el): el is HTMLElement => !!el);
  const prev = els.map((el) => el.style.visibility);
  els.forEach((el) => (el.style.visibility = "hidden"));
  let pngB64: string;
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // CSS pixels → physical via devicePixelRatio.
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round((window.screenX + rect.x) * dpr);
    const sy = Math.round((window.screenY + rect.y) * dpr);
    const sw = Math.max(1, Math.round(rect.w * dpr));
    const sh = Math.max(1, Math.round(rect.h * dpr));
    pngB64 = await api.captureScreenRegion(sx, sy, sw, sh);
  } finally {
    els.forEach((el, i) => (el.style.visibility = prev[i] ?? ""));
  }
  const filePath = await api.stageAnalyzePng(pngB64);
  return { pngB64, filePath, previewUrl: `data:image/png;base64,${pngB64}` };
}

/**
 * Firefox-style area capture: drag a rectangle, adjust grips, then Explain / Solve / Verify.
 * Captures the physical screen under the selection (what's visually on the display).
 */
export function AnalyzeOverlay({
  onCancel,
  onCapture,
}: {
  onCancel: () => void;
  onCapture: (result: AnalyzeResult) => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<"new" | "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const origin = useRef<{ x: number; y: number; rect: Rect } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const clampRect = (r: Rect): Rect => {
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    let { x, y, w, h } = r;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    x = Math.max(0, Math.min(x, maxW - MIN));
    y = Math.max(0, Math.min(y, maxH - MIN));
    w = Math.max(MIN, Math.min(w, maxW - x));
    h = Math.max(MIN, Math.min(h, maxH - y));
    return { x, y, w, h };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy) return;
    const t = e.target as HTMLElement;
    if (t.closest(".analyze-actions, .analyze-grip, .analyze-hint")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    origin.current = { x: start.x, y: start.y, rect: { x: start.x, y: start.y, w: 0, h: 0 } };
    setDrag("new");
    setRect({ x: start.x, y: start.y, w: 0, h: 0 });
    setErr("");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !origin.current) return;
    const o = origin.current;
    if (drag === "new") {
      setRect(clampRect({ x: o.x, y: o.y, w: e.clientX - o.x, h: e.clientY - o.y }));
      return;
    }
    if (drag === "move") {
      const dx = e.clientX - o.x;
      const dy = e.clientY - o.y;
      setRect(clampRect({ ...o.rect, x: o.rect.x + dx, y: o.rect.y + dy }));
      return;
    }
    let { x, y, w, h } = o.rect;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    if (drag.includes("e")) w = o.rect.w + dx;
    if (drag.includes("s")) h = o.rect.h + dy;
    if (drag.includes("w")) {
      x = o.rect.x + dx;
      w = o.rect.w - dx;
    }
    if (drag.includes("n")) {
      y = o.rect.y + dy;
      h = o.rect.h - dy;
    }
    setRect(clampRect({ x, y, w, h }));
  };

  const onPointerUp = () => {
    setDrag(null);
    origin.current = null;
  };

  const beginAdjust = (e: React.PointerEvent, mode: NonNullable<typeof drag>) => {
    if (!rect || e.button !== 0 || busy) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY, rect: { ...rect } };
    setDrag(mode);
  };

  const run = async (action: AnalyzeAction) => {
    if (!rect || rect.w < MIN || rect.h < MIN || busy) return;
    setBusy(true);
    setErr("");
    try {
      // Hide the overlay chrome so it isn't in the shot, then capture the desktop under the selection.
      const shot = await captureArea(rect, [overlayRef.current]);
      onCapture({ action, ...shot, rect: { ...rect } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const ready = !!rect && rect.w >= MIN && rect.h >= MIN && !drag;

  return (
    <div
      ref={overlayRef}
      className="analyze-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {!rect && <div className="analyze-dim" />}
      <div className="analyze-hint">
        Drag to select an area · Esc to cancel
        <button
          type="button"
          className="btn icon"
          title="Cancel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCancel}
        >
          <IcClose size={14} />
        </button>
      </div>
      {rect && (
        <div
          className="analyze-sel"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          onPointerDown={(e) => beginAdjust(e, "move")}
        >
          {(["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const).map((g) => (
            <div key={g} className={`analyze-grip ${g}`} onPointerDown={(e) => beginAdjust(e, g)} />
          ))}
          {ready && (
            <div className="analyze-actions" onPointerDown={(e) => e.stopPropagation()}>
              {(["explain", "solve", "factcheck"] as const).map((a) => (
                <button key={a} type="button" className="btn analyze-act" disabled={busy} onClick={() => void run(a)}>
                  <AnalyzeIcon action={a} />
                  {analyzeLabel(a)}
                </button>
              ))}
              <span className="analyze-sep" aria-hidden="true" />
              <button
                type="button"
                className="btn analyze-close"
                onClick={onCancel}
                title="Close (Esc)"
                aria-label="Close"
              >
                <IcClose size={14} />
                Close
              </button>
            </div>
          )}
        </div>
      )}
      {err && <div className="analyze-err">{err}</div>}
      {busy && <div className="analyze-busy">Capturing…</div>}
    </div>
  );
}

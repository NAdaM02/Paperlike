import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { IcClose } from "./icons";

export type AnalyzeAction = "explain" | "solve" | "factcheck";

export type AnalyzeResult = {
  action: AnalyzeAction;
  pngB64: string;
  filePath: string;
  previewUrl: string;
};

type Rect = { x: number; y: number; w: number; h: number };

const MIN = 24;

const PROMPT: Record<AnalyzeAction, string> = {
  explain: "Explain what is shown in this image clearly and briefly. Keep formulas in their original notation.",
  solve: "Solve the problem shown in this image. Show the main steps, keep the original notation, and give the final answer.",
  factcheck:
    "Fact-check the claims or work shown in this image. Flag mistakes, missing units, or wrong steps. Say what is correct and what is not.",
};

export function analyzePrompt(action: AnalyzeAction): string {
  return PROMPT[action];
}

/**
 * Firefox-style area capture: drag a rectangle, adjust grips, then Explain / Solve / Fact-check.
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
      // Hide the overlay chrome so it isn't in the shot, then capture the desktop
      // under the selection. CSS pixels → physical via devicePixelRatio.
      const root = overlayRef.current;
      if (root) root.style.visibility = "hidden";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const dpr = window.devicePixelRatio || 1;
      const sx = Math.round((window.screenX + rect.x) * dpr);
      const sy = Math.round((window.screenY + rect.y) * dpr);
      const sw = Math.max(1, Math.round(rect.w * dpr));
      const sh = Math.max(1, Math.round(rect.h * dpr));
      let pngB64: string;
      try {
        pngB64 = await api.captureScreenRegion(sx, sy, sw, sh);
      } finally {
        if (root) root.style.visibility = "";
      }
      const filePath = await api.stageAnalyzePng(pngB64);
      const previewUrl = `data:image/png;base64,${pngB64}`;
      onCapture({ action, pngB64, filePath, previewUrl });
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
              <button type="button" className="btn" disabled={busy} onClick={() => void run("explain")}>
                Explain
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void run("solve")}>
                Solve
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void run("factcheck")}>
                Fact-check
              </button>
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

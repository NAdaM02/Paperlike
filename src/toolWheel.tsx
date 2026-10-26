import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Tool } from "./CanvasEditor";
import {
  IcArrow,
  IcCursor,
  IcEllipse,
  IcEraser,
  IcHighlighter,
  IcLasso,
  IcLine,
  IcPen,
  IcRect,
  IcSpark,
} from "./icons";

type Entry = { id: Tool; label: string; icon: ReactNode; angle: number };

/** Degrees clockwise from the right, screen y growing downward. */
const TOOLS: Entry[] = [
  { id: "select", label: "Select", icon: <IcCursor size={16} />, angle: 176 },
  { id: "lasso", label: "Lasso", icon: <IcLasso size={16} />, angle: 210 },
  { id: "pen", label: "Pen", icon: <IcPen size={16} />, angle: 244 },
  { id: "highlighter", label: "Marker", icon: <IcHighlighter size={16} />, angle: 278 },
  { id: "smart", label: "Smart", icon: <IcSpark size={16} />, angle: 314 },
  { id: "eraser", label: "Eraser", icon: <IcEraser size={16} />, angle: 350 },
  { id: "ellipse", label: "Ellipse", icon: <IcEllipse size={16} />, angle: 28 },
  { id: "rect", label: "Rect", icon: <IcRect size={16} />, angle: 64 },
  { id: "arrow", label: "Arrow", icon: <IcArrow size={16} />, angle: 100 },
  { id: "line", label: "Line", icon: <IcLine size={16} />, angle: 136 },
];

const RADIUS = 86;

function place(angle: number): { left: number; top: number } {
  const a = (angle * Math.PI) / 180;
  return {
    left: Math.cos(a) * RADIUS,
    top: Math.sin(a) * RADIUS,
  };
}

/**
 * Radial tool picker. Select and Lasso sit on the left.
 * Pens sweep the top from the left toward the right.
 * Shapes sweep the bottom the same way.
 * The empty middle is a second-click target for the tool's settings.
 */
export function ToolWheel({
  x,
  y,
  tool,
  onPick,
  onCenter,
  onDismiss,
}: {
  x: number;
  y: number;
  tool: Tool;
  onPick: (t: Tool) => void;
  onCenter: () => void;
  /** Click on the empty page: close the wheel and start this tool at that spot. */
  onDismiss: (clientX: number, clientY: number) => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const arm = () => setArmed(true);
    window.addEventListener("pointerup", arm, true);
    return () => window.removeEventListener("pointerup", arm, true);
  }, []);
  return createPortal(
    <div className="tool-wheel-root" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button
        type="button"
        className="tool-wheel-back"
        aria-label="Close tools"
        onPointerDown={(e) => {
          if (!armed) return;
          e.preventDefault();
          e.stopPropagation();
          onDismiss(e.clientX, e.clientY);
        }}
      />
      <div className="tool-wheel" style={{ left: x, top: y }} role="menu" aria-label="Drawing tools">
        <button
          type="button"
          className="tool-wheel-hub"
          title="Tool settings"
          aria-label="Open settings for the current tool"
          onClick={(e) => {
            e.stopPropagation();
            onCenter();
          }}
        />
        {TOOLS.map((t) => {
          const p = place(t.angle);
          const on = tool === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={`tool-wheel-btn ${on ? "on" : ""}`}
              style={{ marginLeft: p.left, marginTop: p.top }}
              title={t.label}
              aria-label={t.label}
              onClick={(e) => {
                e.stopPropagation();
                onPick(t.id);
              }}
            >
              {t.icon}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/** Settings card. Opens above the spot where the wheel was summoned, and stays on screen. */
export function DrawOptionsPop({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const arm = () => setArmed(true);
    window.addEventListener("pointerup", arm, true);
    return () => window.removeEventListener("pointerup", arm, true);
  }, []);
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 12;
    const left = Math.max(pad, Math.min(x - r.width / 2, window.innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(y - r.height - 14, window.innerHeight - r.height - pad));
    setBox({ left, top });
  }, [x, y, children]);
  return createPortal(
    <div className="tool-wheel-root" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button
        type="button"
        className="tool-wheel-back"
        aria-label="Close settings"
        onPointerDown={(e) => {
          if (!armed) return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={popRef}
        className="draw-pop"
        style={box ? { left: box.left, top: box.top } : { left: x, top: y, visibility: "hidden" }}
        role="dialog"
        aria-label="Drawing settings"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

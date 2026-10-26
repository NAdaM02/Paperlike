import { useCallback, useEffect, useRef, useState } from "react";

const HISTORY_KEY = "paperlike-color-history";
const MAX_HISTORY = 12;

export function loadColorHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c));
  } catch {
    return [];
  }
}

export function pushColorHistory(color: string): string[] {
  const hex = normalizeHex(color);
  if (!hex) return loadColorHistory();
  const next = [hex, ...loadColorHistory().filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(
    0,
    MAX_HISTORY,
  );
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}

export function normalizeHex(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^#?([0-9a-f]{6})$/);
  if (!m) return null;
  return `#${m[1]}`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = normalizeHex(hex) ?? "#000000";
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

type CustomColorPickerProps = {
  color: string;
  onChange: (hex: string) => void;
  onKeepSelection?: () => void;
};

export function CustomColorPicker({ color, onChange, onKeepSelection }: CustomColorPickerProps) {
  const seed = normalizeHex(color) ?? "#000000";
  const [hsv, setHsv] = useState(() => hexToHsv(seed));
  const [history, setHistory] = useState<string[]>(() => loadColorHistory());
  const [hexDraft, setHexDraft] = useState(seed);
  const dragging = useRef<"sv" | "hue" | null>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  useEffect(() => {
    const next = normalizeHex(color) ?? "#000000";
    setHsv(hexToHsv(next));
    setHexDraft(next);
  }, [color]);

  const emit = useCallback(
    (next: { h: number; s: number; v: number }, commit: boolean) => {
      const hex = hsvToHex(next.h, next.s, next.v);
      setHsv(next);
      setHexDraft(hex);
      onChange(hex);
      if (commit) {
        const hist = pushColorHistory(hex);
        setHistory(hist);
      }
    },
    [onChange],
  );

  const pickSv = useCallback(
    (clientX: number, clientY: number, commit: boolean) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const s = clamp((clientX - rect.left) / rect.width, 0, 1);
      const v = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
      emit({ ...hsvRef.current, s, v }, commit);
    },
    [emit],
  );

  const pickHue = useCallback(
    (clientX: number, commit: boolean) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = clamp((clientX - rect.left) / rect.width, 0, 1) * 360;
      emit({ ...hsvRef.current, h }, commit);
    },
    [emit],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current === "sv") pickSv(e.clientX, e.clientY, false);
      else if (dragging.current === "hue") pickHue(e.clientX, false);
    };
    const onUp = (e: PointerEvent) => {
      if (dragging.current === "sv") pickSv(e.clientX, e.clientY, true);
      else if (dragging.current === "hue") pickHue(e.clientX, true);
      dragging.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [pickHue, pickSv]);

  const guardDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onKeepSelection?.();
  };

  const preview = hsvToHex(hsv.h, hsv.s, hsv.v);
  const hueCss = `hsl(${hsv.h}, 100%, 50%)`;

  return (
    <div className="color-custom">
      <div
        ref={svRef}
        className="color-custom-sv"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})`,
        }}
        onPointerDown={(e) => {
          guardDown(e);
          dragging.current = "sv";
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pickSv(e.clientX, e.clientY, false);
        }}
      >
        <span
          className="color-custom-pointer"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: preview }}
        />
      </div>
      <div
        ref={hueRef}
        className="color-custom-hue"
        onPointerDown={(e) => {
          guardDown(e);
          dragging.current = "hue";
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pickHue(e.clientX, false);
        }}
      >
        <span className="color-custom-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="color-custom-preview">
        <span className="color-custom-swatch" style={{ background: preview }} />
        <input
          className="color-custom-hex"
          value={hexDraft}
          spellCheck={false}
          onChange={(e) => setHexDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const parsed = normalizeHex(hexDraft);
            if (!parsed) return;
            const next = hexToHsv(parsed);
            emit(next, true);
          }}
          onBlur={() => {
            const parsed = normalizeHex(hexDraft);
            if (!parsed) {
              setHexDraft(preview);
              return;
            }
            emit(hexToHsv(parsed), true);
          }}
        />
      </div>
      {history.length > 0 ? (
        <div className="color-custom-history">
          {history.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-custom-hist ${c.toLowerCase() === preview.toLowerCase() ? "on" : ""}`}
              style={{ background: c }}
              title={c}
              onMouseDown={(e) => {
                e.preventDefault();
                onKeepSelection?.();
              }}
              onClick={() => {
                const next = hexToHsv(c);
                emit(next, true);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

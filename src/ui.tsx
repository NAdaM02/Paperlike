import { ReactNode, useEffect, useRef, useState } from "react";
import { IcClose } from "./icons";

/* ── Modal ── */
export function Modal({
  title,
  children,
  actions,
  onClose,
  wide,
  className,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? "wide" : ""} ${className ?? ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {title ? <h2 className="modal-title">{title}</h2> : <span className="modal-title" />}
          <button type="button" className="btn icon modal-close" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <IcClose size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ── Confirm dialog (replaces window.confirm, which is a no-op in Tauri) ── */
export type ConfirmState = {
  title: string;
  message?: string;
  okLabel?: string;
  danger?: boolean;
  onOk: () => void;
} | null;

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState;
  onClose: () => void;
}) {
  if (!state) return null;
  return (
    <Modal
      title={state.title}
      onClose={onClose}
      actions={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button
            className={state.danger ? "btn danger-fill" : "btn primary"}
            onClick={() => {
              state.onOk();
              onClose();
            }}
          >
            {state.okLabel ?? "OK"}
          </button>
        </>
      }
    >
      {state.message && <p className="muted" style={{ marginTop: 0 }}>{state.message}</p>}
    </Modal>
  );
}

/* ── Prompt dialog (replaces window.prompt) ── */
export type PromptState = {
  title: string;
  label?: string;
  initial?: string;
  okLabel?: string;
  multiline?: boolean;
  onOk: (value: string) => void;
} | null;

export function PromptDialog({
  state,
  onClose,
}: {
  state: PromptState;
  onClose: () => void;
}) {
  const [value, setValue] = useState(state?.initial ?? "");
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    setValue(state?.initial ?? "");
    setTimeout(() => {
      ref.current?.focus();
      if (ref.current instanceof HTMLInputElement) ref.current.select();
    }, 30);
  }, [state]);
  if (!state) return null;
  const submit = () => {
    state.onOk(value);
    onClose();
  };
  return (
    <Modal
      title={state.title}
      onClose={onClose}
      actions={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {state.okLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="field">
        {state.label && <span>{state.label}</span>}
        {state.multiline ? (
          <textarea
            ref={ref as React.RefObject<HTMLTextAreaElement>}
            className="field-textarea"
            value={value}
            rows={4}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            ref={ref as React.RefObject<HTMLInputElement>}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/* ── Context menu ── */
export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      hint?: string;
      disabled?: boolean;
      title?: string;
      onClick: () => void;
    }
  | "sep";

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  header,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  header?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {header}
      {items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            title={it.title}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
            {it.hint && <span className="hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/* ── Cover fallback color from name ── */
export function nameHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function coverGradient(name: string): string {
  const h = nameHue(name || "?");
  return `linear-gradient(135deg, hsl(${h} 42% 52%), hsl(${(h + 40) % 360} 46% 38%))`;
}

/* ── bytes → base64 (chunked; avoids call-stack overflow on big files) ── */
export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type PickedImage = { name: string; b64: string; width: number; height: number };

/** Natural pixel size of a base64 image, so it can be placed at the right aspect ratio. */
export function imageSize(b64: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => resolve({ width: 320, height: 220 });
    img.src = `data:image/*;base64,${b64}`;
  });
}

/** Scale to fit a sensible default box while preserving the aspect ratio. */
export function fitImage(
  width: number,
  height: number,
  maxW = 420,
  maxH = 420,
): { width: number; height: number } {
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function pickLocalPdf(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function pickLocalImage(multiple = false): Promise<PickedImage[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/bmp,image/webp";
    input.multiple = multiple;
    input.onchange = async () => {
      const out: PickedImage[] = [];
      for (const f of input.files ?? []) {
        const b64 = bytesToB64(new Uint8Array(await f.arrayBuffer()));
        const { width, height } = await imageSize(b64);
        out.push({ name: f.name, b64, width, height });
      }
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

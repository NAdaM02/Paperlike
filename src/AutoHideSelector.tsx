import { useEffect, useRef, useState } from "react";
import { AutoHideMode } from "./api";
import { IcAutoHide, IcPin, IcCursor, IcCheck } from "./icons";
import { messages } from "./copy/messages";

interface AutoHideSelectorProps {
  mode: AutoHideMode;
  onChange: (next: AutoHideMode) => void;
  barLabel: string;
  align?: "left" | "right";
}

const MODES: { id: AutoHideMode; name: string; desc: string; icon: typeof IcAutoHide }[] = [
  {
    id: "none",
    name: messages.autohideModeNone,
    desc: messages.autohideModeNoneDesc,
    icon: IcPin,
  },
  {
    id: "dynamic",
    name: messages.autohideModeDynamic,
    desc: messages.autohideModeDynamicDesc,
    icon: IcAutoHide,
  },
  {
    id: "hover",
    name: messages.autohideModeHover,
    desc: messages.autohideModeHoverDesc,
    icon: IcCursor,
  },
];

export function AutoHideSelector({
  mode,
  onChange,
  barLabel,
  align = "left",
}: AutoHideSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const CurrentIcon = current.icon;
  const tooltip = `${current.name} (${current.desc.toLowerCase()})`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="autohide-anchor" ref={rootRef}>
      <button
        type="button"
        className={`btn icon title-autohide autohide-btn${mode !== "none" ? " is-on" : ""}${open ? " open" : ""}`}
        title={tooltip}
        aria-label={`${barLabel}: ${tooltip}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <CurrentIcon size={15} />
      </button>

      {open && (
        <div className={`autohide-popover align-${align}`} role="menu" aria-label="Auto-collapse mode">
          <div className="autohide-popover-title">{barLabel} auto-collapse</div>
          {MODES.map((item) => {
            const Icon = item.icon;
            const isSelected = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                className={`autohide-option${isSelected ? " active" : ""}`}
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
              >
                <span className="autohide-option-icon">
                  <Icon size={14} />
                </span>
                <span className="autohide-option-text">
                  <span className="autohide-option-name">{item.name}</span>
                  <span className="autohide-option-desc">{item.desc}</span>
                </span>
                {isSelected && (
                  <span className="autohide-option-check">
                    <IcCheck size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  ACTIONS,
  ActionId,
  assignChord,
  bindings,
  CONTROLS_EVENT,
  FIXED_CONTROLS,
  formatChord,
  keyChord,
  mouseChord,
  removeChord,
  resetControls,
  setCapturing,
} from "./controls";

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];
let captureGen = 0;

/** Re-render when bindings change (this window or a Settings edit). */
function useBindings() {
  const [b, setB] = useState(bindings);
  useEffect(() => {
    const on = () => setB(bindings());
    window.addEventListener(CONTROLS_EVENT, on);
    return () => window.removeEventListener(CONTROLS_EVENT, on);
  }, []);
  return b;
}

/** Read-only list of every control: the rebindable ones as currently bound, then the built-in ones. */
export function ControlsOverview() {
  const b = useBindings();
  return (
    <div className="shortcuts-sheet">
      {GROUPS.map((g) => (
        <section className="shortcuts-group" key={g}>
          <h3 className="shortcuts-group-title">{g}</h3>
          <ul className="shortcuts-list">
            {ACTIONS.filter((a) => a.group === g).map((a) => (
              <li key={a.id}>
                <kbd className="shortcuts-keys">{b[a.id].length ? b[a.id].map(formatChord).join(" / ") : "—"}</kbd>
                <span>{a.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {FIXED_CONTROLS.map((g) => (
        <section className="shortcuts-group" key={g.group}>
          <h3 className="shortcuts-group-title">{g.group}</h3>
          <ul className="shortcuts-list">
            {g.rows.map((r) => (
              <li key={r.keys}>
                <kbd className="shortcuts-keys">{r.keys}</kbd>
                <span>{r.action}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Rebind controls: remove a binding with ×, add one by pressing a key, chord or extra mouse button. */
export function ControlsEditor({ onToast }: { onToast: (msg: string) => void }) {
  const b = useBindings();
  const [capture, setCapture] = useState<ActionId | null>(null);

  useEffect(() => {
    if (!capture) return;
    const gen = ++captureGen;
    setCapturing(true);
    const done = () => setCapture(null);
    const take = (chord: string) => {
      const moved = assignChord(capture, chord);
      if (moved.length) {
        const names = moved.map((id) => ACTIONS.find((a) => a.id === id)?.label ?? id).join(", ");
        onToast(`${formatChord(chord)} moved from ${names}.`);
      }
      done();
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return done();
      const chord = keyChord(e);
      if (chord) take(chord);
    };
    const onDown = (e: MouseEvent) => {
      const chord = mouseChord(e);
      if (chord) {
        e.preventDefault();
        e.stopImmediatePropagation();
        take(chord);
      } else if (!(e.target as Element | null)?.closest?.(".controls-capture")) {
        done();
      }
    };
    const swallow = (e: MouseEvent) => {
      if (e.button >= 3) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", swallow, true);
    window.addEventListener("auxclick", swallow, true);
    return () => {
      // The button's own mouseup arrives after this closes; keep it from navigating back.
      window.setTimeout(() => gen === captureGen && setCapturing(false), 250);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", swallow, true);
      window.removeEventListener("auxclick", swallow, true);
    };
  }, [capture, onToast]);

  return (
    <div className="controls-editor">
      {GROUPS.map((g) => (
        <section className="settings-section" key={g}>
          <h3>{g}</h3>
          {ACTIONS.filter((a) => a.group === g).map((a) => (
            <div className="controls-row" key={a.id}>
              <span className="controls-label">{a.label}</span>
              <span className="controls-chips">
                {b[a.id].map((c) => (
                  <span className="controls-chip" key={c}>
                    <kbd>{formatChord(c)}</kbd>
                    <button type="button" title="Remove" aria-label={`Remove ${formatChord(c)}`} onClick={() => removeChord(a.id, c)}>
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className={`btn small controls-capture ${capture === a.id ? "active" : ""}`}
                  onClick={() => setCapture(capture === a.id ? null : a.id)}
                >
                  {capture === a.id ? "Press a key or mouse button…" : "+ Add"}
                </button>
              </span>
            </div>
          ))}
        </section>
      ))}
      <div className="controls-foot">
        <button type="button" className="btn" onClick={() => resetControls()}>
          Reset all to defaults
        </button>
      </div>
    </div>
  );
}
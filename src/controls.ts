/**
 * Rebindable controls: keyboard chords and extra mouse buttons, saved on this computer.
 *
 * A chord is a string like "Ctrl+Shift+F", "P", "F13" or "Mouse4" (the back thumb button;
 * Mouse5 is forward). Mice such as the Logitech MX Master send their extra buttons either
 * as those mouse buttons or as key presses set up in Logi Options+, so both can be bound.
 *
 * Layers: "app" actions work everywhere; "note" actions only inside an open note, where
 * they win over an app action on the same chord (the thumb buttons undo in a note and go
 * back elsewhere). "canvas" actions are note actions that only fire while not typing.
 */

export type Layer = "app" | "note" | "canvas";

export type ActionId =
  | "save"
  | "undo"
  | "redo"
  | "find"
  | "newNote"
  | "math"
  | "rename"
  | "searchAll"
  | "ask"
  | "quickAsk"
  | "analyze"
  | "back"
  | "forward"
  | "tool.select"
  | "tool.lasso"
  | "tool.pen"
  | "tool.highlighter"
  | "tool.smart"
  | "tool.eraser"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.line"
  | "tool.arrow"
  | "width.down"
  | "width.up"
  | "eraser.mode";

export type ActionDef = { id: ActionId; label: string; group: string; layer: Layer; defaults: string[] };

export const ACTIONS: ActionDef[] = [
  { id: "save", label: "Save", group: "Note", layer: "note", defaults: ["Ctrl+S"] },
  { id: "undo", label: "Undo", group: "Note", layer: "note", defaults: ["Ctrl+Z", "Mouse4"] },
  { id: "redo", label: "Redo", group: "Note", layer: "note", defaults: ["Ctrl+Y", "Ctrl+Shift+Z", "Mouse5"] },
  { id: "find", label: "Find in note", group: "Note", layer: "note", defaults: ["Ctrl+F"] },
  { id: "newNote", label: "New note", group: "Note", layer: "note", defaults: ["Ctrl+N"] },
  { id: "math", label: "Insert math", group: "Note", layer: "note", defaults: ["Ctrl+M"] },
  { id: "rename", label: "Rename note", group: "Note", layer: "note", defaults: ["F2"] },
  { id: "searchAll", label: "Search everywhere", group: "App", layer: "app", defaults: ["Ctrl+Shift+F"] },
  { id: "ask", label: "Study menu (Ask, Quiz me, AI)", group: "App", layer: "app", defaults: ["Ctrl+J"] },
  { id: "quickAsk", label: "Quick ask field", group: "App", layer: "app", defaults: ["Ctrl+K"] },
  { id: "analyze", label: "Analyze", group: "App", layer: "app", defaults: ["Ctrl+Shift+A"] },
  { id: "back", label: "Back", group: "App", layer: "app", defaults: ["Alt+ArrowLeft", "Mouse4"] },
  { id: "forward", label: "Forward", group: "App", layer: "app", defaults: ["Alt+ArrowRight", "Mouse5"] },
  { id: "tool.select", label: "Select", group: "Tools", layer: "canvas", defaults: ["V"] },
  { id: "tool.lasso", label: "Lasso", group: "Tools", layer: "canvas", defaults: ["S"] },
  { id: "tool.pen", label: "Pen", group: "Tools", layer: "canvas", defaults: ["P"] },
  { id: "tool.highlighter", label: "Marker", group: "Tools", layer: "canvas", defaults: ["H"] },
  { id: "tool.smart", label: "Smart ink", group: "Tools", layer: "canvas", defaults: ["G"] },
  { id: "tool.eraser", label: "Eraser", group: "Tools", layer: "canvas", defaults: ["E"] },
  { id: "tool.line", label: "Line", group: "Tools", layer: "canvas", defaults: ["L"] },
  { id: "tool.arrow", label: "Arrow", group: "Tools", layer: "canvas", defaults: ["A"] },
  { id: "tool.rect", label: "Rectangle", group: "Tools", layer: "canvas", defaults: ["R"] },
  { id: "tool.ellipse", label: "Ellipse", group: "Tools", layer: "canvas", defaults: ["O"] },
  { id: "width.down", label: "Thinner stroke", group: "Tools", layer: "canvas", defaults: ["[", "Alt+F"] },
  { id: "width.up", label: "Thicker stroke", group: "Tools", layer: "canvas", defaults: ["]", "Alt+G"] },
  { id: "eraser.mode", label: "Eraser: area / whole stroke", group: "Tools", layer: "canvas", defaults: ["Shift+E"] },
];

/** Built in and not rebindable; listed in the overview so it shows everything. */
export const FIXED_CONTROLS: { group: string; rows: { keys: string; action: string }[] }[] = [
  {
    group: "Editing",
    rows: [
      { keys: "Ctrl+C / X / V", action: "Copy / cut / paste" },
      { keys: "Del", action: "Delete selection" },
      { keys: "Ctrl+-", action: "Strikethrough (in text)" },
      { keys: "Ctrl+= / Ctrl+Shift+=", action: "Subscript / superscript" },
      { keys: "Ctrl+Space", action: "Clear formatting" },
      { keys: "Shift", action: "Straight ink, constrained shapes" },
    ],
  },
  {
    group: "View",
    rows: [
      { keys: "Ctrl+scroll", action: "Zoom" },
      { keys: "Ctrl+0", action: "Zoom to 100%" },
      { keys: "Space+drag", action: "Pan" },
      { keys: "F11", action: "Full screen" },
      { keys: "Esc", action: "Select tool / leave full screen" },
      { keys: "?", action: "This overview" },
    ],
  },
  {
    group: "PDF pages",
    rows: [
      { keys: "Shift+click", action: "Pick images on the page" },
      { keys: "Shift+drag", action: "Reorder joined pages" },
      { keys: "Right-click", action: "Page menu (drop, separate, lock)" },
    ],
  },
];

export type Bindings = Record<ActionId, string[]>;

/** True while Settings waits for a new binding; every control handler stands down. */
let capturingNow = false;
export const setCapturing = (on: boolean) => {
  capturingNow = on;
};
export const isCapturing = () => capturingNow;

const STORE_KEY = "pl.controls.v1";
export const CONTROLS_EVENT = "paperlike-controls-changed";

const defaults = (): Bindings =>
  Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.defaults]])) as Bindings;

let cache: Bindings | null = null;

/** Current bindings: saved overrides on top of the defaults. */
export function bindings(): Bindings {
  if (cache) return cache;
  const out = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<Record<string, unknown>>;
    for (const a of ACTIONS) {
      const v = saved[a.id];
      if (Array.isArray(v)) out[a.id] = v.filter((c): c is string => typeof c === "string" && c.length > 0);
    }
  } catch {
    /* corrupt or blocked storage: defaults */
  }
  cache = out;
  return out;
}

function store(next: Bindings) {
  cache = next;
  try {
    // Only what differs from the defaults, so new defaults still reach untouched actions.
    const base = defaults();
    const diff: Partial<Bindings> = {};
    for (const a of ACTIONS) if (next[a.id].join("|") !== base[a.id].join("|")) diff[a.id] = next[a.id];
    if (Object.keys(diff).length) localStorage.setItem(STORE_KEY, JSON.stringify(diff));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* quota / private mode */
  }
  window.dispatchEvent(new Event(CONTROLS_EVENT));
}

const layerOf = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.layer;
/** App actions and note actions may share a chord; note and canvas actions may not. */
const sameLayer = (a: Layer, b: Layer) => (a === "app") === (b === "app");

/** Add `chord` to `id`. Returns the actions in the same layer that lost it. */
export function assignChord(id: ActionId, chord: string): ActionId[] {
  const cur = bindings();
  const layer = layerOf(id);
  const moved: ActionId[] = [];
  const next = { ...cur };
  for (const a of ACTIONS) {
    if (a.id === id || !sameLayer(a.layer, layer) || !cur[a.id].includes(chord)) continue;
    next[a.id] = cur[a.id].filter((c) => c !== chord);
    moved.push(a.id);
  }
  if (!next[id].includes(chord)) next[id] = [...next[id], chord];
  store(next);
  return moved;
}

export function removeChord(id: ActionId, chord: string) {
  const cur = bindings();
  store({ ...cur, [id]: cur[id].filter((c) => c !== chord) });
}

export function resetControls(id?: ActionId) {
  const base = defaults();
  store(id ? { ...bindings(), [id]: base[id] } : base);
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn", "Hyper", "Super"]);

function prefix(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) {
  return `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.metaKey ? "Win+" : ""}`;
}

/** Chord of a key press, or null for a lone modifier. Letters follow the keyboard layout. */
export function keyChord(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key) || e.key === "Dead" || e.key === "Unidentified") return null;
  let key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Ctrl+- and Ctrl+= report odd keys on some layouts; the physical key is what users mean.
  if (e.ctrlKey && e.code === "Minus") key = "-";
  if (e.ctrlKey && e.code === "Equal") key = "=";
  return prefix(e) + key;
}

/** Chord of an extra mouse button (back = Mouse4, forward = Mouse5, more = Mouse6…); null for left/middle/right. */
export function mouseChord(e: MouseEvent): string | null {
  if (e.button < 3) return null;
  return `${prefix(e)}Mouse${e.button + 1}`;
}

/** Actions bound to `chord`, optionally only those in `layers`. */
export function actionsFor(chord: string | null, layers?: Layer[]): ActionId[] {
  if (!chord) return [];
  const b = bindings();
  return ACTIONS.filter((a) => (!layers || layers.includes(a.layer)) && b[a.id].includes(chord)).map((a) => a.id);
}

const PRETTY: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Mouse4: "Mouse back",
  Mouse5: "Mouse forward",
  Escape: "Esc",
  Delete: "Del",
};

export function formatChord(chord: string): string {
  const parts = chord.split("+");
  // "Ctrl++" splits into an empty tail; keep the plus key.
  const key = chord.endsWith("++") ? "+" : parts[parts.length - 1];
  const mods = chord.endsWith("++") ? parts.slice(0, -2) : parts.slice(0, -1);
  return [...mods, PRETTY[key] ?? (/^Mouse\d+$/.test(key) ? `Mouse ${key.slice(5)}` : key)].join("+");
}
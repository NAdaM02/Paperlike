/** Set while a float is docking back, so unmounting it does not hide the webview. */
let holdWebview = false;

export function holdMoodleWebview() {
  holdWebview = true;
}

export function moodleWebviewHeld(): boolean {
  return holdWebview;
}

export function releaseMoodleHold() {
  holdWebview = false;
}

/** Viewport point where a Moodle file drag was released, in CSS pixels. */
let dropClient: { x: number; y: number } | null = null;

export function setMoodleDropClient(pt: { x: number; y: number } | null) {
  dropClient = pt;
}

/** Read and clear the drop point so the next insert lands under the cursor. */
export function takeMoodleDropClient(): { x: number; y: number } | null {
  const pt = dropClient;
  dropClient = null;
  return pt;
}

/** The open notebook registers this so a floating Moodle window can still insert a PDF. */
let insertPdf: ((path: string) => void) | null = null;

export function setMoodlePdfInserter(fn: ((path: string) => void) | null) {
  insertPdf = fn;
}

export function insertMoodlePdf(path: string): boolean {
  if (!insertPdf) return false;
  insertPdf(path);
  return true;
}

/** Faint page stack drawn over the note while a Moodle file is dragged. Not part of the document. */
export type MoodleDragGhost = {
  x: number;
  y: number;
  pageWidth: number;
  aspects: number[];
  preview?: string;
};

type DragSession = {
  token: number;
  /** Client point over the note. Null while the pointer is elsewhere. */
  client: { x: number; y: number } | null;
  dropped: boolean;
  pages: number;
  aspect: number;
  file: string | null;
};

let drag: DragSession | null = null;
const cancelled = new Set<number>();
let onDrag: (() => void) | null = null;

function notifyDrag() {
  onDrag?.();
}

export function subscribeMoodleDrag(fn: () => void) {
  onDrag = fn;
  return () => {
    if (onDrag === fn) onDrag = null;
  };
}

export function moodleDragSnapshot(): DragSession | null {
  return drag;
}

export function beginMoodleDrag(token: number) {
  if (drag && drag.token !== token) cancelled.add(drag.token);
  drag = { token, client: null, dropped: false, pages: 1, aspect: 1.294, file: null };
  notifyDrag();
}

export function moveMoodleDrag(token: number, client: { x: number; y: number } | null) {
  if (!drag || drag.token !== token || drag.dropped) return;
  drag = { ...drag, client };
  notifyDrag();
}

/** `client` is where the pointer was released on the note. Null cancels the drop. */
export function endMoodleDrag(token: number, client: { x: number; y: number } | null) {
  if (!drag || drag.token !== token) return;
  if (!client) {
    cancelled.add(token);
    drag = null;
    notifyDrag();
    return;
  }
  drag = { ...drag, dropped: true, client };
  notifyDrag();
}

export function shapeMoodleDrag(token: number, pages: number, aspect: number) {
  if (!drag || drag.token !== token) return;
  const count = Math.max(1, Math.min(80, Math.round(pages) || 1));
  const aspectOk = aspect > 0.15 && aspect < 8 ? aspect : 1.294;
  drag = { ...drag, pages: count, aspect: aspectOk };
  notifyDrag();
}

/**
 * A finished download. True when this token belongs to a drag (held or ignored).
 * False when the caller should insert the file itself (Add to note).
 */
export function acceptMoodleDragFile(token: number, path: string): boolean {
  if (token <= 0) return false;
  if (cancelled.has(token)) {
    cancelled.delete(token);
    return true;
  }
  if (!drag || drag.token !== token) return false;
  drag = { ...drag, file: path };
  notifyDrag();
  return true;
}

export function failMoodleDrag(token: number) {
  if (token > 0) cancelled.add(token);
  if (drag?.token === token) {
    drag = null;
    notifyDrag();
  }
}

export function finishMoodleDrag(token: number) {
  if (drag?.token === token) drag = null;
  cancelled.delete(token);
  notifyDrag();
}

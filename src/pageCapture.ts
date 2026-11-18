/**
 * Analyze pictures taken from the page as it is painted: folds, paper, type and ink
 * match the screen. Resolution is the only intended difference — about 175 dpi when
 * the area fits, so handwriting stays readable, and never fewer pixels than the screen.
 */
import { api } from "./api";
import { liveScreenOf, revealNoteArea, type NoteArea } from "./canvasAnchor";

type AreaShot = {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  px_w: number;
  px_h: number;
  overview: boolean;
};

export type PaintedArea = {
  previewB64: string;
  filePaths: string[];
  map: {
    note: string;
    area: { x: number; y: number; w: number; h: number };
    shots: AreaShot[];
  };
};

const MAX_SIDE = 2048;
const MAX_TILES = 12;

type Shot = AreaShot & { png: string };

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  });
}

function pngSize(b64: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => reject(new Error("Couldn't read the capture."));
    img.src = `data:image/png;base64,${b64}`;
  });
}

function loadPng(b64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read the capture."));
    img.src = `data:image/png;base64,${b64}`;
  });
}

/** The part of `rect` that is inside the canvas and the window. */
function visibleRect(
  rect: { x: number; y: number; w: number; h: number },
  clip: DOMRect,
): { x: number; y: number; w: number; h: number } | null {
  const l = Math.max(rect.x, clip.left, 0);
  const t = Math.max(rect.y, clip.top, 0);
  const r = Math.min(rect.x + rect.w, clip.right, window.innerWidth);
  const b = Math.min(rect.y + rect.h, clip.bottom, window.innerHeight);
  return r - l >= 8 && b - t >= 8 ? { x: l, y: t, w: r - l, h: b - t } : null;
}

/** Note rectangle actually inside a clipped screen shot of `tile`. */
function noteOfShot(
  tile: { x: number; y: number; w: number; h: number },
  full: { x: number; y: number; w: number; h: number },
  shot: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: tile.x + ((shot.x - full.x) / full.w) * tile.w,
    y: tile.y + ((shot.y - full.y) / full.h) * tile.h,
    w: (shot.w / full.w) * tile.w,
    h: (shot.h / full.h) * tile.h,
  };
}

/**
 * How to cut the area so each piece fits on the canvas and stays under MAX_SIDE
 * at `k` pixels per note unit. Pieces stay inside the current view.
 */
function planTiles(area: NoteArea, zoom: number, viewW: number, viewH: number, k: number) {
  const maxW = Math.max(24, Math.min(MAX_SIDE / (zoom * k), (viewW - 24) / zoom));
  const maxH = Math.max(24, Math.min(MAX_SIDE / (zoom * k), (viewH - 24) / zoom));
  const nx = Math.max(1, Math.ceil(area.w / maxW));
  const ny = Math.max(1, Math.ceil(area.h / maxH));
  const tw = area.w / nx;
  const th = area.h / ny;
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      tiles.push({ x: area.x + i * tw, y: area.y + j * th, w: tw, h: th });
    }
  }
  return tiles;
}

/** True when the bitmap looks like the rectangle we asked for, not a different page. */
function sizeMatches(
  dim: { w: number; h: number },
  css: { w: number; h: number },
  scale: number,
): boolean {
  if (dim.w < 8 || dim.h < 8 || css.w < 8 || css.h < 8) return false;
  const aspect = dim.w / dim.h;
  const want = css.w / css.h;
  if (Math.abs(aspect - want) / want > 0.08) return false;
  const expect = css.w * scale;
  const ratio = dim.w / expect;
  return ratio > 0.8 && ratio < 1.35;
}

async function captureClip(
  css: { x: number; y: number; w: number; h: number },
  scale: number,
): Promise<{ png: string; w: number; h: number }> {
  const png = await api.captureViewRegion(css.x, css.y, css.w, css.h, scale);
  const dim = await pngSize(png);
  if (!sizeMatches(dim, css, scale)) throw new Error("The capture didn't match the area.");
  return { png, w: dim.w, h: dim.h };
}

/** One screen-resolution shot of a rectangle that is already on the display. */
async function captureDesktop(css: { x: number; y: number; w: number; h: number }): Promise<{ png: string; w: number; h: number }> {
  const dpr = window.devicePixelRatio || 1;
  const sx = Math.round((window.screenX + css.x) * dpr);
  const sy = Math.round((window.screenY + css.y) * dpr);
  const sw = Math.max(1, Math.round(css.w * dpr));
  const sh = Math.max(1, Math.round(css.h * dpr));
  const png = await api.captureScreenRegion(sx, sy, sw, sh);
  const dim = await pngSize(png);
  return { png, w: dim.w, h: dim.h };
}

async function stitch(area: NoteArea, shots: Shot[], pxPerNote: number): Promise<string> {
  const long = Math.max(area.w, area.h) * pxPerNote;
  const fit = Math.min(1, 1400 / Math.max(1, long));
  const w = Math.max(1, Math.round(area.w * pxPerNote * fit));
  const h = Math.max(1, Math.round(area.h * pxPerNote * fit));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't build the overview.");
  for (const s of shots) {
    const img = await loadPng(s.png);
    ctx.drawImage(
      img,
      ((s.x - area.x) / area.w) * w,
      ((s.y - area.y) / area.h) * h,
      (s.w / area.w) * w,
      (s.h / area.h) * h,
    );
  }
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

/**
 * Paint `area` from the open note. Null when that note isn't on screen.
 * `hide` elements (the analyze frame, a card) are invisible for the shot.
 */
export async function capturePaintedArea(
  area: NoteArea,
  dpi: number,
  hide: HTMLElement[] = [],
): Promise<PaintedArea | null> {
  if (!(area.w > 1) || !(area.h > 1)) return null;
  const placed = liveScreenOf(area);
  if (!placed || !(placed.rect.w > 1)) return null;
  const zoom = placed.rect.w / area.w;
  if (!(zoom > 0)) return null;

  const dpr = window.devicePixelRatio || 1;
  const target = Math.max(dpr, dpi / 96);
  let k = Math.min(8, target / zoom);
  k = Math.max(dpr, k);
  let tiles = planTiles(area, zoom, placed.clip.width, placed.clip.height, k);
  while (tiles.length > MAX_TILES && k > dpr + 0.05) {
    k = Math.max(dpr, k * 0.85);
    tiles = planTiles(area, zoom, placed.clip.width, placed.clip.height, k);
  }
  const els = hide.filter(Boolean);
  const prev = els.map((el) => el.style.visibility);
  els.forEach((el) => (el.style.visibility = "hidden"));
  let restore = () => {};
  const shots: Shot[] = [];
  try {
    await frames(2);
    for (const tile of tiles) {
      const tileArea = { key: area.key, ...tile };
      let at = liveScreenOf(tileArea);
      const seen = at && visibleRect(at.rect, at.clip);
      const fully =
        !!at &&
        !!seen &&
        seen.w >= at.rect.w - 2 &&
        seen.h >= at.rect.h - 2;
      if (!fully) {
        restore();
        restore = revealNoteArea(tileArea) ?? (() => {});
        await frames(3);
        at = liveScreenOf(tileArea);
      }
      if (!at) continue;
      const css = visibleRect(at.rect, at.clip);
      if (!css) continue;
      const note = noteOfShot(tile, at.rect, css);
      let png: string;
      let pw: number;
      let ph: number;
      try {
        const shot = await captureClip(css, k);
        png = shot.png;
        pw = shot.w;
        ph = shot.h;
      } catch {
        const shot = await captureDesktop(css);
        png = shot.png;
        pw = shot.w;
        ph = shot.h;
      }
      shots.push({
        png,
        path: "",
        x: note.x,
        y: note.y,
        w: note.w,
        h: note.h,
        px_w: pw,
        px_h: ph,
        overview: false,
      });
    }
  } finally {
    restore();
    els.forEach((el, i) => (el.style.visibility = prev[i] ?? ""));
  }
  if (!shots.length) return null;

  const covers =
    shots.length === 1 &&
    Math.abs(shots[0].x - area.x) < 1.5 &&
    Math.abs(shots[0].y - area.y) < 1.5 &&
    Math.abs(shots[0].w - area.w) < area.w * 0.04 &&
    Math.abs(shots[0].h - area.h) < area.h * 0.04;

  const ordered: Shot[] = [];
  if (!covers) {
    const overview = await stitch(area, shots, k * zoom);
    const dim = await pngSize(overview);
    ordered.push({
      png: overview,
      path: "",
      x: area.x,
      y: area.y,
      w: area.w,
      h: area.h,
      px_w: dim.w,
      px_h: dim.h,
      overview: true,
    });
  }
  ordered.push(...shots);

  const filePaths: string[] = [];
  for (const s of ordered) {
    s.path = await api.stageAnalyzePng(s.png);
    filePaths.push(s.path);
  }
  const map: PaintedArea["map"] = {
    note: area.key,
    area: { x: area.x, y: area.y, w: area.w, h: area.h },
    shots: ordered.map(({ path, x, y, w, h, px_w, px_h, overview }) => ({ path, x, y, w, h, px_w, px_h, overview })),
  };
  return { previewB64: ordered[0].png, filePaths, map };
}

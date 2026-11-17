/**
 * Analyze images rendered from the note itself rather than screenshotted: the canvas
 * objects in an area (strokes, text boxes, pictures, PDF pages) are drawn offscreen by the
 * same code as the PDF export, at ~175 dpi, and large areas come back as an overview plus
 * tiles. Each image keeps an exact pixel <-> note mapping (`AreaMap`), which is also written
 * as JSON beside the PNGs, so answers can point back at places in the note later.
 */
import { api } from "./api";
import { areaContent, type NoteArea } from "./canvasAnchor";

export type AreaShot = {
  path: string;
  /** Part of the area this image shows, in note units. */
  x: number;
  y: number;
  w: number;
  h: number;
  px_w: number;
  px_h: number;
  /** A downscaled view of the whole area, sent before its tiles. */
  overview: boolean;
};

export type AreaMap = {
  note: string;
  area: { x: number; y: number; w: number; h: number };
  shots: AreaShot[];
  /** JSON copy of this map beside the PNGs. */
  mapPath?: string | null;
};

export type RenderedArea = { previewB64: string; filePaths: string[]; map: AreaMap };

/** Note point under pixel (px, py) of shot `i`. */
export function pixelToNote(map: AreaMap, i: number, px: number, py: number): { x: number; y: number } {
  const s = map.shots[i];
  return { x: s.x + (px * s.w) / s.px_w, y: s.y + (py * s.h) / s.px_h };
}

/** Pixel of shot `i` over note point (x, y). */
export function noteToPixel(map: AreaMap, i: number, x: number, y: number): { px: number; py: number } {
  const s = map.shots[i];
  return { px: ((x - s.x) * s.px_w) / s.w, py: ((y - s.y) * s.px_h) / s.h };
}

/** Render `area` from its note; null when that note isn't open in an editor. */
export async function renderNoteArea(area: NoteArea, dpi = 175): Promise<RenderedArea | null> {
  const content = areaContent(area);
  if (!content) return null;
  const mediaLens: Record<string, number> = {};
  for (const [k, v] of Object.entries(content.media)) mediaLens[k] = v.length;
  const base = { objects: content.objects, mediaLens, x: area.x, y: area.y, w: area.w, h: area.h, dpi, noteKey: area.key };
  // Media the renderer already has (a PDF from an earlier capture) isn't sent again.
  let out = await api.renderNoteArea({ ...base, media: {} });
  if (out.missing.length) {
    const media: Record<string, string> = {};
    for (const k of out.missing) if (content.media[k]) media[k] = content.media[k];
    out = await api.renderNoteArea({ ...base, media });
  }
  if (!out.shots.length) return null;
  return {
    previewB64: out.shots[0].png_b64,
    filePaths: out.shots.map((s) => s.path),
    map: {
      note: area.key,
      area: { x: area.x, y: area.y, w: area.w, h: area.h },
      shots: out.shots.map(({ path, x, y, w, h, px_w, px_h, overview }) => ({ path, x, y, w, h, px_w, px_h, overview })),
      mapPath: out.map_path,
    },
  };
}

/** Printed page-number masks. x/y/w/h are fractions of the page (0-1). */

export type PageRun = { str: string; x: number; y: number; h: number; w: number };

export type PageNumberMask = { page: number; x: number; y: number; w: number; h: number };

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanToInt(s: string): number | null {
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = ROMAN[s[i].toLowerCase()];
    if (!v) return null;
    if (v < prev) total -= v;
    else {
      total += v;
      prev = v;
    }
  }
  return total > 0 ? total : null;
}

/** The number a header/footer run prints, or null when it is not a page number. */
export function parsedPageNumber(raw: string): number | null {
  const s = raw.trim();
  let m = /^(\d{1,4})$/.exec(s);
  if (m) return Number(m[1]);
  m = /^page\s+(\d{1,4})$/i.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,4})\s*\/\s*\d{1,4}$/.exec(s);
  if (m) return Number(m[1]);
  m = /^-\s*(\d{1,4})\s*-$/.exec(s);
  if (m) return Number(m[1]);
  if (/^[ivxlcdm]{1,8}$/i.test(s)) return romanToInt(s);
  return null;
}

type Cand = {
  pageIndex: number;
  page: number;
  num: number;
  fx: number;
  fy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vw: number;
  vh: number;
};

/**
 * Find a printed page number that repeats down the joined pages.
 * One rect per matched page, expanded ~4px and stored as fractions of that page.
 * Returns null when nothing covers at least 40% of the pages (and at least 2).
 */
export function detectPageNumberMasks(
  pages: { page: number; runs: PageRun[]; vw: number; vh: number }[],
): PageNumberMask[] | null {
  const total = pages.length;
  if (total < 2) return null;
  const cands: Cand[] = [];
  pages.forEach((p, pageIndex) => {
    if (!(p.vw > 0) || !(p.vh > 0)) return;
    for (const run of p.runs) {
      const num = parsedPageNumber(run.str);
      if (num == null) continue;
      const cy = run.y + run.h / 2;
      // Header or footer. 8% missed numbers that sit just inside the margin.
      if (cy > p.vh * 0.22 && cy < p.vh * 0.78) continue;
      cands.push({
        pageIndex,
        page: p.page,
        num,
        fx: (run.x + run.w / 2) / p.vw,
        fy: cy / p.vh,
        x: run.x,
        y: run.y,
        w: run.w,
        h: run.h,
        vw: p.vw,
        vh: p.vh,
      });
    }
  });

  const byDelta = new Map<number, Cand[]>();
  for (const c of cands) {
    const delta = c.num - c.pageIndex;
    const list = byDelta.get(delta);
    if (list) list.push(c);
    else byDelta.set(delta, [c]);
  }

  const need = Math.max(2, Math.ceil(total * 0.4 - 1e-9));
  let best: Cand[] | null = null;
  for (const list of byDelta.values()) {
    for (const seed of list) {
      const onPage = new Map<number, Cand>();
      for (const c of list) {
        if (Math.abs(c.fx - seed.fx) > 0.02 || Math.abs(c.fy - seed.fy) > 0.02) continue;
        const prev = onPage.get(c.pageIndex);
        const d = Math.hypot(c.fx - seed.fx, c.fy - seed.fy);
        if (!prev || d < Math.hypot(prev.fx - seed.fx, prev.fy - seed.fy)) onPage.set(c.pageIndex, c);
      }
      if (onPage.size < need) continue;
      const items = [...onPage.values()];
      if (!best || items.length > best.length) best = items;
    }
  }
  if (!best) return null;

  const pad = 4;
  return best.map((it) => {
    let x = (it.x - pad) / it.vw;
    let y = (it.y - pad) / it.vh;
    let w = (it.w + pad * 2) / it.vw;
    let h = (it.h + pad * 2) / it.vh;
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    return { page: it.page, x, y, w: Math.max(0, w), h: Math.max(0, h) };
  });
}

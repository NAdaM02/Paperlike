/**
 * Match a notebook folder name to a TUM Moodle course title.
 *
 * Text is split into words, known multi-word spans are detected as phrases
 * ("technical drawing", "Luft- und Raumfahrt"), and the notebook phrase is
 * aligned in order inside the lecture title. Extra lecture words are allowed
 * between hits; a tight span scores higher than scattered words.
 */

/** Longer phrases first. Detected as a span, then stored as one subject token. */
const PHRASE_RULES: { words: string[]; canon: string }[] = [
  { words: ["technische", "mechanik"], canon: "mechanics" },
  { words: ["engineering", "mechanics"], canon: "mechanics" },
  { words: ["materials", "science"], canon: "materials" },
  { words: ["electrical", "engineering"], canon: "electrical" },
  { words: ["cad", "technical", "drawing"], canon: "caddrawing" },
  { words: ["technical", "drawing"], canon: "drawing" },
  { words: ["technisches", "zeichnen"], canon: "drawing" },
  { words: ["cad", "td"], canon: "caddrawing" },
  { words: ["luft", "raumfahrt"], canon: "aerospace" },
].sort((a, b) => b.words.length - a.words.length);

const WORD_CANON: Record<string, string> = {
  math: "math",
  mathematics: "math",
  mathematik: "math",
  mechanics: "mechanics",
  mechanik: "mechanics",
  materials: "materials",
  werkstoffkunde: "materials",
  werkstoffe: "materials",
  electrical: "electrical",
  elektrotechnik: "electrical",
  drawing: "drawing",
  zeichnen: "drawing",
  zeichnung: "drawing",
  advanced: "advanced",
  hohere: "advanced",
  intro: "intro",
  introduction: "intro",
  einfuehrung: "intro",
  einfuhrung: "intro",
  foundations: "foundations",
  grundlagen: "foundations",
  computational: "computational",
  programming: "computational",
  programmierung: "computational",
  informatik: "computational",
  aerospace: "aerospace",
  luftfahrt: "aerospace",
  raumfahrt: "aerospace",
  cad: "cad",
};

const ROMAN: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
};

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "and",
  "or",
  "for",
  "with",
  "in",
  "on",
  "at",
  "by",
  "from",
  "und",
  "oder",
  "der",
  "die",
  "das",
  "dem",
  "den",
  "des",
  "ein",
  "eine",
  "einer",
  "einem",
  "einen",
  "im",
  "fur",
  "fuer",
  "von",
  "vom",
  "mit",
  "auf",
  "zu",
  "zur",
  "zum",
  "bei",
  "course",
  "courses",
  "vorlesung",
  "lecture",
  "ubung",
  "uebung",
  "ubungen",
  "uebungen",
  "exercise",
  "exercises",
  "tutorial",
  "tutorials",
  "tutorium",
  "zentral",
  "haus",
  "modul",
  "module",
]);

function rawWords(input: string): string[] {
  const s = input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/&/g, " and ");
  const out: string[] = [];
  for (const raw of s.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const t = ROMAN[raw] ?? raw;
    if (STOP.has(t)) continue;
    if (/^(ws|ss|wise|sose)(\d{2,4})?$/.test(t)) continue;
    if (/^(19|20)\d{2}$/.test(t)) continue;
    if (/^(winter|summer|sommer|wintersemester|sommersemester|semester)$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** Scan for known phrases, then map leftover words. Order is kept. */
function foldSequence(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const rule = PHRASE_RULES.find(
      (r) => r.words.length <= words.length - i && r.words.every((w, k) => words[i + k] === w),
    );
    if (rule) {
      out.push(rule.canon);
      i += rule.words.length;
      continue;
    }
    const w = words[i];
    out.push(WORD_CANON[w] ?? w);
    i++;
  }
  return out;
}

/** Subject phrase in reading order, Roman numerals already turned into digits. */
export function normalize(input: string): string[] {
  return foldSequence(rawWords(input));
}

const NUM = /^\d+$/;

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Same canon, a shared stem, or a one-character typo on a longer word. */
function tokenClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5) {
    const stem = 5;
    if (a.slice(0, stem) === b.slice(0, stem)) return true;
    if (Math.abs(a.length - b.length) <= 1 && editDistance(a, b) <= 1) return true;
  }
  return false;
}

/**
 * Notebook phrase as an in-order span of the lecture title.
 * Contiguous means the lecture has that phrase together, not scattered.
 */
function alignPhrase(notebook: string[], course: string[]): { hit: number; contiguous: boolean } {
  let from = 0;
  let first = -1;
  let last = -1;
  let hit = 0;
  for (const token of notebook) {
    let found = -1;
    for (let k = from; k < course.length; k++) {
      if (tokenClose(token, course[k])) {
        found = k;
        break;
      }
    }
    if (found < 0) continue;
    if (first < 0) first = found;
    last = found;
    hit++;
    from = found + 1;
  }
  return { hit, contiguous: hit > 1 && last - first + 1 === hit };
}

/**
 * How much of the notebook phrase sits, in order, inside the lecture title.
 * A full tight span scores high even when the lecture title has extra words
 * outside that span. Shared course numbers raise it; disagreeing numbers pull it down.
 */
export function score(notebookName: string, courseName: string): number {
  const a = normalize(notebookName);
  const b = normalize(courseName);
  const subA = a.filter((t) => !NUM.test(t));
  const subB = b.filter((t) => !NUM.test(t));
  if (!subA.length || !subB.length) return 0;
  const { hit, contiguous } = alignPhrase(subA, subB);
  if (!hit) return 0;
  const cover = hit / subA.length;
  let s = 0.35 + 0.4 * cover;
  if (contiguous && cover === 1) s += 0.1;
  const na = a.filter((t) => NUM.test(t));
  const nb = new Set(b.filter((t) => NUM.test(t)));
  if (na.some((n) => nb.has(n))) s += 0.2;
  else if (na.length && nb.size) s -= 0.4;
  return Math.max(0, Math.min(1, s));
}

export type Scored<T> = { item: T; score: number; confident: boolean };

/**
 * Every subject word of the short name has to show up in the course title.
 * A shared "aerospace" or a shared course number is not enough.
 * When both sides carry a course number, the numbers have to agree.
 */
export function titleFits(shortName: string, courseTitle: string): boolean {
  const wantAll = normalize(shortName);
  const haveAll = normalize(courseTitle);
  const want = wantAll.filter((t) => !NUM.test(t));
  const have = haveAll.filter((t) => !NUM.test(t));
  if (!want.length || !have.length) return false;
  if (!want.every((token) => have.some((h) => tokenClose(token, h)))) return false;
  const wantNum = wantAll.filter((t) => NUM.test(t));
  const haveNum = new Set(haveAll.filter((t) => NUM.test(t)));
  if (wantNum.length && haveNum.size && !wantNum.every((n) => haveNum.has(n))) return false;
  return true;
}

/**
 * Confident when the notebook phrase is actually contained in that course,
 * the score leads the runner-up, and it clears the usual bar.
 * A single enrolled course can still be confident.
 */
export function bestMatch<T>(notebookName: string, courses: { label: string; item: T }[]): Scored<T> | null {
  if (!notebookName.trim() || !courses.length) return null;
  let best: { item: T; score: number; label: string } | null = null;
  let second = 0;
  for (const c of courses) {
    const s = score(notebookName, c.label);
    if (!best || s > best.score) {
      second = best ? Math.max(second, best.score) : second;
      best = { item: c.item, score: s, label: c.label };
    } else if (s > second) {
      second = s;
    }
  }
  if (!best) return null;
  return {
    item: best.item,
    score: best.score,
    confident: best.score >= 0.5 && best.score - second >= 0.15 && titleFits(notebookName, best.label),
  };
}

/** Short names used for the first-semester courses, in display form. */
const UNIFIED_NAMES = [
  "Advanced Math 1",
  "CAD & Technical Drawing",
  "Computational Foundations 1",
  "Electrical Engineering 1",
  "Intro to Aerospace",
  "Materials Science",
  "Mechanics 1",
];

function foldLoose(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();
}

function looksLikeCad(label: string): boolean {
  const f = foldLoose(label);
  return (
    /\bcad\s*\/\s*td\b/.test(f) ||
    /\bcad\s+td\b/.test(f) ||
    /\btechnical drawing\b/.test(f) ||
    /\btechnisches zeichnen\b/.test(f)
  );
}

/** Drop semester codes, course numbers, and exercise words. Keep the subject. */
export function cleanCourseTitle(label: string): string {
  const cleaned = label
    .replace(/\b(übung|uebung|übungen|exercise|exercises|tutorial|tutorium|vorlesung|lecture)\b/gi, " ")
    .replace(/\b(ws|ss|wise|sose)\s*\d{2,4}\s*\/\s*\d{2,4}\b/gi, " ")
    .replace(/\b(ws|ss|wise|sose)\s*\d{0,4}\b/gi, " ")
    .replace(/\b[ws]\d{2}\s*\/\s*\d{2}\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/\b(winter|summer|sommer)semester\b/gi, " ")
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || label.trim();
}

const EXERCISE_RE = /\b(ubung|uebung|ubungen|uebungen|exercise|exercises|tutorial|tutorials|tutorium)\b/;

/** Exercise courses are the ones whose Moodle title says so. Everything else is a lecture. */
export function courseTab(label: string): "lectures" | "exercises" {
  return EXERCISE_RE.test(foldLoose(label)) ? "exercises" : "lectures";
}

function subjectCount(name: string): number {
  return normalize(name).filter((t) => !NUM.test(t)).length;
}

/** The most specific short name whose whole subject phrase sits inside the title. */
function bestFitting(label: string, names: string[]): string {
  const fits = names.filter((n) => n.trim() && titleFits(n, label));
  if (!fits.length) return "";
  fits.sort((a, b) => subjectCount(b) - subjectCount(a) || b.length - a.length);
  return fits[0];
}

/** Course numbers are written as digits. A lone "I" in a title is the number 1. */
function arabicNumbers(name: string): string {
  return name.replace(/\b(X|IX|VIII|VII|VI|IV|V|III|II|I)\b/g, (m) => ROMAN[m.toLowerCase()] ?? m);
}

/**
 * The short course name. A notebook name is used only when its whole subject
 * phrase is in the title. Otherwise a known first-semester name, then the
 * title without the semester and the exercise words.
 * Exercise courses keep that short name and gain " – Exercise" (" – Tutorial" for tutorials).
 */
export function unifiedCourseName(label: string, preferred: string[] = []): string {
  const fixed = looksLikeCad(label)
    ? "CAD & Technical Drawing"
    : /\bprecourse\b/.test(foldLoose(label)) && /\bmath/.test(foldLoose(label))
      ? "Math Precourse"
      : "";
  const base = arabicNumbers(fixed || bestFitting(label, [...preferred, ...UNIFIED_NAMES]) || cleanCourseTitle(label));
  if (courseTab(label) !== "exercises" || / – (Exercise|Tutorial)$/.test(base)) return base;
  return `${base} – ${/\btutori(al|als|um)\b/.test(foldLoose(label)) ? "Tutorial" : "Exercise"}`;
}

import { BriefDepth } from "./brief";

export type QuizCard = {
  id: string;
  topic: string;
  question: string;
  answer: string;
};

export type QuizMark = "correct" | "partial" | "incorrect";

export type QuizReview = {
  id: string;
  mark: QuizMark;
  note: string;
};

export type QuizReport = {
  reviews: QuizReview[];
  recap: string;
  focus: string[];
};

const COUNT: Record<BriefDepth, string> = {
  short: "6",
  study: "10",
  full: "14",
};

/** What the model must emit so the cards can be built without guessing. */
export function quizStudyPrompt(opts: {
  depth: BriefDepth;
  topic: string;
  notes: { title: string; text: string }[];
  attached: boolean;
}): string {
  const titles = opts.notes.map((n) => n.title.trim() || "Untitled");
  const topic = opts.topic.trim();
  const body = opts.attached
    ? `Each note is attached as a PDF (the page, with drawings and slides) and as Markdown. Notes: ${titles.join(", ")}.`
    : [
        "Notes:",
        "",
        opts.notes
          .map((n) => {
            const text = n.text.trim();
            const body = text.length > 14000 ? `${text.slice(0, 14000).trimEnd()}\n\n[this note was cut here]` : text;
            return `## ${n.title.trim() || "Untitled"}\n\n${body || "(this note has no text boxes)"}`;
          })
          .join("\n\n") || "(no note text)",
        "",
        "The same pages may also be attached as PDF and Markdown. Use a drawing or slide when the text does not show it.",
      ].join("\n");
  return [
    "You are writing a closed-book quiz from a student's own notes.",
    "Use only what is in the notes. If a number, formula, or claim is not there, the answer says it is not in the notes. Do not invent values.",
    "Keep the notes' notation. LaTeX inside $...$ is fine. Do not rewrite a formula into a different one.",
    `Write exactly ${COUNT[opts.depth]} cards. Mix recall, why a step holds, and what breaks if a condition changes.`,
    topic ? `Stay on this topic: ${topic}. Skip anything in the notes that does not bear on it.` : "Cover the notes they included.",
    "Reply with nothing except this block:",
    "",
    "<<<PAPERLIKE_CARDS>>>",
    '{"cards":[{"id":"1","topic":"Describe then analyze","question":"Why is this only a description?\\n\\n*At higher angles of attack, the measured drag coefficient increased.*\\n\\nWhat does this add?\\n\\n*After flow separation began, drag rose more rapidly.*","answer":"The first only reports what was measured.\\n\\nThe second names the cause: separation, then more pressure drag."}]}',
    "<<<END>>>",
    "",
    "question is what the student sees, with no hint of the key. answer is the key. topic is two or three words. ids are 1, 2, 3… One JSON object. No markdown fence and no text outside the block.",
    "The quotation marks in that JSON must be the straight \" character. Do not use curly quotes.",
    "Write questions a student can read at a glance. Short sentences. One idea each. Do not pack two quotations and several asks into one sentence.",
    "A question is at most a few short lines. If you quote the notes, put that sentence on its own line, in *italics*, with a blank line before the question about it.",
    "If the card asks more than one thing, number them 1. 2. 3. on consecutive lines. Do not put a blank line between those lines, and do not start every line with 1.",
    "answer is a few short lines in the same shape, not a paragraph.",
    "Inside a JSON string, a line break is the two characters \\n and a blank line is \\n\\n. Bold is **like this**. Do not put a raw line break inside the JSON.",
    "",
    body,
  ].join("\n");
}

export function quizGradePrompt(cards: QuizCard[], answers: Record<string, string>): string {
  const lines = cards.map((card, i) => {
    const given = (answers[card.id] ?? "").trim();
    return [
      `Card ${i + 1} (id ${card.id})`,
      `Topic: ${card.topic || "general"}`,
      `Question: ${card.question}`,
      `Key: ${card.answer}`,
      `Student: ${given || "(blank)"}`,
    ].join("\n");
  });
  return [
    "Grade this closed-book quiz. The key is the source of truth. A blank answer is incorrect.",
    "Reply with nothing except this block:",
    "",
    "<<<PAPERLIKE_REVIEW>>>",
    '{"reviews":[{"id":"1","mark":"correct","note":"one or two sentences"}],"recap":"two or three sentences on how they did","focus":["topic to revise"]}',
    "<<<END>>>",
    "",
    "mark is exactly one of: correct, partial, incorrect.",
    "correct: the idea and the result the key requires are there.",
    "partial: the direction is right, but the answer is incomplete or has a small mistake (sign, unit, missing condition).",
    "incorrect: wrong, blank, or contradicted by the key.",
    "note: what was right, and the smallest fix. No praise.",
    "recap: how they did, in two or three sentences.",
    "focus: up to three short topics to revise, taken from the weaker cards. An empty list if every card is correct.",
    "One JSON object. No markdown fence and no text outside the block. Use straight \" quotation marks in the JSON.",
    "",
    lines.join("\n\n"),
  ].join("\n");
}

const CURLY_DOUBLE = new Set(["\u201C", "\u201D", "\u201E", "\u201F", "\u2033", "\u00AB", "\u00BB"]);

/** Curly quotes used as JSON delimiters become straight quotes. Quotes inside a sentence stay. */
function straightenJson(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!CURLY_DOUBLE.has(ch)) {
      out += ch;
      continue;
    }
    let prev = i - 1;
    while (prev >= 0 && /\s/.test(text[prev])) prev -= 1;
    const before = prev >= 0 ? text[prev] : "";
    let next = i + 1;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    const after = next < text.length ? text[next] : "";
    const opens = before === "" || "{[:,".includes(before);
    const closes = after === "" || ":,}]".includes(after);
    out += opens || closes ? '"' : ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A model often writes real line breaks inside a JSON string. Escape those and try again. */
function escapeBreaksInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") continue;
    out += ch;
  }
  return out;
}

function tryParse(raw: string): unknown | null {
  const text = straightenJson(raw.trim().replace(/^\uFEFF/, ""));
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(escapeBreaksInStrings(text));
    } catch {
      return null;
    }
  }
}

function sliceObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function objectWith(text: string, key: string): Record<string, unknown> | null {
  const source = straightenJson(text);
  const fence = source.match(/<<<PAPERLIKE_(?:CARDS|REVIEW)>>>\s*([\s\S]*?)<<<END>>>/i);
  if (fence) {
    const parsed = tryParse(fence[1]);
    if (parsed && typeof parsed === "object" && parsed && key in (parsed as object)) return parsed as Record<string, unknown>;
  }
  const block = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) {
    const parsed = tryParse(block[1]);
    if (parsed && typeof parsed === "object" && parsed && key in (parsed as object)) return parsed as Record<string, unknown>;
  }
  const at = source.indexOf(`"${key}"`);
  if (at < 0) return null;
  const start = source.lastIndexOf("{", at);
  if (start < 0) return null;
  const slice = sliceObject(source, start);
  if (!slice) return null;
  const parsed = tryParse(slice);
  if (parsed && typeof parsed === "object" && parsed && key in (parsed as object)) return parsed as Record<string, unknown>;
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCards(text: string): QuizCard[] {
  const root = objectWith(text, "cards");
  const list = root?.cards;
  if (!Array.isArray(list)) return [];
  const cards: QuizCard[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const question = asText(row.question ?? row.q);
    const answer = asText(row.answer ?? row.a);
    if (!question || !answer) return;
    cards.push({
      id: asText(row.id) || String(i + 1),
      topic: asText(row.topic),
      question,
      answer,
    });
  });
  return cards;
}

function asMark(value: unknown): QuizMark {
  const raw = asText(value).toLowerCase();
  if (raw.startsWith("correct") || raw === "right") return "correct";
  if (raw.startsWith("partial") || raw.includes("incomplete") || raw.includes("small")) return "partial";
  return "incorrect";
}

export function parseReview(text: string, cards: QuizCard[]): QuizReport | null {
  const root = objectWith(text, "reviews");
  if (!root || !Array.isArray(root.reviews)) return null;
  const byId = new Map<string, QuizReview>();
  for (const item of root.reviews) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = asText(row.id);
    if (!id) continue;
    byId.set(id, { id, mark: asMark(row.mark), note: asText(row.note ?? row.comment ?? row.response) });
  }
  if (!byId.size) return null;
  const reviews = cards.map(
    (card) => byId.get(card.id) ?? { id: card.id, mark: "incorrect" as const, note: "No review came back for this card." },
  );
  const focus = Array.isArray(root.focus) ? root.focus.map(asText).filter(Boolean).slice(0, 3) : [];
  return { reviews, recap: asText(root.recap), focus };
}

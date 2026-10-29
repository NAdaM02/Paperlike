import katex from "katex";
import { NotePayload, SearchHit } from "./api";
import { blocksPlainText } from "./richtext";

export type BriefTask = "sheet" | "formulas" | "quiz" | "explain";
export type BriefDepth = "short" | "study" | "full";

export const TASKS: { id: BriefTask; label: string; hint: string }[] = [
  { id: "sheet", label: "Study sheet", hint: "The one to reread before a problem set." },
  { id: "formulas", label: "Formulas", hint: "Notation, symbols, and when each formula applies." },
  { id: "quiz", label: "Quiz", hint: "Cards you answer here, then one submit for a mark and a recap." },
  { id: "explain", label: "Explain", hint: "A reread before a problem set." },
];

export const DEPTHS: { id: BriefDepth; label: string }[] = [
  { id: "short", label: "Short" },
  { id: "study", label: "Standard" },
  { id: "full", label: "Thorough" },
];

const PRODUCE: Record<BriefTask, string> = {
  sheet: `Produce a study sheet with these sections, in this order:
1. Title
2. What this is about, in a short prose opening.
3. The ideas worth keeping, in the order they should be learned. After each major point, name the source note in brackets. Under the hardest idea, add one line headed "Why this step holds" and justify it from the notes.
4. Formulas and definitions. Keep the notes' notation, then give a compact symbol table that defines every symbol at its first use and states any conditions written in the notes.
5. Easy mistakes: identify likely bad steps, unit or sign errors, and what breaks when a stated condition is not met.
6. A short recap of about ten lines.`,
  formulas: `Produce a formula sheet:
1. Title
2. One line on what these notes cover.
3. Every formula, definition, and named quantity that appears, grouped by topic. Copy the notation exactly and define each symbol the first time it appears.
4. For each group, state when the formulas apply and any assumptions or effects the notes say were neglected. Do not supply missing standard assumptions.
5. Easy mix-ups: contrast similar formulas, signs, units, and conditions, and state what each formula is doing.`,
  quiz: `Write a closed-book quiz as study cards. The app reads only the block below, so reply with nothing else.

<<<PAPERLIKE_CARDS>>>
{"cards":[{"id":"1","topic":"short topic","question":"what the student is asked","answer":"the key, with the notes' notation"}]}
<<<END>>>

Eight to fourteen cards. Mix recall, why a step holds, and what breaks if a condition changes. question has no hint of the key. If the notes do not settle an answer, the answer says what is missing.
Write short sentences. Put a quoted sentence on its own line in *italics*, with a blank line before the question about it. Number several asks 1. 2. 3. on consecutive lines, with no blank line between them. The answer is a few short lines, not a paragraph. In the JSON, a line break is \\n and a blank line is \\n\\n.`,
  explain: `Explain the material as a reread before a problem set:
1. Tell the story of the topic in a few short paragraphs.
2. Identify the part that is doing the real work and explain why its key step holds using only the notes.
3. Read one formula from the notes term by term. Keep its notation, define every symbol at first use, and explain the move the formula is making.
4. Say what to try first on a problem of this kind, plus one unit, sign, or condition check supported by the notes.
Do not add facts that are not in the notes.`,
};

const DEPTH: Record<BriefDepth, string> = {
  short: "Keep it to a few minutes of reading. Use compact prose and only essential detail.",
  study: "Make it complete enough for one study session, with no padding or repeated points.",
  full: "Cover every relevant note and condition thoroughly, without repetition or invented filler.",
};

export function noteText(note: NotePayload): string {
  const objs = [...note.doc.canvas.objects].sort((a, b) => a.y - b.y || a.x - b.x);
  const parts: string[] = [];
  for (const o of objs) {
    if (o.type !== "text") continue;
    const t = blocksPlainText(o.blocks).trim();
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function capNote(text: string): string {
  const cap = 14000;
  if (text.length <= cap) return text.trim();
  return `${text.slice(0, cap).trimEnd()}\n\n[this note was cut here]`;
}

/** How the attached files are described to the chat. */
export const ATTACHED_LINE =
  "Each note is attached twice: as a PDF (the page as I see it, with drawings, diagrams and slides) and as Markdown (the same text with its layout and colours). PDFs that sat on the page are attached too.";

/** One-click asks about the open note. */
export const QUICK_ASKS: { id: string; label: string; text: string }[] = [
  {
    id: "explain",
    label: "Explain",
    text: "Explain this step by step from my notes only. Say why the hardest step holds, keep the notation, define each symbol the first time it appears, and finish with what I should try first on a problem.",
  },
  {
    id: "summary",
    label: "Summarize",
    text: "Make a short study sheet from this: key ideas in learning order, one line on why the hardest step holds, exact formulas with symbols defined, easy unit or sign mistakes, and a brief recap.",
  },
  {
    id: "quiz",
    label: "Quiz me",
    text: "Quiz me from these notes only, one question at a time for six questions. Mix recall with why a step holds and what breaks if a condition changes. Wait for my answer before diagnosing what I missed and asking the next question.",
  },
  {
    id: "check",
    label: "Check my work",
    text: "Check my work against the notes. Locate each bad step, unit, sign, or formula condition; explain why it fails and the smallest fix. Do not praise or repeat what is already right.",
  },
  {
    id: "formulas",
    label: "Formulas",
    text: "Group every formula in these notes by topic. Keep the notation exact, define each symbol at first use, state when it applies and what the notes neglect, and flag formulas that are easy to mix up.",
  },
];

/**
 * Prompt plus the notes' text. With `attached`, the notes travel as files, so the
 * prompt points at them instead of repeating their text.
 */
export function buildPrompt(opts: {
  task: BriefTask;
  depth: BriefDepth;
  topic: string;
  notes: { title: string; text: string }[];
  attached?: boolean;
}): { prompt: string; file: string; pastedAll: boolean } {
  const notes = opts.notes.map((n) => ({
    title: n.title.trim() || "Untitled",
    text: capNote(n.text),
  }));
  const file = notes
    .map((n) => `## ${n.title}\n\n${n.text || "(this note has no text boxes)"}`)
    .join("\n\n");
  const pastedAll = file.length <= 28000;
  const included = pastedAll
    ? file
    : `${file.slice(0, 12000).trimEnd()}\n\n[The rest is in the attached notes file. Treat that file as the source.]`;
  const topic = opts.topic.trim();
  const prompt = [
    "You are helping an aerospace engineering student turn their own lecture notes into something they can study from.",
    "Use only what is in the notes. If a number, formula, or claim is not there, say it is not in the notes. Do not invent citations, values, or standard results to fill a gap.",
    "If a diagram or slide is attached, describe only what is actually visible and tie it to the text.",
    "When something is ambiguous, say what is missing instead of guessing the standard result.",
    "Keep equations accurate. Plain text is fine, and so is LaTeX when the notes used it. Do not simplify a formula into a different one.",
    "Write in clear prose: short paragraphs, and a list only when a list is the right shape. No pep talk.",
    DEPTH[opts.depth],
    PRODUCE[opts.task],
    topic
      ? `The student asked about this topic: ${topic}. Stay on it, and skip anything in the notes that does not bear on it.`
      : "Cover the notes they included.",
    "",
    ...(opts.attached
      ? [ATTACHED_LINE, `Notes: ${notes.map((n) => n.title).join(", ")}.`]
      : ["Notes:", "", included || "(no note text was included)"]),
  ].join("\n");
  return { prompt, file: file || "(no note text)", pastedAll };
}

/**
 * The model's Markdown as readable HTML: headings, lists, bold, italics, code and
 * LaTeX in $…$, $$…$$, \(…\) and \[…\]. Text is escaped before anything is added.
 */
export function summaryHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  type Sub = { ordered: boolean; items: string[] };
  let list: { ordered: boolean; start: number; items: { text: string; sub: Sub | null }[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
    const subHtml = (s: Sub) => {
      const st = s.ordered ? "ol" : "ul";
      return `<${st}>${s.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</${st}>`;
    };
    out.push(
      `<${tag}${start}>${list.items.map((i) => `<li>${inlineHtml(i.text)}${i.sub ? subHtml(i.sub) : ""}</li>`).join("")}</${tag}>`,
    );
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith("```")) {
      const code: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("```")) code.push(lines[++i]);
      i++;
      flushPara();
      flushList();
      out.push(`<pre><code>${escHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (t.startsWith("$$") || t.startsWith("\\[")) {
      const close = t.startsWith("$$") ? "$$" : "\\]";
      let body = t.slice(2);
      while (!body.trimEnd().endsWith(close) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      body = body.trimEnd();
      if (body.endsWith(close)) body = body.slice(0, -2);
      flushPara();
      flushList();
      out.push(`<div class="brief-math">${texHtml(body, true)}</div>`);
      continue;
    }
    if (!t) {
      flushPara();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const next = j < lines.length ? lines[j].trim() : "";
      const nextItem = /^([-*•]|\d+[.)])\s+/.exec(next);
      if (list && nextItem && /\d/.test(nextItem[1]) === list.ordered) continue;
      flushList();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 5);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^([-*•]|\d+[.)])\s+(.*)$/.exec(t);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      // An indented item under a list item is a sub-point of it, not a new list.
      if (list && list.items.length && /^\s{2,}/.test(raw)) {
        const last = list.items[list.items.length - 1];
        if (!last.sub) last.sub = { ordered, items: [] };
        last.sub.items.push(item[2]);
        continue;
      }
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, start: ordered ? parseInt(item[1], 10) || 1 : 1, items: [] };
      list.items.push({ text: item[2], sub: null });
      continue;
    }
    if (list && /^\s/.test(raw)) {
      const last = list.items[list.items.length - 1];
      if (last.sub) last.sub.items[last.sub.items.length - 1] += ` ${t}`;
      else last.text += ` ${t}`;
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return out.join("");
}

const INLINE_MATH = /\$\$([^$]+)\$\$|\\\((.+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

function inlineHtml(s: string): string {
  let html = "";
  let last = 0;
  for (const m of s.matchAll(INLINE_MATH)) {
    html += formatHtml(s.slice(last, m.index));
    html += texHtml(m[1] ?? m[2] ?? m[3] ?? "", false);
    last = (m.index ?? 0) + m[0].length;
  }
  return html + formatHtml(s.slice(last));
}

function formatHtml(s: string): string {
  return escHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>");
}

function texHtml(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { throwOnError: false, displayMode: display, output: "html" });
  } catch {
    return `<code>${escHtml(tex)}</code>`;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function matchLine(text: string, topic: string): string | null {
  const q = topic.trim().toLowerCase();
  if (!q) return null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.toLowerCase().includes(q)) return t.slice(0, 140);
  }
  return null;
}

export function hitSnippet(hit: SearchHit): string {
  return hit.snippet.replace(/\s+/g, " ").trim();
}

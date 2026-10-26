import { useMemo, useState } from "react";
import { summaryHtml } from "./brief";
import { QuizCard, QuizMark, QuizReport } from "./quiz";

const MARK_LABEL: Record<QuizMark, string> = {
  correct: "Correct",
  partial: "Partially correct",
  incorrect: "Incorrect",
};

const FILTERS: { id: "all" | QuizMark; label: string }[] = [
  { id: "all", label: "All" },
  { id: "correct", label: "Correct" },
  { id: "partial", label: "Partially correct" },
  { id: "incorrect", label: "Incorrect" },
];

function Rich({ text }: { text: string }) {
  return <div className="quiz-rich md-read" dangerouslySetInnerHTML={{ __html: summaryHtml(text) }} />;
}

export function QuizDesk({
  cards,
  busy,
  report,
  onSubmit,
}: {
  cards: QuizCard[];
  busy: boolean;
  report: QuizReport | null;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState<"all" | QuizMark>("all");
  const card = cards[Math.min(index, cards.length - 1)];
  const filled = cards.filter((c) => (answers[c.id] ?? "").trim()).length;

  const counts = useMemo(() => {
    const tally = { correct: 0, partial: 0, incorrect: 0 };
    if (!report) return tally;
    for (const review of report.reviews) tally[review.mark] += 1;
    return tally;
  }, [report]);

  if (!card) return null;

  if (!report) {
    return (
      <section className="quiz-desk">
        <div className="quiz-top">
          <span>
            {index + 1} of {cards.length}
            {card.topic ? ` · ${card.topic}` : ""}
          </span>
          <span>{filled} answered</span>
        </div>
        <div className="quiz-jumps">
          {cards.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`quiz-jump${i === index ? " on" : ""}${(answers[c.id] ?? "").trim() ? " filled" : ""}`}
              onClick={() => setIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <Rich text={card.question} />
        <textarea
          className="quiz-answer"
          value={answers[card.id] ?? ""}
          placeholder="Your answer"
          onChange={(e) => setAnswers((cur) => ({ ...cur, [card.id]: e.target.value }))}
        />
        <div className="quiz-actions">
          <button className="btn" type="button" disabled={index === 0} onClick={() => setIndex((n) => Math.max(0, n - 1))}>
            Previous
          </button>
          <button
            className="btn"
            type="button"
            disabled={index >= cards.length - 1}
            onClick={() => setIndex((n) => Math.min(cards.length - 1, n + 1))}
          >
            Next
          </button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => onSubmit(answers)}>
            {busy ? "Reviewing…" : "Submit for review"}
          </button>
        </div>
      </section>
    );
  }

  const reviewOf = (id: string) => report.reviews.find((r) => r.id === id);
  const shown = cards.filter((c) => filter === "all" || reviewOf(c.id)?.mark === filter);

  return (
    <section className="quiz-desk">
      <div className="quiz-recap">
        <p className="quiz-score">
          <span className="quiz-mark correct">{counts.correct} correct</span>
          <span className="quiz-mark partial">{counts.partial} partial</span>
          <span className="quiz-mark incorrect">{counts.incorrect} incorrect</span>
        </p>
        {report.recap && <Rich text={report.recap} />}
        {report.focus.length > 0 && (
          <p className="quiz-focus">
            Revise: {report.focus.join(" · ")}
          </p>
        )}
      </div>
      <div className="quiz-filters">
        {FILTERS.map((item) => {
          const n = item.id === "all" ? cards.length : counts[item.id];
          return (
            <button
              key={item.id}
              type="button"
              className={`brief-chip${filter === item.id ? " on" : ""}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label} {n}
            </button>
          );
        })}
      </div>
      {shown.map((c) => {
        const review = reviewOf(c.id);
        const mark = review?.mark ?? "incorrect";
        return (
          <article key={c.id} className={`quiz-card mark-${mark}`}>
            <header>
              <span className={`quiz-mark ${mark}`}>{MARK_LABEL[mark]}</span>
              {c.topic && <span className="quiz-topic">{c.topic}</span>}
            </header>
            <Rich text={c.question} />
            <div className="quiz-block">
              <span>Your answer</span>
              {(answers[c.id] ?? "").trim() ? <Rich text={answers[c.id]} /> : <p className="muted">Blank</p>}
            </div>
            <div className="quiz-block">
              <span>Solution</span>
              <Rich text={c.answer} />
            </div>
            {review?.note && (
              <div className="quiz-block">
                <span>Review</span>
                <Rich text={review.note} />
              </div>
            )}
          </article>
        );
      })}
      {!shown.length && <p className="muted">Nothing in this group.</p>}
    </section>
  );
}

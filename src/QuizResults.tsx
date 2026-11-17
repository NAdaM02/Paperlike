import { useState } from "react";
import { CHAT_NAME } from "./chat";
import { QUIZ_KINDS, quizScore } from "./quiz";
import { useOpenQuizNote } from "./quizHistory";
import { QuizDesk } from "./QuizDesk";
import { Modal } from "./ui";

/** Study → Review results: the marked quizzes kept on the open note, newest first. */
export function QuizResultsDialog({ onClose }: { onClose: () => void }) {
  const note = useOpenQuizNote();
  const list = [...(note?.history ?? [])].reverse();
  const [openId, setOpenId] = useState<string | null>(list[0]?.id ?? null);
  const rec = list.find((r) => r.id === openId) ?? list[0];
  return (
    <Modal title={`Quiz results${note ? ` · ${note.title}` : ""}`} wide className="quiz-history" onClose={onClose}>
      {!list.length ? (
        <p className="muted">No marked quizzes on this note yet. Study → Quiz me makes one; it is kept here once it is marked.</p>
      ) : (
        <div className="quiz-history-body">
          <div className="quiz-history-list">
            {list.map((r) => {
              const sc = quizScore(r.report);
              const when = new Date(r.at);
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`quiz-history-row${r.id === rec?.id ? " on" : ""}`}
                  onClick={() => setOpenId(r.id)}
                >
                  <strong>{sc.pct}%</strong>
                  <span>
                    {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                    {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · {r.count} cards ·{" "}
                    {QUIZ_KINDS.find((k) => k.id === r.kind)?.label ?? "Mixed"}
                  </span>
                  <small>
                    {sc.correct} correct · {sc.partial} partial · {sc.incorrect} wrong · {CHAT_NAME[r.host] ?? r.host}
                    {r.scope === "area" ? " · marked area" : r.notes && r.notes.length > 1 ? ` · ${r.notes.length} notes` : ""}
                    {r.topic ? ` · ${r.topic}` : ""}
                  </small>
                </button>
              );
            })}
          </div>
          {rec && (
            <div className="quiz-history-view">
              <div className="quiz-history-actions">
                <button className="btn" type="button" onClick={() => note?.write(null, rec.id)}>
                  Remove from history
                </button>
              </div>
              <QuizDesk key={rec.id} cards={rec.cards} busy={false} report={rec.report} initialAnswers={rec.answers} onSubmit={() => {}} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

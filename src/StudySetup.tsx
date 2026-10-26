import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, Settings, StudyCreateSummary } from "./api";
import { messages } from "./copy/messages";
import { Modal } from "./ui";

const PRESET_ID = "tum-aerospace";

function underRoot(root: string, path: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = norm(path);
  const prefix = base.toLowerCase();
  const probe = full.toLowerCase();
  if (probe === prefix) return full;
  if (probe.startsWith(prefix + "/")) return full.slice(base.length + 1);
  return path;
}

export function StudySetup({
  settings,
  onChange,
  onClose,
  onOpenHome,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onOpenHome: () => void;
}) {
  const [root, setRoot] = useState(settings.study_root ?? "");
  const [thumb, setThumb] = useState<string | null>(null);
  const [createFolders, setCreateFolders] = useState(true);
  const [moodle, setMoodle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<StudyCreateSummary | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .studyPresetInfo(PRESET_ID)
      .then((info) => {
        if (!alive) return;
        setThumb(info.thumbnail_data_url);
        setRoot((cur) => (cur.trim() ? cur : info.default_root));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const sayNo = async () => {
    const next = { ...settings, study_prompted: true };
    onChange(next);
    try {
      await api.saveSettings(next);
    } catch (e) {
      setError(String(e));
      return;
    }
    onClose();
  };

  const sayYes = async () => {
    setBusy(true);
    setError("");
    try {
      const summary = await api.createStudyPreset(PRESET_ID, root.trim(), createFolders);
      const next: Settings = {
        ...settings,
        study_prompted: true,
        moodle_enabled: moodle,
        study_preset: createFolders ? PRESET_ID : (settings.study_preset ?? null),
        study_root: createFolders ? summary.root : (settings.study_root ?? null),
      };
      await api.saveSettings(next);
      onChange(next);
      setResult(summary);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const picked = await openDialog({ directory: true, title: messages.studyLocation });
    if (typeof picked === "string" && picked) setRoot(picked);
  };

  if (result) {
    const notebooks = result.created_notebooks.map((p) => underRoot(result.root, p));
    const folders = result.created_folders.map((p) => underRoot(result.root, p));
    return (
      <Modal
        title={messages.studyCreatedIn(result.root)}
        onClose={onOpenHome}
        actions={
          <button className="btn primary" type="button" onClick={onOpenHome}>
            {messages.studyOpenHome}
          </button>
        }
      >
        <div className="study-card">
          {notebooks.length === 0 && folders.length === 0 && <p className="muted">{messages.studyNone}</p>}
          {notebooks.length > 0 && (
            <div>
              <strong>{messages.studyNotebooksHeading}</strong>
              <ul className="study-list">
                {notebooks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {folders.length > 0 && (
            <div>
              <strong>{messages.studyFoldersHeading}</strong>
              <ul className="study-list">
                {folders.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted">{messages.studyKept}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={messages.studyTitle}
      onClose={busy ? () => {} : onClose}
      actions={
        <>
          <button className="btn" type="button" disabled={busy} onClick={onClose}>
            {messages.studyLater}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void sayNo()}>
            {messages.studyNo}
          </button>
          <button className="btn primary" type="button" disabled={busy || !root.trim()} onClick={() => void sayYes()}>
            {busy ? messages.studyWorking : messages.studyYes}
          </button>
        </>
      }
    >
      <div className="study-card">
        {thumb ? (
          <img className="study-thumb" src={thumb} alt="" />
        ) : (
          <div className="study-thumb placeholder">
          <span>{messages.studyThumbPlaceholder}</span>
          <small>{messages.studyThumbHint}</small>
        </div>
        )}
        <p className="muted">{messages.studyIntro}</p>
        <div className="field">
          <span>{messages.studyLocation}</span>
          <div className="study-path">
            <input type="text" value={root} spellCheck={false} onChange={(e) => setRoot(e.target.value)} />
            <button className="btn" type="button" onClick={() => void pick()}>
              {messages.studyChange}
            </button>
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={createFolders} onChange={(e) => setCreateFolders(e.target.checked)} />
          {messages.studyCreateFolders}
        </label>
        <label className="check-row">
          <input type="checkbox" checked={moodle} onChange={(e) => setMoodle(e.target.checked)} />
          {messages.studyMoodle}
        </label>
        {error && <p className="study-error">{error}</p>}
      </div>
    </Modal>
  );
}

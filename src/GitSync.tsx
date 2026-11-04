/* Sync github: status store, settings block, status chip and conflict card — specs/ui-flows.md */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, GitSyncCheck, GitSyncConflict, GitSyncStatus, Settings } from "./api";
import { messages } from "./copy/messages";
import { Modal } from "./ui";

const WHEN = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? WHEN.format(d) : "";
}

const OFF: GitSyncStatus = { state: "off", code: "", detail: "", at: null, conflicts: [] };
let current: GitSyncStatus = OFF;
let started = false;
let heard = false;
const subs = new Set<() => void>();

function publish(next: GitSyncStatus) {
  current = next;
  subs.forEach((f) => f());
}

function start() {
  if (started) return;
  started = true;
  void listen<GitSyncStatus>("git-sync", (e) => {
    heard = true;
    publish(e.payload);
  });
  void api
    .gitSyncStatus()
    .then((s) => {
      if (!heard) publish(s);
    })
    .catch(() => {});
}

/** Re-read the status after the setting changed. */
export function refreshGitSync() {
  return api
    .gitSyncStatus()
    .then(publish)
    .catch(() => {});
}

export function useGitSync(): GitSyncStatus {
  start();
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}

export function syncErrorText(code: string): string {
  return messages.gitSyncErrors[code as keyof typeof messages.gitSyncErrors] ?? messages.gitSyncErrors.other;
}

/** One last sync while closing. The window hides first; a stuck remote never holds the exit long. */
export async function syncBeforeExit(hide: () => Promise<void>) {
  if (current.state === "off") return;
  await hide().catch(() => {});
  await Promise.race([
    api.gitSyncOnExit().catch(() => null),
    new Promise((r) => window.setTimeout(r, 30_000)),
  ]);
}

function statusLine(s: GitSyncStatus): string {
  if (s.state === "syncing") return messages.gitSyncing;
  if (s.state === "conflict") return messages.gitSyncConflictLine(s.conflicts.length);
  if (s.at) return messages.gitSyncLast(when(s.at));
  return messages.gitSyncNever;
}

/* ── Settings › Files ── */

export function GitSyncSettings({ settings, onSave }: { settings: Settings; onSave: (next: Settings) => Promise<void> }) {
  const status = useGitSync();
  const [check, setCheck] = useState<GitSyncCheck | null>(null);
  const dir = settings.git_sync_dir ?? "";
  useEffect(() => {
    if (!dir) {
      setCheck(null);
      return;
    }
    let live = true;
    void api
      .gitSyncCheck(dir)
      .then((c) => live && setCheck(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dir]);
  const pick = async (): Promise<string | null> => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: messages.gitSyncPickTitle,
      defaultPath: dir || settings.study_root || undefined,
    }).catch(() => null);
    return typeof picked === "string" ? picked : null;
  };
  const toggle = async (on: boolean) => {
    let folder = dir;
    if (on && !folder) {
      const p = await pick();
      if (!p) return;
      folder = p;
    }
    await onSave({ ...settings, git_sync: on, git_sync_dir: folder || null });
    void refreshGitSync();
  };
  const change = async () => {
    const p = await pick();
    if (!p) return;
    await onSave({ ...settings, git_sync_dir: p });
    void refreshGitSync();
  };
  const problem = check?.code ? syncErrorText(check.code) : status.state === "error" ? syncErrorText(status.code) : "";
  return (
    <>
      <label className="switch">
        <input type="checkbox" checked={!!settings.git_sync} onChange={(e) => void toggle(e.target.checked)} />
        <span className="track" />
        <span>
          {messages.gitSync}
          <span className="settings-hint">{messages.gitSyncHint}</span>
        </span>
      </label>
      {settings.git_sync && (
        <div className="git-sync-box">
          <div className="git-sync-folder">
            <span className="git-sync-path" title={dir}>
              {dir || messages.gitSyncNoFolder}
            </span>
            <button className="btn outline" type="button" onClick={() => void change()}>
              {dir ? messages.gitSyncChange : messages.gitSyncPick}
            </button>
          </div>
          {check?.remote && !check.code && <span className="settings-hint">{messages.gitSyncRemote(check.remote)}</span>}
          <div className="git-sync-status">
            <span
              className={`settings-hint ${problem ? "git-sync-problem" : ""}`}
              title={(check?.code ? check.detail : status.detail) || undefined}
            >
              {problem || statusLine(status)}
            </span>
            <button
              className="btn outline"
              type="button"
              disabled={!dir || !!check?.code || status.state === "syncing"}
              onClick={() => void api.gitSyncRun().catch(() => {})}
            >
              {messages.gitSyncNow}
            </button>
          </div>
          <span className="settings-hint">{messages.gitSyncWhen}</span>
        </div>
      )}
    </>
  );
}

/* ── status chip + conflict card ── */

const SHOW_SYNCING_AFTER = 600;
const SHOW_DONE_FOR = 2200;

export function GitSyncDock({ onOpenSettings, onOpenNote }: { onOpenSettings: () => void; onOpenNote: (path: string) => void }) {
  const status = useGitSync();
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState<GitSyncStatus["state"]>("idle");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [card, setCard] = useState(false);
  const shownSyncing = useRef(false);
  const seenConflicts = useRef("");

  useEffect(() => {
    const s = status.state;
    if (s === "syncing") {
      const t = window.setTimeout(() => {
        shownSyncing.current = true;
        setLabel("syncing");
        setVisible(true);
      }, SHOW_SYNCING_AFTER);
      return () => window.clearTimeout(t);
    }
    if (s === "ok") {
      if (!shownSyncing.current) {
        setVisible(false);
        return;
      }
      shownSyncing.current = false;
      setLabel("ok");
      setVisible(true);
      const t = window.setTimeout(() => setVisible(false), SHOW_DONE_FOR);
      return () => window.clearTimeout(t);
    }
    shownSyncing.current = false;
    if (s === "error" || s === "conflict") {
      setLabel(s);
      setVisible(true);
      return;
    }
    setVisible(false);
  }, [status]);

  const conflictKey = status.conflicts.map((c) => c.name).join("\n");
  useEffect(() => {
    if (status.state !== "conflict") {
      setCard(false);
      seenConflicts.current = "";
      return;
    }
    if (conflictKey && conflictKey !== seenConflicts.current) {
      // Open once for a new set of conflicts; closing it keeps the chip.
      if (!seenConflicts.current) setCard(true);
      seenConflicts.current = conflictKey;
    }
  }, [status.state, conflictKey]);

  const errorKey = status.state === "error" ? `${status.code}|${status.detail}` : null;
  const hidden = label === "error" && errorKey !== null && dismissed === errorKey;
  const text =
    label === "syncing"
      ? messages.gitSyncChipSyncing
      : label === "ok"
        ? messages.gitSyncChipDone
        : label === "conflict"
          ? messages.gitSyncChipConflict
          : messages.gitSyncChipError;
  const tip = label === "error" ? [syncErrorText(status.code), status.detail].filter(Boolean).join("\n") : undefined;

  return (
    <>
      <div className={`sync-chip ${visible && !hidden ? "show" : ""}`} data-state={label} role="status">
        <button
          type="button"
          className="sync-chip-body"
          title={tip}
          tabIndex={visible && !hidden ? 0 : -1}
          onClick={() => {
            if (label === "conflict") setCard(true);
            else if (label === "error") onOpenSettings();
          }}
        >
          <span className="sync-chip-dot" />
          {text}
        </button>
        {label === "error" && (
          <button
            type="button"
            className="sync-chip-x"
            aria-label={messages.gitSyncChipHide}
            title={messages.gitSyncChipHide}
            tabIndex={visible && !hidden ? 0 : -1}
            onClick={() => setDismissed(errorKey)}
          >
            ×
          </button>
        )}
      </div>
      {card && status.state === "conflict" && (
        <ConflictCard
          conflicts={status.conflicts}
          onClose={() => setCard(false)}
          onOpenNote={(p) => {
            setCard(false);
            onOpenNote(p);
          }}
        />
      )}
    </>
  );
}

function ConflictCard({
  conflicts,
  onClose,
  onOpenNote,
}: {
  conflicts: GitSyncConflict[];
  onClose: () => void;
  onOpenNote: (path: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const resolve = async (c: GitSyncConflict, keep: "mine" | "theirs") => {
    if (busy) return;
    setBusy(c.name);
    setError("");
    try {
      await api.gitSyncResolve(c.path, keep);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal
      title={messages.gitSyncConflictTitle}
      onClose={onClose}
      actions={
        <button className="btn" type="button" onClick={onClose}>
          {messages.gitSyncConflictLater}
        </button>
      }
    >
      <p className="sync-conflict-intro">{messages.gitSyncConflictIntro}</p>
      <div className="sync-conflicts">
        {conflicts.map((c) => {
          const parts = c.name.split("/");
          const file = parts.pop() ?? c.name;
          const title = c.is_note ? file.replace(/\.note$/i, "") : file;
          return (
            <div key={c.name} className="sync-conflict">
              <div className="sync-conflict-name">
                {title}
                {parts.length > 0 && <span className="sync-conflict-where">{parts.join(" / ")}</span>}
              </div>
              <div className="sync-conflict-times">
                {messages.gitSyncConflictTimes(when(c.mine), when(c.theirs))}
              </div>
              <div className="sync-conflict-actions">
                <button className="btn outline" type="button" disabled={!!busy} onClick={() => void resolve(c, "mine")}>
                  {messages.gitSyncKeepMine}
                </button>
                <button className="btn outline" type="button" disabled={!!busy} onClick={() => void resolve(c, "theirs")}>
                  {messages.gitSyncKeepTheirs}
                </button>
                {c.is_note && (
                  <button className="btn" type="button" disabled={!!busy} onClick={() => onOpenNote(c.path)}>
                    {messages.gitSyncOpenNote}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="git-sync-problem sync-conflict-error">{error}</p>}
    </Modal>
  );
}

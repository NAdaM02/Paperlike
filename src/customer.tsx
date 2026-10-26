import { FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAuto, disable as disableAuto } from "@tauri-apps/plugin-autostart";
import QRCode from "qrcode";
import { api, Settings } from "./api";
import { messages, tourStepsFor, TourUntil } from "./copy/messages";
import { IcClose, IcMix, IcMoon, IcSun } from "./icons";
import { StudySetup } from "./StudySetup";
import { Modal } from "./ui";

export const CUSTOMER = false;

export type LicenseStatus = {
  kind: string;
  days_left: number | null;
  secs_left: number | null;
  read_only: boolean;
  transfers_left: number | null;
};

/** Counts down from the server's remaining seconds. Whole days stay put; the last day ticks. */
function useLicenseSecs(secs: number | null | undefined): number | null {
  const base = useRef({ secs: secs ?? 0, at: Date.now() });
  const [left, setLeft] = useState<number | null>(secs ?? null);
  useEffect(() => {
    if (secs == null) {
      setLeft(null);
      return;
    }
    base.current = { secs, at: Date.now() };
    setLeft(secs);
    if (secs >= 86_400) return;
    const id = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - base.current.at) / 1000);
      setLeft(Math.max(0, base.current.secs - elapsed));
    }, 1000);
    return () => window.clearInterval(id);
  }, [secs]);
  return left;
}

function licenseQuiet(status: LicenseStatus): boolean {
  return status.kind === "activated" && (status.secs_left == null || status.secs_left >= 60 * 86_400);
}

type Thread = {
  id: string;
  body: string;
  created: number;
  unseen?: boolean;
  replies: { body: string; at: number; author?: string }[];
};

type SettingsTab = "general" | "study" | "drawing" | "files" | "about" | "license";

const SETTINGS_TAB_CSS = `
.pl-settings-frame { container-type: inline-size; container-name: pl-settings; min-width: 0; max-width: 100%; }
.pl-settings-shell { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
.pl-settings-nav { display: flex; flex-direction: column; gap: 2px; flex: 1 1 148px; max-width: 168px; min-width: 0; }
.pl-settings-nav .btn { width: 100%; justify-content: flex-start; }
.pl-settings-panel { flex: 1 1 240px; min-width: min(100%, 240px); padding-left: 14px; border-left: 1px solid var(--border); }
.pl-settings-panel .btn { white-space: normal; max-width: 100%; }
.pl-settings-panel .seg { flex-wrap: wrap; max-width: 100%; }
@container pl-settings (max-width: 400px) {
  .pl-settings-nav { flex-direction: row; flex-wrap: wrap; flex-basis: 100%; max-width: none; }
  .pl-settings-nav .btn { width: auto; }
  .pl-settings-panel { flex-basis: 100%; padding-left: 0; border-left: none; padding-top: 10px; border-top: 1px solid var(--border); }
}
`;


export function SettingsDialog({
  settings,
  onChange,
  onClose,
  license,
  onReplayTour,
  onToast,
  onStudyHome,
  initialTab,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  license: LicenseStatus | null;
  onReplayTour?: () => void;
  onToast: (msg: string) => void;
  onStudyHome: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");
  const [wipe, setWipe] = useState(false);
  const [assocBusy, setAssocBusy] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [studyOpen, setStudyOpen] = useState(false);
  const [key, setKey] = useState("");
  const [moveKey, setMoveKey] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateHistory, setUpdateHistory] = useState<{ version: string; notes: string; date: string }[]>([]);
  const [moodleSaved, setMoodleSaved] = useState(false);
  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
  }, []);
  useEffect(() => {
    if (tab !== "about") return;
    void invoke<{ version: string; notes: string; date: string }[]>("update_note_history")
      .then(setUpdateHistory)
      .catch(() => setUpdateHistory([]));
  }, [tab]);
  useEffect(() => {
    if (tab !== "study") return;
    void invoke<boolean>("moodle_login_saved")
      .then(setMoodleSaved)
      .catch(() => setMoodleSaved(false));
  }, [tab]);
  const save = async (next: Settings) => {
    onChange(next);
    await api.saveSettings(next);
    window.dispatchEvent(new Event("paperlike-settings-changed"));
    if (next.autostart) await enableAuto().catch(() => {});
    else await disableAuto().catch(() => {});
  };
  const setTheme = async (theme: string) => {
    document.documentElement.dataset.theme = ["dark", "mix"].includes(theme) ? theme : "bright";
    await save({ ...settings, theme });
  };
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: messages.settingsTabGeneral },
    { id: "drawing", label: messages.settingsTabDrawing },
    { id: "study", label: messages.settingsStudy },
    { id: "files", label: messages.settingsTabFiles },
    ...(CUSTOMER ? [{ id: "license" as const, label: messages.settingsTabLicense }] : []),
    { id: "about", label: messages.settingsTabAbout },
  ];
  const sectionRest = { borderBottom: "none", paddingBottom: 0 };
  return (
    <>
    <Modal title={messages.settingsTitle} onClose={onClose}>
      <div className="pl-settings-frame">
        <style>{SETTINGS_TAB_CSS}</style>
        <div className="pl-settings-shell">
          <div className="pl-settings-nav">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`btn ${tab === item.id ? "active" : ""}`}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="pl-settings-panel settings-list">
            {tab === "general" && (
              <>
                <section className="settings-section">
                  <h3>{messages.settingsAppearance}</h3>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <span>{messages.settingsTheme}</span>
                    <div className="seg" role="group" aria-label={messages.settingsTheme}>
                      {(
                        [
                          ["bright", <IcSun key="s" size={15} />, messages.settingsThemeBright, messages.settingsThemeBright],
                          ["mix", <IcMix key="m" size={15} />, messages.settingsThemeMix, messages.settingsThemeMixHint],
                          ["dark", <IcMoon key="d" size={15} />, messages.settingsThemeDark, messages.settingsThemeDark],
                        ] as [string, ReactNode, string, string][]
                      ).map(([value, icon, label, title]) => (
                        <button
                          key={value}
                          type="button"
                          className={`btn ${settings.theme === value ? "active" : ""}`}
                          title={title}
                          onClick={() => void setTheme(value)}
                        >
                          {icon}
                          <span className="small">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
                <section className="settings-section" style={sectionRest}>
                  <h3>{messages.settingsApp}</h3>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.autostart}
                      onChange={(e) => void save({ ...settings, autostart: e.target.checked })}
                    />
                    <span className="track" />
                    <span>
                      {messages.autostart}
                      <span className="settings-hint">{messages.autostartHint}</span>
                    </span>
                  </label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.tray}
                      onChange={(e) => void save({ ...settings, tray: e.target.checked })}
                    />
                    <span className="track" />
                    <span>
                      {messages.tray}
                      <span className="settings-hint">{messages.trayHint}</span>
                    </span>
                  </label>
                  {CUSTOMER && onReplayTour && (
                    <button className="btn" type="button" onClick={onReplayTour}>
                      {messages.replayTour}
                    </button>
                  )}
                </section>
              </>
            )}
            {tab === "study" && (
              <section className="settings-section" style={sectionRest}>
                <h3>{messages.settingsStudy}</h3>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!settings.moodle_enabled}
                    onChange={(e) => void save({ ...settings, moodle_enabled: e.target.checked })}
                  />
                  <span className="track" />
                  <span>
                    {messages.studyMoodleSwitch}
                    <span className="settings-hint">{messages.studyMoodleHint}</span>
                  </span>
                </label>
                <button className="btn" type="button" onClick={() => setStudyOpen(true)}>
                  {messages.studyCreateButton}
                </button>
                {moodleSaved ? (
                  <>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void invoke("moodle_clear_login")
                          .then(() => {
                            setMoodleSaved(false);
                            onToast(messages.moodleForgetDone);
                          })
                          .catch((err) => onToast(String(err)));
                      }}
                    >
                      {messages.moodleForgetLogin}
                    </button>
                    <p className="settings-hint">{messages.moodleForgetHint}</p>
                  </>
                ) : (
                  <p className="settings-hint">{messages.moodleNoSavedLogin}</p>
                )}
              </section>
            )}
            {tab === "drawing" && (
              <section className="settings-section" style={sectionRest}>
                <h3>{messages.settingsDrawing}</h3>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.pen_enabled !== false}
                    onChange={(e) => void save({ ...settings, pen_enabled: e.target.checked })}
                  />
                  <span className="track" />
                  <span>
                    {messages.penEnabled}
                    <span className="settings-hint">{messages.penEnabledHint}</span>
                  </span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.pen_always_draws !== false}
                    onChange={(e) => void save({ ...settings, pen_always_draws: e.target.checked })}
                  />
                  <span className="track" />
                  <span>
                    {messages.penAlwaysDraws}
                    <span className="settings-hint">{messages.penAlwaysDrawsHint}</span>
                  </span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.pen_pressure !== false}
                    onChange={(e) => void save({ ...settings, pen_pressure: e.target.checked })}
                  />
                  <span className="track" />
                  <span>
                    {messages.penPressure}
                    <span className="settings-hint">{messages.penPressureHint}</span>
                  </span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.palm_rejection !== false}
                    onChange={(e) => void save({ ...settings, palm_rejection: e.target.checked })}
                  />
                  <span className="track" />
                  <span>
                    {messages.palmRejection}
                    <span className="settings-hint">{messages.palmRejectionHint}</span>
                  </span>
                </label>
              </section>
            )}
            {tab === "files" && (
              <section className="settings-section" style={sectionRest}>
                <h3>{messages.settingsFiles}</h3>
                <button
                  className="btn"
                  type="button"
                  disabled={assocBusy}
                  onClick={() => {
                    if (assocBusy) return;
                    setAssocBusy(true);
                    void invoke("register_file_association")
                      .then(() => onToast(messages.noteAssocDone))
                      .catch((err) => onToast(String(err)))
                      .finally(() => setAssocBusy(false));
                  }}
                >
                  {messages.noteAssoc}
                </button>
                <p className="settings-hint">{messages.noteAssocHint}</p>
              </section>
            )}
            {tab === "license" && CUSTOMER && license && (
              <>
                <section className="settings-section">
                  <h3>{messages.settingsLicense}</h3>
                  {license.kind === "activated" ? (
                    <ActivatedLine status={license} />
                  ) : (
                    <div className="muted">
                      {license.kind === "ended" ? messages.trialEnded : messages.trialDays(license.days_left ?? 0)}
                    </div>
                  )}
                </section>
                <section className="settings-section" style={sectionRest}>
                  <PricePitch quiet={licenseQuiet(license)} />
                  {license.kind === "activated" ? (
                    <form
                      className="transfer-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setMoveNote("");
                        try {
                          await api.licenseTransfer(moveKey.trim());
                          setMoveKey("");
                          setMoveNote(messages.transferDone);
                          window.dispatchEvent(new Event("paperlike-license"));
                        } catch (err) {
                          setMoveNote(String(err));
                        }
                      }}
                    >
                      <div>{messages.transfer}</div>
                      <p className="settings-hint">{messages.transferHint}</p>
                      {license.transfers_left != null && <p className="settings-hint">{messages.transferLeft(license.transfers_left)}</p>}
                      <input value={moveKey} onChange={(e) => setMoveKey(e.target.value)} placeholder={messages.keyPlaceholder} />
                      <button className="btn" type="submit" disabled={!moveKey.trim()}>{messages.transferGo}</button>
                      {moveNote && <p className="settings-hint">{moveNote}</p>}
                    </form>
                  ) : (
                    <KeyCard
                      status={license}
                      keyValue={key}
                      onKey={setKey}
                      onActivated={() => window.dispatchEvent(new Event("paperlike-license"))}
                    />
                  )}
                </section>
              </>
            )}
            {tab === "about" && (
              <>
                <section className="settings-section">
                  <h3>{messages.settingsAboutApp}</h3>
                  <p className="settings-hint" style={{ marginTop: 0 }}>
                    {appVersion ? messages.settingsVersion(appVersion) : messages.settingsVersionLoading}
                  </p>
                  {updateHistory.filter((item) => Number(String(item.version).split(".")[0]) >= 1 && item.notes.trim()).length ? (
                    <>
                      <h3 className="update-history-title">{messages.updateHistoryTitle}</h3>
                      <div className="update-history">
                        {updateHistory.filter((item) => Number(String(item.version).split(".")[0]) >= 1 && item.notes.trim()).map((item) => (
                          <article key={item.version}>
                            <h4>{messages.settingsVersion(item.version)}</h4>
                            <p>{item.notes.trim()}</p>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : null}
                </section>
                <section className="settings-section settings-danger">
                  <h3>{messages.settingsDanger}</h3>
                  <button className="btn" type="button" onClick={() => setConfirmUninstall(true)}>
                    {messages.uninstall}
                  </button>
                </section>
                {confirmUninstall && (
                  <div className="uninstall-box">
                    <strong>{messages.uninstallTitle}</strong>
                    <label className="switch">
                      <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
                      {messages.uninstallWipe}
                    </label>
                    {wipe && <p className="warn-text">{messages.uninstallWarn}</p>}
                    <div className="row">
                      <button className="btn outline" type="button" onClick={() => setConfirmUninstall(false)}>
                        {messages.uninstallCancel}
                      </button>
                      <button
                        className="btn danger-fill"
                        type="button"
                        onClick={async () => {
                          const kind = await api.uninstallApp(wipe);
                          if (kind === "portable") window.alert(messages.personalUninstallNote);
                        }}
                      >
                        {messages.uninstallGo}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
    {studyOpen && (
      <StudySetup
        settings={settings}
        onChange={onChange}
        onClose={() => setStudyOpen(false)}
        onOpenHome={() => {
          setStudyOpen(false);
          onStudyHome();
        }}
      />
    )}
    </>
  );
}

export function KeyCard({
  status,
  keyValue,
  onKey,
  onActivated,
}: {
  status: LicenseStatus;
  keyValue: string;
  onKey: (v: string) => void;
  onActivated: () => void;
}) {
  const [qr, setQr] = useState("");
  const [keyError, setKeyError] = useState("");
  useEffect(() => {
    QRCode.toDataURL(messages.whatsappUrl, { margin: 1, width: 160 }).then(setQr).catch(() => {});
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setKeyError("");
    try {
      await api.licenseRefresh(keyValue.trim() || null);
      onActivated();
    } catch (err) {
      setKeyError(String(err));
    }
  };
  const openWhatsapp = () => {
    void invoke("moodle_open_external", { url: messages.whatsappUrl }).catch(() => {});
  };
  return (
    <form className="key-card" onSubmit={submit}>
      {status.read_only && <BrokenText text={messages.readOnly} className="key-note" />}
      <input
        value={keyValue}
        onChange={(e) => {
          onKey(e.target.value);
          setKeyError("");
        }}
        placeholder={messages.keyPlaceholder}
      />
      <button className="btn primary" type="submit">
        {messages.activate}
      </button>
      {keyError && <p className="settings-hint key-error">{keyError}</p>}
      <button className="wa-open" type="button" onClick={openWhatsapp}>
        {messages.whatsappHint}
      </button>
      {qr && <img className="qr" src={qr} alt="" />}
    </form>
  );
}

function linesOf(text: string): string[] {
  return text
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Discord marks: *italic* or _italic_, **bold**, ***both***, __underline__. */
function discordLine(line: string, keyBase: string): ReactNode[] {
  const re = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|___([^_]+)___|__([^_]+)__|_([^_]+)_/g;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    if (match.index > last) out.push(line.slice(last, match.index));
    const both = match[1] ?? match[4];
    const bold = match[2];
    const underline = match[5];
    const italic = match[3] ?? match[6];
    const key = `${keyBase}-${n}`;
    if (both != null) out.push(<strong key={key}><em>{both}</em></strong>);
    else if (bold != null) out.push(<strong key={key}>{bold}</strong>);
    else if (underline != null) out.push(<u key={key}>{underline}</u>);
    else if (italic != null) out.push(<em key={key}>{italic}</em>);
    last = match.index + match[0].length;
    n += 1;
  }
  if (last < line.length) out.push(line.slice(last));
  if (!out.length) out.push(line);
  return out;
}

function BrokenText({ text, className, discord = false }: { text: string; className: string; discord?: boolean }) {
  return (
    <div className={className}>
      {linesOf(text).map((line, i) => (
        <p key={i}>{discord ? discordLine(line, String(i)) : line}</p>
      ))}
    </div>
  );
}

function PricePitch({ quiet = false }: { quiet?: boolean }) {
  const [text, setText] = useState(messages.priceDefault);
  useEffect(() => {
    api.licensePrice().then((t) => { if (t.trim()) setText(t); }).catch(() => {});
  }, []);
  return <BrokenText text={text} className={quiet ? "price-pitch quiet" : "price-pitch"} discord />;
}

export function TrialMeter({ days, onOpen }: { days: number; onOpen: () => void }) {
  const passed = Math.min(1, Math.max(0, (30 - days) / 30));
  return (
    <span className="trial-meter" style={{ fontWeight: 500 + Math.round(passed * 250), opacity: 0.62 + passed * 0.38 }}>
      <button type="button" className="trial-meter-days" onClick={onOpen}>
        {messages.trialHome(days)}
      </button>
      <button type="button" className="trial-meter-info" aria-label="About the trial">
        i
        <span className="trial-meter-tip">
          {messages.trialInfo.split("still").map((part, i, all) => (
            <span key={i}>
              {part}
              {i < all.length - 1 && <strong>still</strong>}
            </span>
          ))}
        </span>
      </button>
    </span>
  );
}

function ActivatedLine({ status }: { status: LicenseStatus }) {
  const live = useLicenseSecs(status.secs_left);
  const text = status.secs_left == null
    ? messages.licensePermanent
    : messages.licenseCorner(live ?? status.secs_left);
  return <div className={`activated${licenseQuiet(status) ? " quiet" : ""}`}>{text}</div>;
}

export function TrialCorner({ status, onOpen }: { status: LicenseStatus; onOpen: () => void }) {
  const ended = status.kind === "ended" || status.read_only;
  const licensed = status.kind === "activated" && !ended;
  const live = useLicenseSecs(licensed ? status.secs_left : null);
  const label = licensed
    ? status.secs_left == null
      ? messages.licensePermanent
      : messages.licenseCorner(live ?? status.secs_left)
    : ended
      ? messages.expiredCorner
      : messages.trialDays(status.days_left ?? 0);
  return (
    <button className={`trial-corner${ended ? " expired" : ""}${licensed && licenseQuiet(status) ? " quiet" : ""}`} data-tour="trial-corner" onClick={onOpen}>
      {label}
    </button>
  );
}

export function FeedbackDock({ showButton = true, onCloseThread }: { showButton?: boolean; onCloseThread?: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState("");
  const [popup, setPopup] = useState<Thread | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api.feedbackList().then((data) => {
      const list = (data.threads ?? []) as Thread[];
      setThreads(list);
      const unseen = list.find((t) => t.unseen && t.replies?.length);
      setPopup(unseen ?? null);
    }).catch(() => {});
  useEffect(() => {
    load();
    const id = window.setInterval(load, 8000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  const openThread = async (t: Thread) => {
    setActiveId(t.id);
    setReply("");
    setReplyError("");
    setPopup(null);
    setOpen(true);
    await api.feedbackSeen(t.id).catch(() => {});
    onCloseThread?.();
    load();
  };
  return (
    <>
      {showButton && (
        <button className="feedback-corner" onClick={() => { setOpen(true); setActiveId(null); }}>
          {messages.feedbackButton}
        </button>
      )}
      {popup && (
        <button className="reply-card" onClick={() => void openThread(popup)}>
          <span>{popup.replies[popup.replies.length - 1]?.body}</span>
          <span
            className="x"
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              void api.feedbackSeen(popup.id);
              setPopup(null);
            }}
          >
            <IcClose size={12} />
          </span>
        </button>
      )}
      {open && (
        <Modal wide title={messages.feedbackButton} onClose={() => { setOpen(false); setActiveId(null); }}>
          <p className="guide">{messages.feedbackGuide}</p>
          <form
            className="feedback-compose"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!body.trim()) return;
              setError("");
              try {
                await api.feedbackSend(body.trim());
              } catch {
                setError(messages.feedbackFailed);
                return;
              }
              setBody("");
              load();
            }}
          >
            <textarea className="feedback-box" value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
            {error && <p className="warn-text">{error}</p>}
            <button className="btn primary" type="submit">{messages.feedbackSend}</button>
          </form>
          <div className="past">
            <div className="muted">{messages.feedbackPast}</div>
            {threads.length === 0 && <div className="muted">{messages.feedbackEmpty}</div>}
            {threads.map((t) => (
              <div
                key={t.id}
                className={`chat-thread ${activeId === t.id ? "open" : ""} ${t.unseen ? "unseen" : ""}`}
              >
                <button type="button" className="chat-thread-hit" onClick={() => void openThread(t)}>
                  <span className="who">{messages.feedbackYou}</span>
                  <span>{t.body}</span>
                  {t.replies?.map((r, i) => (
                    <span key={i} className="chat-reply">
                      <span className="who">{r.author === "user" ? messages.feedbackYou : messages.feedbackReply}</span>
                      {r.body}
                    </span>
                  ))}
                </button>
                {activeId === t.id && (
                  <form
                    className="chat-follow"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!reply.trim()) return;
                      setReplyError("");
                      try {
                        await api.feedbackReply(t.id, reply.trim());
                      } catch {
                        setReplyError(messages.feedbackFailed);
                        return;
                      }
                      setReply("");
                      load();
                    }}
                  >
                    <textarea
                      className="feedback-box"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={3}
                      placeholder={messages.feedbackWriteBack}
                    />
                    {replyError && <p className="warn-text">{replyError}</p>}
                    <button className="btn primary" type="submit">{messages.feedbackWriteBack}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function tourTargetSel(until: TourUntil): string | null {
  if (until === "ribbon-file") return '[data-tour="nb-file"]';
  if (until === "ribbon-edit") return '[data-tour="nb-edit"]';
  if (until === "ribbon-draw") return '[data-tour="nb-draw"]';
  if (until === "pdf-on") return '[data-tour="nb-pdf"]';
  return null;
}

function tourTargetActive(sel: string): boolean {
  const el = document.querySelector(sel);
  return !!el?.classList.contains("active");
}

/**
 * Whether the current tour beat's `until` is satisfied.
 * Ribbon tabs often start already open (Edit is the default) — those need a
 * fresh click on this step. PDF Preview only needs one click; it does not
 * have to stay on.
 */
function useTourUntilReady(until: TourUntil | undefined, view: string, step: number): boolean {
  const [ready, setReady] = useState(false);
  const startedActive = useRef(false);
  const clickedTarget = useRef(false);

  useEffect(() => {
    clickedTarget.current = false;
    if (!until) {
      setReady(true);
      return;
    }
    if (until === "opened-notebook") {
      setReady(view === "notebook" || view === "standalone");
      return;
    }
    if (until === "back-home") {
      setReady(view === "home");
      return;
    }

    const sel = tourTargetSel(until);
    if (!sel) {
      setReady(true);
      return;
    }

    startedActive.current = tourTargetActive(sel);
    // PDF / ribbon that isn't open yet: becoming active is enough.
    // Ribbon that is already open (Edit): require a click on that tab this step.
    const evalReady = () => {
      const active = tourTargetActive(sel);
      if (until === "pdf-on") {
        setReady(clickedTarget.current);
        return;
      }
      if (!startedActive.current) {
        setReady(active);
        return;
      }
      setReady(clickedTarget.current && active);
    };
    evalReady();

    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!t.closest(sel)) return;
      clickedTarget.current = true;
      // PDF Preview toggles async; ribbon class updates in the same click.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(evalReady);
      });
    };
    document.addEventListener("click", onClick, true);
    const poll = window.setInterval(evalReady, 250);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.clearInterval(poll);
    };
  }, [until, view, step]);

  // View-gated steps also update when `view` changes without remounting the effect deps race.
  useEffect(() => {
    if (until === "opened-notebook") setReady(view === "notebook" || view === "standalone");
    if (until === "back-home") setReady(view === "home");
  }, [until, view]);

  return ready;
}

export function WelcomeTour({
  settings,
  onChange,
  force,
  view,
  onDone,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  force: boolean;
  view: string;
  onDone: () => void;
}) {
  const [step, setStep] = useState(force ? 1 : 0);
  const steps = useMemo(
    () => tourStepsFor(settings.study_preset, settings.study_root),
    [settings.study_preset, settings.study_root],
  );
  const [skipNote, setSkipNote] = useState(false);
  const [tick, setTick] = useState(0);
  const [spot, setSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    document.addEventListener("click", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      document.removeEventListener("click", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, []);
  const gate = step === 0;
  const beat = gate ? null : steps[step - 1];
  const ready = useTourUntilReady(beat?.until, view, step);
  const advanceArmed = useRef(false);
  useEffect(() => {
    advanceArmed.current = false;
  }, [step]);
  useEffect(() => {
    const movesOn = beat?.until === "opened-notebook" || beat?.until === "back-home";
    if (!movesOn) return;
    if (!ready) {
      advanceArmed.current = true;
      return;
    }
    if (!advanceArmed.current) return;
    advanceArmed.current = false;
    setStep((s) => s + 1);
  }, [beat?.until, ready, step]);
  useEffect(() => {
    const at = beat?.at ?? "";
    document.documentElement.dataset.tourAt = at;
    window.dispatchEvent(new Event("paperlike-tour"));
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setTick((n) => n + 1));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [beat?.at]);
  useEffect(() => {
    return () => {
      delete document.documentElement.dataset.tourAt;
      window.dispatchEvent(new Event("paperlike-tour"));
    };
  }, []);
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!beat || beat.at === "center") {
      setSpot(null);
      setCard(null);
      return;
    }
    let el = document.querySelector(`[data-tour="${beat.at}"]`);
    // An empty Home grid has nothing to point at. A button whose label is plain
    // text has no element children, and is still the thing to highlight.
    const emptyGrid = beat.at === "home-grid" && !!el && el.childElementCount === 0;
    if (beat.fallbackAt && (!el || emptyGrid)) {
      el = document.querySelector(`[data-tour="${beat.fallbackAt}"]`) ?? el;
    }
    if (!el) {
      setSpot(null);
      setCard(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 8;
    setSpot({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
    const cardW = Math.min(380, window.innerWidth - 32);
    const measured = cardRef.current?.getBoundingClientRect().height;
    const cardH = measured && measured > 40 ? measured : 220;
    let left = r.right + 16;
    let top = r.top;
    if (left + cardW > window.innerWidth - 12) left = Math.max(12, r.left - cardW - 16);
    if (top + cardH > window.innerHeight - 12) top = Math.max(12, window.innerHeight - cardH - 12);
    if (top < 12) top = 12;
    setCard({ top, left });
    // Remeasure after paint — first pass often uses a stale height for long steps.
    const id = window.requestAnimationFrame(() => {
      const h = cardRef.current?.getBoundingClientRect().height;
      if (!h || h < 40) return;
      let t = r.top;
      if (t + h > window.innerHeight - 12) t = Math.max(12, window.innerHeight - h - 12);
      if (t < 12) t = 12;
      setCard((prev) => (prev && (prev.top !== t || prev.left !== left) ? { top: t, left } : prev));
    });
    return () => window.cancelAnimationFrame(id);
  }, [beat, tick, view, step]);
  if (!force && settings.welcome_dismissed && step === 0 && !skipNote) return null;
  const dismiss = async (skipped: boolean) => {
    const next = { ...settings, welcome_dismissed: true };
    onChange(next);
    await api.saveSettings(next);
    if (skipped && !force) setSkipNote(true);
    else onDone();
  };
  if (skipNote) {
    return (
      <Modal title="Paperlike" onClose={() => { setSkipNote(false); onDone(); }}>
        <p>{messages.tourSkipLater}</p>
        <button className="btn primary" onClick={() => { setSkipNote(false); onDone(); }}>{messages.tourOk}</button>
      </Modal>
    );
  }
  if (!force && settings.welcome_dismissed) return null;
  const last = step === steps.length;
  const text = gate ? messages.tourIntro : beat?.text ?? "";
  return (
    <>
      {spot && (
        <div
          className={`tour-spot${beat?.clearSpot || beat?.until ? " clear" : ""}`}
          style={spot}
        />
      )}
      <div
        ref={cardRef}
        className={`tour-card ${card ? "anchored" : ""}`}
        style={card ? { top: card.top, left: card.left } : undefined}
        role="dialog"
        aria-label={gate ? "Welcome tour" : beat?.title}
      >
        {!gate && beat && (
          <div className="tour-head">
            <span className="tour-title">{beat.title}</span>
            <span className="tour-count">{messages.tourStepOf(step, steps.length)}</span>
          </div>
        )}
        <p className="tour-text">{text}</p>
        {!gate && beat?.until && !ready && (
          <p className="settings-hint tour-hint">{beat.hint ?? messages.tourDoThis}</p>
        )}
        <div className="row">
          {gate ? (
            <>
              <button className="btn primary" onClick={() => setStep(1)}>{messages.tourStart}</button>
              <button className="btn" onClick={() => void dismiss(true)}>{messages.tourLater}</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setStep((s) => Math.max(1, s - 1))}>{messages.tourBack}</button>
              {last ? (
                <button className="btn primary" onClick={() => void dismiss(false)}>{messages.tourDone}</button>
              ) : (
                <button className="btn primary" disabled={!ready} onClick={() => setStep((s) => s + 1)}>{messages.tourNext}</button>
              )}
              <button className="btn" onClick={() => void dismiss(true)}>{messages.tourSkip}</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { api, HomeTile, RecoveryItem, SearchHit, Settings } from "./api";
import { ASK_DEFAULT_W, AskHost, AskNote, AskPane, clampAskWidth } from "./AskPane";
import { focusQuickField, QuickAskCard, QuickSeed, useNoteSelection } from "./QuickAsk";
import { BriefView } from "./BriefView";
import { GlobalSearchModal, HomeView } from "./HomeView";
import { MoodleFloat } from "./MoodlePane";
import { holdMoodleWebview } from "./moodleBridge";
import { huDateTime, NotebookView } from "./NotebookView";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { Modal } from "./ui";
import { CUSTOMER, FeedbackDock, LicenseStatus, SettingsDialog, TrialCorner, WelcomeTour } from "./customer";
import { messages } from "./copy/messages";
import { IcClose } from "./icons";
import { StudySetup } from "./StudySetup";
import "./styles.css";

type Route =
  | { view: "home" }
  | { view: "notebook"; path: string; notePath?: string; find?: string }
  | { view: "standalone"; path: string; find?: string };

type Toast = { id: number; msg: string };

function routesEqual(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  if (a.view === "home") return true;
  if (a.view === "standalone" && b.view === "standalone") {
    return a.path === b.path && (a.find ?? "") === (b.find ?? "");
  }
  if (a.view === "notebook" && b.view === "notebook") {
    return (
      a.path === b.path &&
      (a.notePath ?? "") === (b.notePath ?? "") &&
      (a.find ?? "") === (b.find ?? "")
    );
  }
  return false;
}

function lastHost(): AskHost {
  const saved = localStorage.getItem("pl.ask.host");
  if (saved === "gemini" || saved === "chatgpt") return saved;
  return "claude";
}

function rememberHost(host: AskHost) {
  localStorage.setItem("pl.ask.host", host);
}

function cleanArg(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/, "$1");
}

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function parentDir(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || null;
}

function isNoteOrNotebookData(path: string): boolean {
  return baseName(path).toLowerCase() === ".notebook_data" || /\.note$/i.test(path);
}

/** First argv entry that is a note or `.notebook_data`. Skips the exe and flags. */
function firstLaunchArg(argv: string[]): string | null {
  const args = argv
    .slice(1)
    .map(cleanArg)
    .filter((arg) => arg && !arg.startsWith("-"));
  return args.find(isNoteOrNotebookData) ?? null;
}

/** Open a note, a `.notebook_data` file, or a notebook folder. Returns whether it navigated. */
async function routeLaunchPath(path: string, navigate: (next: Route) => void): Promise<boolean> {
  const cleaned = cleanArg(path);
  if (!cleaned || cleaned.startsWith("-")) return false;
  if (baseName(cleaned).toLowerCase() === ".notebook_data") {
    const parent = parentDir(cleaned);
    if (!parent) return false;
    navigate({ view: "notebook", path: parent });
    return true;
  }
  if (/\.note$/i.test(cleaned)) {
    const parent = parentDir(cleaned);
    if (parent) {
      try {
        const info = await api.classifyPaths([parent]);
        if (info[0]?.kind === "notebook") {
          navigate({ view: "notebook", path: parent, notePath: cleaned });
          return true;
        }
      } catch {
        /* open the note on its own */
      }
    }
    navigate({ view: "standalone", path: cleaned });
    return true;
  }
  try {
    const info = await api.classifyPaths([cleaned]);
    const kind = info[0]?.kind;
    if (kind === "notebook") {
      navigate({ view: "notebook", path: cleaned });
      return true;
    }
    if (kind === "note") {
      const parent = parentDir(cleaned);
      if (parent) {
        const parentInfo = await api.classifyPaths([parent]);
        if (parentInfo[0]?.kind === "notebook") {
          navigate({ view: "notebook", path: parent, notePath: cleaned });
          return true;
        }
      }
      navigate({ view: "standalone", path: cleaned });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function routeLaunchArgv(argv: string[], navigate: (next: Route) => void) {
  const preferred = firstLaunchArg(argv);
  if (preferred) {
    await routeLaunchPath(preferred, navigate);
    return;
  }
  const args = argv
    .slice(1)
    .map(cleanArg)
    .filter((arg) => arg && !arg.startsWith("-"));
  for (const arg of args) {
    if (await routeLaunchPath(arg, navigate)) return;
  }
}

/** Note title as the sidebar shows it, from the file name. */
function titleFromPath(path: string): string {
  const stem = (path.split(/[\\/]/).pop() ?? "").replace(/\.note$/i, "");
  return /^Untitled( \d+)?$/.test(stem) || !stem ? "Untitled note" : stem;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "study" | "drawing" | "files" | "about" | "license">("general");
  const [trialNotice, setTrialNotice] = useState(false);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [tourForce, setTourForce] = useState(false);
  const [studyGate, setStudyGate] = useState<"wait" | "ask" | "off">("wait");
  const [route, setRoute] = useState<Route>({ view: "home" });
  const [moodleFloat, setMoodleFloat] = useState<{ path: string; name: string; preserve: boolean } | null>(null);
  const [moodleDock, setMoodleDock] = useState<{ path: string; n: number } | null>(null);
  const [tiles, setTiles] = useState<HomeTile[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [brief, setBrief] = useState<{ notebookPath?: string; notebookName?: string; notePaths: string[] } | null>(
    null,
  );
  const [ask, setAsk] = useState<{
    id: number;
    host: AskHost;
    /** Set when Brief picked the notes; otherwise the open note is attached. */
    briefPaths: string[] | null;
    question: string;
    send: boolean;
    /** A conversation to open, e.g. one started as a quick question. */
    url?: string | null;
  } | null>(null);
  const [askWidth, setAskWidth] = useState(() =>
    clampAskWidth(Number(localStorage.getItem("pl.ask.width")) || ASK_DEFAULT_W),
  );
  const saveOpenNote = useRef<(() => Promise<void>) | null>(null);
  const [quick, setQuick] = useState<QuickSeed | null>(null);
  const [recovery, setRecovery] = useState<RecoveryItem[]>([]);
  useNoteSelection();
  const toastId = useRef(0);
  useEffect(() => {
    invoke("moodle_warm").catch(() => {});
  }, []);

  useEffect(() => {
    if (!CUSTOMER || license?.kind !== "trial" || license.days_left !== 5) return;
    if (localStorage.getItem("pl.trial5") === "1") return;
    setTrialNotice(true);
  }, [license]);

  const licenseRef = useRef(license);
  licenseRef.current = license;
  const premiumOff = () => {
    const lic = licenseRef.current;
    return CUSTOMER && (!!lic?.read_only || lic?.kind === "ended");
  };
  const openLicense = () => {
    setSettingsTab("license");
    setSettingsOpen(true);
  };

  useEffect(() => {
    if (!CUSTOMER) return;
    const onLicense = () => {
      api.licenseStatus().then(setLicense).catch(() => {});
    };
    window.addEventListener("paperlike-license", onLicense);
    return () => window.removeEventListener("paperlike-license", onLicense);
  }, []);
  const backStack = useRef<Route[]>([]);
  const forwardStack = useRef<Route[]>([]);
  const routeRef = useRef(route);
  const fullscreenRef = useRef(false);
  routeRef.current = route;

  const toast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  type UpdateAnnouncement = { version: string; notes: string; date: string };
  const promptingRef = useRef(false);
  const trayRef = useRef(false);
  trayRef.current = !!settings?.tray;
  type FetchedUpdate = {
    version: string;
    body?: string;
    date?: string;
    install: (options?: { restartAfterInstall?: boolean }) => Promise<void>;
  };
  const pendingUpdate = useRef<FetchedUpdate | null>(null);
  const prefetchRef = useRef<Promise<FetchedUpdate | null> | null>(null);
  const beginUpdateFetch = useCallback(() => {
    return Promise.resolve(null as FetchedUpdate | null);
  }, []);
  const [announcement, setAnnouncement] = useState<UpdateAnnouncement | null>(null);

  const navigate = useCallback((next: Route) => {
    setRoute((cur) => {
      if (routesEqual(cur, next)) return cur;
      backStack.current.push(cur);
      forwardStack.current = [];
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const drainPending = () => {
      void invoke<string | null>("take_pending_open")
        .then((path) => {
          if (alive && path) void routeLaunchPath(path, navigate);
        })
        .catch(() => {});
    };
    void listen<string[]>("open-file", (event) => {
      if (!alive || !Array.isArray(event.payload)) return;
      void routeLaunchArgv(event.payload, navigate);
    })
      .then((off) => {
        if (!alive) {
          off();
          return;
        }
        unlisten = off;
        drainPending();
      })
      .catch(() => {
        if (alive) drainPending();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [navigate]);

  /** Update notePath on the current notebook entry without pushing history (first open / sync). */
  const replaceNotePath = useCallback((notePath: string) => {
    setRoute((cur) => {
      if (cur.view !== "notebook") return cur;
      if ((cur.notePath ?? "") === notePath) return cur;
      return { ...cur, notePath };
    });
  }, []);

  /** User opened another note in the same notebook → push history. */
  const pushNotePath = useCallback((notePath: string) => {
    setRoute((cur) => {
      if (cur.view !== "notebook") return cur;
      if ((cur.notePath ?? "") === notePath) return cur;
      backStack.current.push(cur);
      forwardStack.current = [];
      return { ...cur, notePath };
    });
  }, []);

  const goBack = useCallback(() => {
    const prev = backStack.current.pop();
    if (!prev) return;
    forwardStack.current.push(routeRef.current);
    setRoute(prev);
  }, []);

  const goForward = useCallback(() => {
    const next = forwardStack.current.pop();
    if (!next) return;
    backStack.current.push(routeRef.current);
    setRoute(next);
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // Resolve the study gate immediately so the welcome tour is not stuck
        // behind studyGate === "wait" for a frame (or forever on a failed effect).
        setStudyGate(CUSTOMER && !s.study_prompted ? "ask" : "off");
        document.documentElement.dataset.theme = ["dark", "mix"].includes(s.theme)
          ? s.theme
          : "bright";
      })
      .catch((e) => {
        setStudyGate("off");
        toast(String(e));
      });
    api.getHomeTiles().then(setTiles).catch(console.error);
    api.listRecovery().then(setRecovery).catch(console.error);
    if (CUSTOMER) {
      // Local status first so create/edit is not blocked while the network refresh runs.
      api.licenseStatus().then(setLicense).catch(() => {});
      api.licenseRefresh(null).then(setLicense).catch(() => {});
    }
    const win = getCurrentWindow();
    let stop = false;
    api.getWindowState().then(async (s) => {
      if (stop || s.w < 200 || s.h < 200) return;
      if (s.maximized) await win.maximize();
      else {
        await win.setPosition(new PhysicalPosition(s.x, s.y));
        await win.setSize(new PhysicalSize(s.w, s.h));
      }
    }).catch(() => {});
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          const maximized = await win.isMaximized();
          api.saveWindowState({ x: pos.x, y: pos.y, w: size.width, h: size.height, maximized });
        } catch { /* window may already be closing */ }
      }, 400);
    };
    const unMove = win.onMoved(save);
    const unResize = win.onResized(save);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      unMove.then((f) => f());
      unResize.then((f) => f());
    };
  }, [toast]);

  const registerSave = useCallback((fn: (() => Promise<void>) | null) => {
    saveOpenNote.current = fn;
  }, []);

  /** Open the chat beside the current note with the last-used host, or close it. */
  const toggleAsk = useCallback(() => {
    if (premiumOff()) {
      toast(messages.premiumOff);
      openLicense();
      return;
    }
    setAsk((cur) =>
      cur ? null : { id: Date.now(), host: lastHost(), briefPaths: null, question: "", send: false },
    );
  }, []);

  useEffect(() => {
    let cancel = false;
    void invoke<UpdateAnnouncement | null>("take_update_announcement")
      .then((note) => {
        if (!cancel && note) setAnnouncement(note);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    void beginUpdateFetch();
  }, [beginUpdateFetch]);

  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (event) => {
      // This listener destroys the window when the handler returns, unless
      // preventDefault ran. Do that before any await. The note view has its
      // own close listener; if that one destroys first, install() never spawns
      // the installer and the process is simply gone.
      event.preventDefault();
      const quitting = await invoke<boolean>("is_force_quit").catch(() => false);
      if (promptingRef.current) return;
      await new Promise<void>((r) => window.setTimeout(r, 0));
      if ((window as Window & { __plCloseForDirty?: boolean }).__plCloseForDirty) return;
      let update = pendingUpdate.current;
      if (!update && prefetchRef.current) update = await prefetchRef.current;
      if (!update) {
        prefetchRef.current = null;
        update = await beginUpdateFetch();
      }
      // No update: the tray keeps the process. Rust already hid the window.
      if (!update) {
        if (trayRef.current && !quitting) return;
        await win.destroy();
        return;
      }
      // An update must install and exit. Hiding to the tray leaves the old
      // process running, so the next launch is that same instance.
      promptingRef.current = true;
      try {
        await win.hide().catch(() => {});
        await invoke("record_update_note", {
          version: update.version,
          notes: update.body ?? "",
          date: update.date ?? new Date().toISOString(),
        }).catch(() => {});
        pendingUpdate.current = null;
        await update.install({ restartAfterInstall: false });
      } catch {
        /* still leave; a failed install must not sit in the tray */
      }
      await invoke("exit_app").catch(() => {});
      await win.destroy().catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, [beginUpdateFetch]);

  useEffect(() => {
    const onResize = () => setAskWidth((w) => clampAskWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onShortcuts = () => setShortcutsOpen(true);
    window.addEventListener("paperlike-open-shortcuts", onShortcuts);
    return () => window.removeEventListener("paperlike-open-shortcuts", onShortcuts);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let dead = false;
    const sync = () => {
      void win.isFullscreen().then((v) => {
        if (!dead) fullscreenRef.current = v;
      }).catch(() => {});
    };
    sync();
    const un = win.onResized(sync);
    return () => {
      dead = true;
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const typing = () => {
      const ae = document.activeElement as HTMLElement | null;
      return !!(
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable)
      );
    };
    const applyFullscreen = (next: boolean) => {
      const win = getCurrentWindow();
      fullscreenRef.current = next;
      void win
        .setFullscreen(next)
        .then(() => win.isFullscreen())
        .then((v) => {
          fullscreenRef.current = v;
        })
        .catch(() => {
          fullscreenRef.current = !next;
        });
    };
    const onToggleFullscreen = () => applyFullscreen(!fullscreenRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (typing()) return;
        e.preventDefault();
        onToggleFullscreen();
        return;
      }
      if (
        e.key === "Escape" &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        fullscreenRef.current &&
        !typing() &&
        !document.querySelector(".modal-backdrop, .menu, .popover, .math-pop")
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        applyFullscreen(false);
        return;
      }
      if (
        e.key === "?" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const ae = document.activeElement as HTMLElement | null;
        if (
          ae &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.tagName === "SELECT" ||
            ae.isContentEditable)
        ) {
          return;
        }
        if (document.querySelector(".modal-backdrop")) return;
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleAsk();
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (premiumOff()) {
          toast(messages.premiumOff);
          openLicense();
          return;
        }
        focusQuickField();
      }
      // Browser-style Alt+← / Alt+→
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paperlike-toggle-fullscreen", onToggleFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paperlike-toggle-fullscreen", onToggleFullscreen);
    };
  }, [goBack, goForward, toggleAsk]);

  /* Mouse side buttons: 3 = back, 4 = forward (Firefox / Chrome convention). */
  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      // A note uses the thumb buttons for undo and redo.
      if (document.querySelector(".notebook")) return;
      if (e.button === 3) goBack();
      else goForward();
    };
    window.addEventListener("mousedown", block, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("auxclick", block, true);
    return () => {
      window.removeEventListener("mousedown", block, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("auxclick", block, true);
    };
  }, [goBack, goForward]);

  const refreshTiles = () => api.getHomeTiles().then(setTiles).catch(console.error);

  if (!settings) {
    return <div className="empty-state">Loading Paperlike…</div>;
  }

  const openHit = (hit: SearchHit, query: string) => {
    setSearchOpen(false);
    if (hit.notebook_path) {
      navigate({ view: "notebook", path: hit.notebook_path, notePath: hit.note_path, find: query });
    } else {
      navigate({ view: "standalone", path: hit.note_path, find: query });
    }
  };

  const switchTo = (p: string, kind: "notebook" | "note") => {
    if (kind === "note") navigate({ view: "standalone", path: p });
    else navigate({ view: "notebook", path: p });
  };

  const openNotePath = route.view === "standalone" ? route.path : route.view === "notebook" ? route.notePath : undefined;
  const askNotes: AskNote[] = (ask?.briefPaths ?? (openNotePath ? [openNotePath] : [])).map((path) => ({
    path,
    title: titleFromPath(path),
  }));

  const openBriefAsk = (host: AskHost, notePaths: string[], question: string) => {
    if (premiumOff()) {
      toast(messages.premiumOff);
      openLicense();
      return;
    }
    setBrief(null);
    rememberHost(host);
    setAsk({ id: Date.now(), host, briefPaths: notePaths, question, send: true });
  };

  return (
    <>
      <div
        className={`app-frame ${ask ? "with-ask" : ""}`}
        style={{ ["--ask-w" as string]: ask ? `${askWidth}px` : "0px" }}
      >
      {route.view === "home" && announcement && announcement.notes.trim() && Number(String(announcement.version).split(".")[0]) >= 1 && (
        <aside className="update-card" role="status">
          <button
            type="button"
            className="btn icon update-card-close"
            title="Close"
            aria-label="Close"
            onClick={() => setAnnouncement(null)}
          >
            <IcClose size={15} />
          </button>
          <h3>{messages.updateInstalledTitle}</h3>
          <p className="update-card-version">{messages.updateInstalledVersion(announcement.version)}</p>
          {announcement.notes.trim() ? <p className="update-card-notes">{announcement.notes.trim()}</p> : null}
        </aside>
      )}
      {route.view === "home" && (
        <HomeView
          onToast={toast}
          onOpenSearch={() => setSearchOpen(true)}
          onBlankNote={() => {
            if (CUSTOMER && (license?.read_only || license?.kind === "ended")) {
              toast(messages.expiredBanner);
              openLicense();
              return;
            }
            api
              .createBlankNote()
              .then((path) => {
                refreshTiles();
                navigate({ view: "standalone", path });
              })
              .catch((e) => {
                toast(String(e));
                if (String(e).toLowerCase().includes("trial")) {
                  api.licenseStatus().then(setLicense).catch(() => {});
                  openLicense();
                }
              });
          }}
          onBrief={() => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            setBrief({ notePaths: [] });
          }}
          onAsk={toggleAsk}
          onQuickAsk={(seed) => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            setQuick(seed);
          }}
          onOpenNotebook={(path) => {
            refreshTiles();
            navigate({ view: "notebook", path });
          }}
          onOpenStandalone={(path) => {
            refreshTiles();
            navigate({ view: "standalone", path });
          }}
          onOpenSettings={() => {
            setSettingsTab("general");
            setSettingsOpen(true);
          }}
          settings={settings}
          onSettingsChange={setSettings}
          expired={CUSTOMER && (!!license?.read_only || license?.kind === "ended")}
          trialDays={CUSTOMER && license?.kind === "trial" ? license.days_left : null}
          onOpenLicense={() => {
            setSettingsTab("license");
            setSettingsOpen(true);
          }}
          onOpenCourseMoodle={(path, name) => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            setMoodleFloat({ path, name: name.trim() || "Moodle", preserve: false });
          }}
        />
      )}
      {route.view !== "home" && (
        <NotebookView
          expired={CUSTOMER && (!!license?.read_only || license?.kind === "ended")}
          key={route.path}
          mode={route.view === "notebook" ? "notebook" : "standalone"}
          path={route.path}
          settings={settings}
          onSettings={setSettings}
          onHome={() => {
            refreshTiles();
            navigate({ view: "home" });
          }}
          homeTiles={tiles}
          onSwitch={switchTo}
          onToast={toast}
          activeNotePath={route.view === "notebook" ? route.notePath : undefined}
          onNoteOpened={replaceNotePath}
          onNoteUserOpen={pushNotePath}
          initialFind={route.find}
          onBrief={() => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            setBrief({
              notebookPath: route.view === "notebook" ? route.path : undefined,
              notebookName: route.view === "notebook" ? tiles.find((t) => t.path === route.path)?.name : undefined,
              notePaths: route.view === "standalone" ? [route.path] : route.notePath ? [route.notePath] : [],
            });
          }}
          onAsk={toggleAsk}
          onQuickAsk={(seed) => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            setQuick(seed);
          }}
          onRegisterSave={registerSave}
          onOpenSettings={() => {
            setSettingsTab("general");
            setSettingsOpen(true);
          }}
          moodleHeld={moodleFloat != null}
          moodleDock={moodleDock}
          onFloatMoodle={(name, preserve) => {
            if (premiumOff()) {
              toast(messages.premiumOff);
              openLicense();
              return;
            }
            if (route.view !== "notebook") return;
            setMoodleFloat({ path: route.path, name: name.trim() || "Moodle", preserve });
          }}
        />
      )}
      {brief && (
        <BriefView
          notebookPath={brief.notebookPath}
          notebookName={brief.notebookName}
          initialPaths={brief.notePaths}
          onClose={() => setBrief(null)}
          onToast={toast}
          onOpenNote={(path, nb) => {
            refreshTiles();
            setBrief(null);
            if (nb) navigate({ view: "notebook", path: nb, notePath: path });
            else navigate({ view: "standalone", path });
          }}
          onAskHere={openBriefAsk}
        />
      )}
      {quick && (
        <QuickAskCard
          key={quick.id}
          seed={quick}
          initialHost={lastHost()}
          notePath={openNotePath}
          noteTitle={openNotePath ? titleFromPath(openNotePath) : undefined}
          beforeAsk={() => saveOpenNote.current?.() ?? Promise.resolve()}
          onHost={rememberHost}
          onOpenPanel={(host, question, url) => {
            setQuick(null);
            rememberHost(host);
            setAsk({ id: Date.now(), host, briefPaths: null, question: url ? "" : question, send: false, url });
          }}
          onClose={() => setQuick(null)}
        />
      )}
      </div>
      {ask && (
        <AskPane
          key={ask.id}
          host={ask.host}
          notes={askNotes}
          fromBrief={!!ask.briefPaths}
          initialQuestion={ask.question}
          sendOnOpen={ask.send}
          startUrl={ask.url ?? undefined}
          width={askWidth}
          beforeSend={() => saveOpenNote.current?.() ?? Promise.resolve()}
          onWidth={(w, done) => {
            setAskWidth(w);
            if (done) localStorage.setItem("pl.ask.width", String(w));
          }}
          onHost={(host) => {
            rememberHost(host);
            setAsk({ ...ask, host });
          }}
          onClose={() => setAsk(null)}
        />
      )}
      {recovery.length > 0 && (
        <RecoveryDialog
          items={recovery}
          onDone={(key) => setRecovery((r) => r.filter((x) => x.key !== key))}
          onOpen={(path, notebook) => {
            refreshTiles();
            if (notebook) navigate({ view: "notebook", path: notebook, notePath: path });
            else navigate({ view: "standalone", path });
          }}
          onToast={toast}
          onLater={() => setRecovery([])}
        />
      )}
      {searchOpen && <GlobalSearchModal onClose={() => setSearchOpen(false)} onOpen={openHit} />}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          initialTab={settingsTab}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          license={license}
          onToast={toast}
          onReplayTour={CUSTOMER ? () => { setSettingsOpen(false); navigate({ view: "home" }); setTourForce(true); } : undefined}
          onStudyHome={() => {
            setSettingsOpen(false);
            refreshTiles();
            navigate({ view: "home" });
          }}
        />
      )}
      {studyGate === "ask" && settings && (
        <StudySetup
          settings={settings}
          onChange={setSettings}
          onClose={() => setStudyGate("off")}
          onOpenHome={() => {
            setStudyGate("off");
            refreshTiles();
            navigate({ view: "home" });
          }}
        />
      )}
      <FeedbackDock showButton={route.view === "home"} />
      {CUSTOMER && trialNotice && (
        <div className="trial-notice" role="status">
          <button
            type="button"
            className="trial-notice-body"
            onClick={() => {
              localStorage.setItem("pl.trial5", "1");
              setTrialNotice(false);
              openLicense();
            }}
          >
            {messages.trialNotice}
          </button>
          <button
            type="button"
            className="btn icon"
            aria-label="Dismiss"
            onClick={() => {
              localStorage.setItem("pl.trial5", "1");
              setTrialNotice(false);
            }}
          >
            <IcClose size={14} />
          </button>
        </div>
      )}
      {CUSTOMER && route.view === "home" && license && (
        <>
          <TrialCorner status={license} onOpen={openLicense} />
        </>
      )}
      {CUSTOMER && settings && studyGate === "off" && (tourForce || !settings.welcome_dismissed) && (
        <WelcomeTour
          settings={settings}
          onChange={setSettings}
          force={tourForce}
          view={route.view}
          onDone={() => setTourForce(false)}
        />
      )}
      {moodleFloat && (
        <MoodleFloat
          key={moodleFloat.path}
          notebookPath={moodleFloat.path}
          notebookName={moodleFloat.name}
          preservePage={moodleFloat.preserve}
          onClose={() => setMoodleFloat(null)}
          onDock={() => {
            if (!moodleFloat) return;
            holdMoodleWebview();
            const { path } = moodleFloat;
            setMoodleFloat(null);
            setMoodleDock({ path, n: Date.now() });
            navigate({ view: "notebook", path });
          }}
          onToast={toast}
        />
      )}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}

/** Startup offer for notes whose edits never reached the file. */
function RecoveryDialog({
  items,
  onDone,
  onOpen,
  onToast,
  onLater,
}: {
  items: RecoveryItem[];
  onDone: (key: string) => void;
  onOpen: (path: string, notebook: string | null) => void;
  onToast: (msg: string) => void;
  onLater: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const recover = async (it: RecoveryItem) => {
    setBusy(it.key);
    try {
      const r = await api.recoverNote(it.key);
      onDone(it.key);
      onToast(r.path === it.path ? `Recovered ${it.title}` : `Recovered ${it.title} to ${r.path}`);
      if (items.length === 1) onOpen(r.path, r.notebook);
    } catch (e) {
      onToast(`Could not recover ${it.title}: ${e}`);
    } finally {
      setBusy(null);
    }
  };
  const discard = async (it: RecoveryItem) => {
    await api.discardRecovery(it.key).catch(() => {});
    onDone(it.key);
  };
  return (
    <Modal
      title={items.length === 1 ? "Recover an unsaved note?" : `Recover ${items.length} unsaved notes?`}
      onClose={onLater}
      actions={
        <button className="btn outline" onClick={onLater}>
          Decide later
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Paperlike closed before these edits were saved. Recover writes them into the note; the version on disk
        stays in the backups folder.
      </p>
      <div className="recovery-list">
        {items.map((it) => (
          <div key={it.key} className="recovery-row">
            <div className="recovery-text">
              <div className="recovery-title">{it.title || "Untitled note"}</div>
              <div className="recovery-meta" title={it.path}>
                {huDateTime(it.written)} ·{" "}
                {it.exists
                  ? it.path
                  : it.folder
                    ? `${it.path} (deleted since; Recover brings it back)`
                    : "its folder is gone; Recover puts it in your Paperlike Recovered folder"}
              </div>
            </div>
            <button className="btn outline" disabled={busy === it.key} onClick={() => discard(it)}>
              Discard
            </button>
            <button className="btn primary" disabled={busy === it.key} onClick={() => recover(it)}>
              Recover
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

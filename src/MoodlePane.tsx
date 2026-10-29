import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, HomeTile } from "./api";
import { messages } from "./copy/messages";
import { IcBack, IcClose, IcDock, IcFloat, IcHome, IcReload } from "./icons";
import { bestMatch, score, titleFits, unifiedCourseName } from "./moodleMatch";
import { COURSE_SCRIPT, ENGLISH_SCRIPT, FILE_ACTIONS_SCRIPT, WEEK_SCRIPT, customLookScript, fileGrabScript, type LookColors } from "./moodleInject";
import { acceptMoodleDragFile, beginMoodleDrag, endMoodleDrag, failMoodleDrag, insertMoodlePdf, moodleWebviewHeld, moveMoodleDrag, releaseMoodleHold, shapeMoodleDrag } from "./moodleBridge";
import "./moodle.css";

const COURSES_URL = "https://www.moodle.tum.de/my/courses.php";
/** "Meine Startseite" on TUM Moodle. */
const MY_URL = "https://www.moodle.tum.de/my/";

export type MoodleCourse = {
  id: number;
  fullname: string;
  shortname: string;
  viewurl: string;
  current?: boolean;
};

type MoodleMsg = {
  type?: string;
  phase?: string;
  url?: string;
  title?: string;
  confidence?: string;
  courses?: MoodleCourse[];
  tab?: string;
  message?: string;
  active?: boolean;
  autoFailed?: boolean;
  name?: string;
  x?: number;
  y?: number;
  px?: number;
  py?: number;
  cx?: number;
  cy?: number;
  pages?: number;
  aspect?: number;
  token?: number;
};

type DownloadEvt = { path: string; name: string; state: string; message?: string; insert?: boolean; token?: number };

function isNoteFile(url: string): boolean {
  return /pluginfile\.php|\/mod\/resource\/view\.php|\.(pdf|png|jpe?g|gif|webp)(\?|#|$)/i.test(url);
}

function fileNameFrom(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return base && !/^view\.php$/i.test(base) ? base : "file";
  } catch {
    return "file";
  }
}

type DragCal = { px: number; py: number; x: number; y: number };

/**
 * Cursor in this window's CSS pixels. Anchored where the press happened inside
 * the Moodle page, then moved by the physical cursor delta. Window-origin math
 * drifts from the real pointer.
 */
function clientFromCal(px: number, py: number, cal: DragCal): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: cal.x + (px - cal.px) / dpr, y: cal.y + (py - cal.py) / dpr };
}

function overNote(pt: { x: number; y: number }): boolean {
  const hit = document.elementFromPoint(pt.x, pt.y);
  const wrap = hit?.closest(".canvas-wrap");
  if (!wrap) return false;
  // The PDF preview scroller uses the same class. Only the live editor accepts a drop.
  if (wrap.querySelector(":scope > .pdf-scroll")) return false;
  const r = wrap.getBoundingClientRect();
  return pt.x >= r.left - 8 && pt.y >= r.top - 8 && pt.x <= r.right + 8 && pt.y <= r.bottom + 8;
}

type Bounds = { x: number; y: number; w: number; h: number };

function courseUrl(id: number): string {
  return `https://www.moodle.tum.de/course/view.php?id=${id}`;
}

/** Meine Startseite, not the course list and not a course page. */
function isMoodleHome(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return path === "/my" || path === "/my/index.php";
}

/** Full title plus Moodle short name, so HM1 / TM1 still help the match. */
function courseLabel(c: MoodleCourse): string {
  return [c.fullname, c.shortname].filter(Boolean).join(" ");
}

function materialDir(notebookPath: string): string {
  const trimmed = notebookPath.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}Material`;
}

/** Folder name right under Lectures, which is the short course name in a study layout. */
function lectureName(path: string): string | null {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const i = parts.findIndex((p) => p.toLowerCase() === "lectures");
  return i >= 0 && i + 1 < parts.length ? parts[i + 1] : null;
}

function notebookTiles(tiles: HomeTile[], out: HomeTile[] = []): HomeTile[] {
  for (const t of tiles) {
    if (t.kind === "group") notebookTiles(t.group_items ?? [], out);
    else if (t.kind === "notebook" && !t.missing) out.push(t);
  }
  return out;
}

/**
 * Docked TUM Moodle browser. The page is a child webview positioned over `.moodle-slot`.
 * Custom restyles that same page: it stays visible, course titles are shortened, and a
 * Lectures | Exercises filter is added on course lists.
 */
export function MoodlePane({
  notebookPath,
  notebookName,
  onInsertPdf,
  onClose,
  floating = false,
  layoutNonce = 0,
  onFloat,
  preservePage = false,
}: {
  notebookPath: string;
  notebookName: string;
  onInsertPdf: (path: string) => void;
  onClose: () => void;
  /** Fill a floating frame instead of the docked column. */
  floating?: boolean;
  /** Bumps when the frame moves, so the webview follows. */
  layoutNonce?: number;
  /** Detach into a floating window. The pane stays alive across the handoff. */
  onFloat?: () => void;
  /** The webview is already on the right page. Don't navigate again. */
  preservePage?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const placing = useRef(false);
  const alive = useRef(true);
  const keepRef = useRef(false);
  const langTried = useRef(new Set<string>());
  const startUrl = useRef(COURSES_URL);
  const savedId = useRef<number | null>(null);
  const didAuto = useRef(false);
  const wantAuto = useRef(false);
  const fixedLink = useRef(false);
  const nameRef = useRef(notebookName);
  const pathRef = useRef(notebookPath);
  const urlRef = useRef(COURSES_URL);
  const chain = useRef(Promise.resolve());
  const placeGate = useRef(Promise.resolve());
  const customRef = useRef(localStorage.getItem("pl.moodle.view") !== "page");
  const coursesRef = useRef<MoodleCourse[]>([]);
  const tabRef = useRef<"lectures" | "exercises">(
    localStorage.getItem("pl.moodle.tab") === "exercises" ? "exercises" : "lectures",
  );
  const nameMapRef = useRef<Record<string, string>>({});
  const onPageRef = useRef<(url: string) => void>(() => {});
  const onCoursesRef = useRef<(incoming: MoodleCourse[]) => void>(() => {});
  const paintRef = useRef<() => void>(() => {});
  nameRef.current = notebookName;
  pathRef.current = notebookPath;

  const [ready, setReady] = useState(false);
  const [courses, setCourses] = useState<MoodleCourse[]>([]);
  const [chosen, setChosen] = useState<number | "">("");
  const [status, setStatus] = useState("Opening Moodle…");
  const [banner, setBanner] = useState<{ path: string; name: string } | null>(null);
  const [filePage, setFilePage] = useState(false);
  const insertRef = useRef(onInsertPdf);
  insertRef.current = onInsertPdf;
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [saveOffer, setSaveOffer] = useState(false);
  // TUM two-factor step: null = not on it; error = a submitted code came back rejected.
  const [mfa, setMfa] = useState<{ error: boolean; autoFailed: boolean; round: number } | null>(null);
  // Automatic codes: whether a key is saved, and the TUMonline setup step if running.
  const [totpSaved, setTotpSaved] = useState(false);
  const [setup, setSetup] = useState<{ phase: "find" | "confirm"; error?: string } | null>(null);
  const [pasteKey, setPasteKey] = useState("");
  const [liveCode, setLiveCode] = useState<{ code: string; left: number } | null>(null);
  useEffect(() => {
    void invoke<boolean>("moodle_totp_saved").then(setTotpSaved).catch(() => {});
  }, []);
  useEffect(() => {
    if (setup?.phase !== "confirm") {
      setLiveCode(null);
      return;
    }
    let on = true;
    const tick = () =>
      void invoke<{ code: string; left: number }>("moodle_totp_code")
        .then((c) => on && setLiveCode(c))
        .catch(() => {});
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      on = false;
      window.clearInterval(id);
    };
  }, [setup?.phase]);
  const startSetup = () => {
    setMfa(null);
    setStatus("");
    setPasteKey("");
    setSetup({ phase: "find" });
    void invoke("moodle_totp_setup", { on: true }).catch((e) => setSetup({ phase: "find", error: String(e) }));
  };
  const endSetup = (keep: boolean) => {
    void invoke("moodle_totp_setup", { on: false }).catch(() => {});
    if (!keep) {
      void invoke("moodle_clear_totp").catch(() => {});
      setTotpSaved(false);
    }
    setSetup(null);
    void invoke("moodle_nav", { url: startUrl.current }).catch(() => {});
  };
  const [otp, setOtp] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const otpSent = useRef(false);
  const submitOtp = (code: string) => {
    if (code.length !== 6 || otpBusy) return;
    setOtpBusy(true);
    otpSent.current = true;
    invoke("moodle_submit_otp", { code }).catch((e) => {
      setOtpBusy(false);
      setStatus(String(e));
    });
  };
  const [custom, setCustom] = useState(customRef.current);
  const [customTab, setCustomTab] = useState(tabRef.current);
  const [ownNames, setOwnNames] = useState<string[]>([]);
  const [ownLinks, setOwnLinks] = useState<Map<number, string>>(new Map());
  const [linkedId, setLinkedId] = useState<number | null>(null);
  tabRef.current = customTab;

  const evalScript = (script: string, quiet = false) => {
    const next = chain.current.then(() => invoke("moodle_eval", { script })).catch((e) => {
      if (!quiet) setStatus(String(e));
    });
    chain.current = next.then(() => undefined);
  };

  const readColors = (): LookColors => {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      bg: pick("--bg", "#f6f4ef"),
      bg2: pick("--bg-2", "#efece5"),
      surface: pick("--surface", "#ffffff"),
      ink: pick("--ink", "#23201c"),
      ink2: pick("--ink-2", "#6f6a62"),
      ink3: pick("--ink-3", "#908a80"),
      accent: pick("--accent", "#6d4fc4"),
      accentInk: pick("--accent-ink", "#ffffff"),
      soft: pick("--accent-soft", "#ece7f9"),
      border: pick("--border", "#e2ddd3"),
    };
  };

  const paint = () => {
    if (!shown.current) return;
    evalScript(customLookScript(customRef.current, tabRef.current, nameMapRef.current, readColors()), true);
  };
  paintRef.current = paint;

  const placeNow = async () => {
    const slot = slotRef.current;
    if (!slot || !alive.current) return;
    const r = slot.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) {
      setStatus((s) => (s.startsWith("Opening") || s.startsWith("Waiting") ? "Waiting for the Moodle panel to lay out…" : s));
      return;
    }
    const bounds: Bounds = { x: r.x, y: r.y, w: r.width, h: r.height };
    if (!shown.current) {
      // Claim before await so retries do not open several webviews at once.
      shown.current = true;
      placing.current = true;
      setStatus("Opening Moodle…");
      try {
        const fresh = await invoke<boolean>("moodle_show", { url: startUrl.current, bounds });
        releaseMoodleHold();
        if (!alive.current) {
          if (!keepRef.current && !moodleWebviewHeld()) invoke("moodle_hide").catch(() => {});
          return;
        }
        if (!fresh && preservePage) {
          setStatus("");
          paintRef.current();
          return;
        }
        setStatus("Loading…");
        if (!fresh) await invoke("moodle_nav", { url: startUrl.current });
        paintRef.current();
      } catch (e) {
        shown.current = false;
        setStatus(String(e));
        throw e;
      } finally {
        placing.current = false;
      }
    } else {
      await invoke("moodle_bounds", { bounds });
    }
  };

  const place = () => {
    const job = placeGate.current.then(() => placeNow());
    placeGate.current = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };

  useEffect(() => {
    let dead = false;
    didAuto.current = false;
    fixedLink.current = false;
    shown.current = false;
    placing.current = false;
    setReady(false);
    setCourses([]);
    coursesRef.current = [];
    setBanner(null);
    setStatus("Opening Moodle…");
    (async () => {
      try {
        await invoke("moodle_set_target", { folder: materialDir(notebookPath) });
      } catch (e) {
        if (!dead) setStatus(String(e));
      }
      let id: number | null = null;
      try {
        id = await invoke<number | null>("get_notebook_moodle", { path: notebookPath });
      } catch {
        id = null;
      }
      if (dead) return;
      savedId.current = id && id > 0 ? id : null;
      setLinkedId(savedId.current);
      if (savedId.current) setChosen(savedId.current);
      startUrl.current = savedId.current ? courseUrl(savedId.current) : COURSES_URL;
      urlRef.current = startUrl.current;
      wantAuto.current = !savedId.current;
      setReady(true);
    })();
    return () => {
      dead = true;
    };
  }, [notebookPath]);

  useEffect(() => {
    let dead = false;
    (async () => {
      const tiles = await api.getHomeTiles().catch(() => [] as HomeTile[]);
      const names: string[] = [];
      const links = new Map<number, string>();
      for (const t of notebookTiles(tiles)) {
        const name = (lectureName(t.path) ?? t.name).trim();
        if (!name) continue;
        if (!names.includes(name)) names.push(name);
        const id = await invoke<number | null>("get_notebook_moodle", { path: t.path }).catch(() => null);
        if (id && id > 0 && !links.has(id)) links.set(id, name);
      }
      if (!dead) {
        setOwnNames(names);
        setOwnLinks(links);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const tryPlace = () => {
      place().catch((e) => setStatus(String(e)));
    };
    const id = window.setTimeout(tryPlace, 40);
    const retry = window.setInterval(() => {
      if (shown.current) {
        window.clearInterval(retry);
        return;
      }
      tryPlace();
    }, 250);
    const fail = window.setTimeout(() => {
      if (!shown.current && alive.current) {
        setStatus("Moodle did not open. Close this pane and try again.");
      }
    }, 12000);
    const onResize = () => tryPlace();
    window.addEventListener("resize", onResize);
    const obs = new ResizeObserver(onResize);
    if (slotRef.current) obs.observe(slotRef.current);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(fail);
      window.clearInterval(retry);
      window.removeEventListener("resize", onResize);
      obs.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, notebookPath]);

  useEffect(() => {
    if (!ready || !layoutNonce) return;
    place().catch((e) => setStatus(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutNonce]);

  useEffect(() => {
    alive.current = true;
    const root = document.documentElement;
    const theme = new MutationObserver(() => paintRef.current());
    theme.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      alive.current = false;
      theme.disconnect();
      document.querySelector(".canvas-wrap")?.classList.remove("moodle-drop-target");
      if (!keepRef.current && !moodleWebviewHeld()) invoke("moodle_hide").catch(() => {});
    };
  }, []);

  useEffect(() => {
    let cal: DragCal | null = null;
    let dragMoved = false;
    let dragToken = 0;
    const clearDrop = () => {
      document.querySelector(".canvas-wrap")?.classList.remove("moodle-drop-target");
    };
    const onFileDrag = (payload: MoodleMsg, phase: "begin" | "move" | "end") => {
      const px = Number(payload.px);
      const py = Number(payload.py);
      if (phase === "begin") {
        dragMoved = false;
        dragToken = 0;
        cal = null;
        clearDrop();
        const slot = slotRef.current?.getBoundingClientRect();
        const cx = Number(payload.cx);
        const cy = Number(payload.cy);
        if (slot && slot.width > 40 && Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(cx) && Number.isFinite(cy)) {
          cal = { px, py, x: slot.left + cx, y: slot.top + cy };
        }
        return;
      }
      if (!cal || !Number.isFinite(px) || !Number.isFinite(py)) return;
      const dpr = window.devicePixelRatio || 1;
      if (Math.hypot(px - cal.px, py - cal.py) > 8 * dpr) dragMoved = true;
      const pt = clientFromCal(px, py, cal);
      if (dragMoved && !dragToken && payload.url) {
        dragToken = Date.now();
        beginMoodleDrag(dragToken);
        evalScript(fileGrabScript(payload.url, payload.name || "file", dragToken));
        setStatus("Adding to the note…");
      }
      if (phase === "end") {
        const over = dragMoved && !!payload.url && overNote(pt);
        clearDrop();
        const token = dragToken;
        dragMoved = false;
        dragToken = 0;
        cal = null;
        if (token) {
          endMoodleDrag(token, over ? pt : null);
          if (!over) setStatus("");
        }
        return;
      }
      if (!dragMoved) return;
      const over = overNote(pt);
      document.querySelector(".canvas-wrap")?.classList.toggle("moodle-drop-target", over);
      if (dragToken) moveMoodleDrag(dragToken, over ? pt : null);
    };
    const offMsg = listen<MoodleMsg>("moodle-msg", ({ payload }) => {
      const type = payload?.type;
      if (type === "page") {
        if (payload.phase === "finished" && payload.url) {
          if (/^https?:\/\/([^/]*\.)?moodle\.tum\.de\//i.test(payload.url)) {
            otpSent.current = false;
            setMfa(null);
          }
          onPageRef.current(payload.url);
        }
        return;
      }
      if (type === "login-required") {
        setStatus(messages.moodleSignIn);
        return;
      }
      if (type === "login-mfa") {
        if (payload.active) {
          setStatus("");
          // Only a code typed for this prompt can have been rejected.
          const rejected = otpSent.current;
          otpSent.current = false;
          setMfa((m) => ({ error: rejected, autoFailed: !!payload.autoFailed, round: (m?.round ?? 0) + 1 }));
          setOtp("");
          setOtpBusy(false);
        } else {
          otpSent.current = false;
          setMfa(null);
        }
        return;
      }
      if (type === "totp-found") {
        setTotpSaved(true);
        setSetup({ phase: "confirm" });
        return;
      }
      if (type === "totp-error") {
        setSetup((cur) => (cur ? { ...cur, error: payload.message ?? "" } : cur));
        return;
      }
      if (type === "login-auto") {
        setStatus(messages.moodleSigningIn);
        return;
      }
      if (type === "login-save-offer") {
        setSaveOffer(true);
        return;
      }
      if (type === "courses") onCoursesRef.current(payload.courses ?? []);
      if (type === "custom-tab" && (payload.tab === "lectures" || payload.tab === "exercises")) {
        tabRef.current = payload.tab;
        setCustomTab(payload.tab);
        localStorage.setItem("pl.moodle.tab", payload.tab);
      }
      if (type === "file-drag-begin") {
        onFileDrag(payload, "begin");
        return;
      }
      if (type === "file-drag-move") {
        onFileDrag(payload, "move");
        return;
      }
      if (type === "file-drag-end") {
        onFileDrag(payload, "end");
        return;
      }
      if (type === "pdf-ghost") {
        const pages = Number(payload.pages);
        const aspect = Number(payload.aspect);
        const token = Number(payload.token);
        if (pages > 0 && token > 0) shapeMoodleDrag(token, pages, Number.isFinite(aspect) ? aspect : 1.294);
        return;
      }
      if (type === "week") {
        const title = (payload.title || "").trim();
        if (!title) setStatus("No current week section on this page.");
        else if (payload.confidence === "high") setStatus(`Current week: ${title}`);
        else setStatus(`Possible section (low confidence): ${title}`);
      }
    });
    const offDl = listen<DownloadEvt>("moodle-download", ({ payload }) => {
      if (payload.state === "completed" && payload.path) {
        if (payload.insert) {
          const token = Number(payload.token) || 0;
          if (!acceptMoodleDragFile(token, payload.path)) {
            insertRef.current(payload.path);
            setStatus(`Added ${payload.name || "file"} to the note.`);
          }
          return;
        }
        setBanner({ path: payload.path, name: payload.name || "PDF" });
        setStatus(`Saved ${payload.name || "PDF"} to Material.`);
      } else {
        const token = Number(payload.token) || 0;
        if (token) failMoodleDrag(token);
        setStatus(payload.message || `Couldn't save ${payload.name || "the PDF"}.`);
      }
    });
    return () => {
      void offMsg.then((f) => f());
      void offDl.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPage = (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    urlRef.current = url;
    const host = parsed.hostname.toLowerCase();
    const allowed =
      host === "tum.de" || host.endsWith(".tum.de") || host === "aai.dfn.de" || host.endsWith(".aai.dfn.de");
    if (!allowed) return;
    const sso =
      host.endsWith(".aai.dfn.de") ||
      host === "aai.dfn.de" ||
      /\/(login|auth|idp|shibboleth|saml)(\/|$)/i.test(parsed.pathname);
    if (sso) {
      setStatus(messages.moodleSignIn);
      return;
    }
    const moodle = host === "moodle.tum.de" || host.endsWith(".moodle.tum.de");
    if (!moodle) return;
    const path = parsed.pathname;
    const list = path.includes("/my/") || path.endsWith("courses.php");
    if (list && !savedId.current && !didAuto.current) wantAuto.current = true;
    if (list || path.includes("course/view.php") || !coursesRef.current.length) evalScript(COURSE_SCRIPT);
    if (path.includes("course/view.php")) evalScript(WEEK_SCRIPT);
    if (!langTried.current.has(path)) {
      langTried.current.add(path);
      evalScript(ENGLISH_SCRIPT, true);
    }
    setFilePage(isNoteFile(url));
    setStatus(isMoodleHome(parsed) ? "Dashboard" : "");
    evalScript(FILE_ACTIONS_SCRIPT, true);
    paintRef.current();
    if (path.includes("course/view.php") && customRef.current) evalScript(WEEK_SCRIPT);
  };
  onPageRef.current = onPage;

  const onCourses = (incoming: MoodleCourse[]) => {
    const list = incoming.filter((c) => c && c.id > 0 && c.fullname);
    const ranked = list
      .map((c) => ({ c, s: score(nameRef.current, courseLabel(c)) }))
      .sort((a, b) => b.s - a.s || a.c.fullname.localeCompare(b.c.fullname));
    coursesRef.current = ranked.map((r) => r.c);
    setCourses(coursesRef.current);
    const name = nameRef.current.trim();
    if (wantAuto.current && !savedId.current && !didAuto.current && name) {
      didAuto.current = true;
      wantAuto.current = false;
      const match = bestMatch(
        name,
        ranked.map((r) => ({ label: courseLabel(r.c), item: r.c })),
      );
      if (match?.confident) {
        savedId.current = match.item.id;
        setLinkedId(match.item.id);
        setChosen(match.item.id);
        setStatus(`Opening ${match.item.fullname}`);
        void invoke("set_notebook_moodle", { path: pathRef.current, courseId: match.item.id }).catch((e) =>
          setStatus(String(e)),
        );
        void invoke("moodle_nav", { url: match.item.viewurl || courseUrl(match.item.id) }).catch((e) =>
          setStatus(String(e)),
        );
        return;
      }
      setStatus(name ? `Pick the course for “${name}”.` : "Pick the Moodle course for this notebook.");
      return;
    }
    if (savedId.current && !fixedLink.current && name) {
      fixedLink.current = true;
      const saved = ranked.find((r) => r.c.id === savedId.current);
      const savedOk = !!saved && titleFits(name, courseLabel(saved.c));
      if (!savedOk) {
        const match = bestMatch(
          name,
          ranked.map((r) => ({ label: courseLabel(r.c), item: r.c })),
        );
        if (match?.confident && match.item.id !== savedId.current) {
          savedId.current = match.item.id;
          setLinkedId(match.item.id);
          setChosen(match.item.id);
          setStatus(`Opening ${match.item.fullname}`);
          void invoke("set_notebook_moodle", { path: pathRef.current, courseId: match.item.id }).catch((e) =>
            setStatus(String(e)),
          );
          void invoke("moodle_nav", { url: match.item.viewurl || courseUrl(match.item.id) }).catch((e) =>
            setStatus(String(e)),
          );
          return;
        }
      }
    }
    if (savedId.current) {
      const linked = ranked.find((r) => r.c.id === savedId.current);
      if (linked) setChosen(linked.c.id);
    }
  };
  onCoursesRef.current = onCourses;

  const showPage = () => {
    customRef.current = false;
    setCustom(false);
    localStorage.setItem("pl.moodle.view", "page");
    void place()
      .then(() => paintRef.current())
      .catch((e) => setStatus(String(e)));
  };

  const showCustom = () => {
    customRef.current = true;
    setCustom(true);
    localStorage.setItem("pl.moodle.view", "custom");
    if (!coursesRef.current.length) evalScript(COURSE_SCRIPT);
    void place()
      .then(() => paintRef.current())
      .catch((e) => setStatus(String(e)));
  };

  const linkCourse = (id: number) => {
    didAuto.current = true;
    wantAuto.current = false;
    savedId.current = id;
    setLinkedId(id);
    setChosen(id);
    void invoke("set_notebook_moodle", { path: notebookPath, courseId: id }).catch((e) => setStatus(String(e)));
  };

  const choose = (id: number) => {
    const c = courses.find((x) => x.id === id);
    if (!c) return;
    linkCourse(id);
    setStatus(`Opening ${c.fullname}`);
    void invoke("moodle_nav", { url: c.viewurl || courseUrl(id) }).catch((e) => setStatus(String(e)));
  };

  const goHome = () => {
    urlRef.current = MY_URL;
    void invoke("moodle_nav", { url: MY_URL }).catch((e) => setStatus(String(e)));
  };

  /** Open the linked course if needed, then expand the current week section. */
  const goCurrentWeek = () => {
    const id = chosen || linkedId || savedId.current;
    let onCourse = false;
    try {
      const u = new URL(urlRef.current);
      const pageId = u.searchParams.get("id");
      onCourse =
        u.pathname.includes("course/view.php") &&
        (!id || !pageId || pageId === String(id));
    } catch {
      onCourse = false;
    }
    if (onCourse) {
      evalScript(WEEK_SCRIPT);
      return;
    }
    if (id) {
      const c = courses.find((x) => x.id === id);
      const url = c?.viewurl || courseUrl(id);
      setStatus(`Opening ${c?.fullname || "course"}…`);
      // onPage runs WEEK_SCRIPT once the course view finishes loading.
      void invoke("moodle_nav", { url }).catch((e) => setStatus(String(e)));
      return;
    }
    setStatus("Pick a course first.");
    evalScript(WEEK_SCRIPT);
  };

  const reload = () => {
    void invoke("moodle_reload").catch((e) => setStatus(String(e)));
  };

  const preferredNames = useMemo(() => {
    const own = nameRef.current.trim();
    return own && !ownNames.includes(own) ? [...ownNames, own] : ownNames;
  }, [ownNames, notebookName]);

  const nameMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of courses) {
      const title = c.fullname || c.shortname;
      const linked = ownLinks.get(c.id) ?? (c.id === linkedId ? notebookName.trim() : "");
      const unified = unifiedCourseName(title, preferredNames);
      out[String(c.id)] = linked && titleFits(linked, title) ? linked : unified;
    }
    return out;
  }, [courses, ownLinks, linkedId, notebookName, preferredNames]);
  nameMapRef.current = nameMap;

  useEffect(() => {
    paintRef.current();
  }, [nameMap, custom]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const pane = handle.parentElement;
    const parent = pane?.parentElement;
    if (!pane || !parent) return;
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const min = 220;
    const max = Math.max(min, parent.getBoundingClientRect().width - 280);
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(min, startW - (ev.clientX - startX)));
      setPaneWidth(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <aside
      className={`moodle-pane${floating ? " is-float" : ""}`}
      style={!floating && paneWidth != null ? { width: paneWidth, flexBasis: paneWidth, maxWidth: "none" } : undefined}
    >
      {!floating && <div className="moodle-resize" title="Drag to resize" onPointerDown={startResize} />}
      <div className="moodle-body">
      <div className="moodle-bar">
        <button type="button" className="btn icon" title="Back" aria-label="Back" onClick={() => void invoke("moodle_back").catch((e) => setStatus(String(e)))}>
          <IcBack size={15} />
        </button>
        <button type="button" className="btn icon" title="Dashboard" aria-label="Dashboard" onClick={goHome}>
          <IcHome size={15} />
        </button>
        <button type="button" className="btn icon" title="Reload" aria-label="Reload" onClick={reload}>
          <IcReload size={15} />
        </button>
        <label className="switch" title="Custom look">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => (e.target.checked ? showCustom() : showPage())}
          />
          <span className="track" />
          Custom look
        </label>
        {filePage && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStatus("Adding to the note…");
              evalScript(fileGrabScript(urlRef.current, fileNameFrom(urlRef.current)));
            }}
          >
            Add to note
          </button>
        )}
        <button type="button" className="btn" title="Open this course and expand the current week" onClick={goCurrentWeek}>
          Current week
        </button>
        <select
          aria-label="Enrolled courses"
          value={chosen === "" ? "" : String(chosen)}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (id) choose(id);
          }}
        >
          <option value="">Course…</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
                {nameMap[String(c.id)] || c.fullname}
            </option>
          ))}
        </select>
        <span className="moodle-bar-spacer" />
        {onFloat && (
          <button
            type="button"
            className="btn icon"
            title="Float"
            aria-label="Float"
            onClick={() => {
              keepRef.current = true;
              onFloat();
            }}
          >
            <IcFloat size={15} />
          </button>
        )}
        <button type="button" className="btn icon" title="Close" aria-label="Close" onClick={onClose}>
          <IcClose size={15} />
        </button>
      </div>
      {status && <div className="moodle-status">{status}</div>}
      {mfa && (
        <form
          className="moodle-banner moodle-mfa"
          onSubmit={(e) => {
            e.preventDefault();
            submitOtp(otp);
          }}
        >
          <label htmlFor="moodle-otp">
            {mfa.error ? messages.moodleMfaRetry : mfa.autoFailed ? messages.moodleTotpRejected : messages.moodleMfaPrompt}
          </label>
          <input
            key={mfa.round}
            id="moodle-otp"
            className="moodle-otp"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            value={otp}
            disabled={otpBusy}
            aria-invalid={mfa.error || undefined}
            onChange={(e) => {
              const code = e.target.value.replace(/\D/g, "").slice(0, 6);
              setOtp(code);
              if (code.length === 6) submitOtp(code);
            }}
          />
          <button type="submit" className="btn primary" disabled={otp.length !== 6 || otpBusy}>
            {otpBusy ? messages.moodleMfaChecking : messages.moodleMfaConfirm}
          </button>
          {(!totpSaved || mfa.autoFailed) && !setup && (
            <button type="button" className="btn outline" onClick={startSetup}>
              {totpSaved ? messages.moodleTotpRedo : messages.moodleTotpOffer}
            </button>
          )}
        </form>
      )}
      {setup && (
        <div className="moodle-banner moodle-totp" role="status">
          {setup.phase === "find" ? (
            <>
              <div className="moodle-totp-text">
                <strong>{messages.moodleTotpTitle}</strong>
                <span>{messages.moodleTotpFind}</span>
                <span className="moodle-totp-note">{messages.moodleTotpRisk}</span>
                {setup.error && <span className="moodle-totp-error">{setup.error}</span>}
              </div>
              <form
                className="moodle-totp-paste"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!pasteKey.trim()) return;
                  void invoke("moodle_save_totp", { secret: pasteKey }).catch((err) =>
                    setSetup({ phase: "find", error: String(err) }),
                  );
                }}
              >
                <input
                  className="moodle-totp-key"
                  placeholder={messages.moodleTotpPaste}
                  aria-label={messages.moodleTotpPaste}
                  spellCheck={false}
                  autoComplete="off"
                  value={pasteKey}
                  onChange={(e) => setPasteKey(e.target.value)}
                />
                <button type="submit" className="btn" disabled={!pasteKey.trim()}>
                  {messages.moodleTotpUseKey}
                </button>
                <button type="button" className="btn" onClick={() => endSetup(totpSaved)}>
                  {messages.moodleTotpCancel}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="moodle-totp-text">
                <strong>{messages.moodleTotpFoundTitle}</strong>
                <span>{messages.moodleTotpConfirm}</span>
                <span className="moodle-totp-note">{messages.moodleTotpBackup}</span>
              </div>
              {liveCode && (
                <span className="moodle-totp-code" aria-label={`Current code ${liveCode.code}`}>
                  {liveCode.code.slice(0, 3)} {liveCode.code.slice(3)}
                  <small>{liveCode.left}s</small>
                </span>
              )}
              <button type="button" className="btn" onClick={() => void invoke("moodle_totp_fill").catch(() => {})}>
                {messages.moodleTotpRefill}
              </button>
              <button type="button" className="btn primary" onClick={() => endSetup(true)}>
                {messages.moodleTotpDone}
              </button>
              <button type="button" className="btn" onClick={() => endSetup(false)}>
                {messages.moodleTotpCancel}
              </button>
            </>
          )}
        </div>
      )}
      {saveOffer && (
        <div className="moodle-banner moodle-save-offer">
          <span>{messages.moodleSaveOffer}</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              void invoke("moodle_save_login")
                .then(() => {
                  setSaveOffer(false);
                  setStatus(messages.moodleSaveDone);
                })
                .catch((e) => setStatus(String(e)));
            }}
          >
            {messages.moodleSaveYes}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSaveOffer(false);
              void invoke("moodle_decline_login").catch(() => {});
            }}
          >
            {messages.moodleSaveNo}
          </button>
        </div>
      )}
      <div className="moodle-slot" ref={slotRef} />
      {banner && (
        <div className="moodle-banner">
          <span>Saved {banner.name} to Material — Insert into note</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onInsertPdf(banner.path);
              setBanner(null);
            }}
          >
            Insert into note
          </button>
          <button type="button" className="btn" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      </div>
    </aside>
  );
}

type FloatBox = { x: number; y: number; w: number; h: number };

function clampFloat(box: FloatBox): FloatBox {
  const w = Math.min(Math.max(220, window.innerWidth - 16), Math.max(220, box.w));
  const h = Math.min(Math.max(280, window.innerHeight - 16), Math.max(280, box.h));
  const x = Math.min(Math.max(0, box.x), Math.max(0, window.innerWidth - w));
  const y = Math.min(Math.max(0, box.y), Math.max(0, window.innerHeight - h));
  return { x, y, w, h };
}

function initialFloat(): FloatBox {
  const w = Math.min(560, Math.max(320, window.innerWidth - 80));
  const h = Math.min(720, Math.max(420, window.innerHeight - 80));
  return clampFloat({ x: window.innerWidth - w - 24, y: Math.round((window.innerHeight - h) / 2), w, h });
}

/** Draggable Moodle window. The page itself is the child webview over the slot, so the title strip stays above it. */
export function MoodleFloat({
  notebookPath,
  notebookName,
  onClose,
  onDock,
  onToast,
  preservePage = false,
}: {
  notebookPath: string;
  notebookName: string;
  onClose: () => void;
  /** Put the window back beside the note. */
  onDock: () => void;
  onToast: (message: string) => void;
  /** Keep the page that was already open, instead of jumping back to the course start. */
  preservePage?: boolean;
}) {
  const [box, setBox] = useState(initialFloat);
  const [nonce, setNonce] = useState(0);
  const frame = useRef(0);
  const bump = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setNonce((n) => n + 1);
    });
  };
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = box;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setBox(clampFloat({ ...origin, x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) }));
      bump();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = box;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setBox(clampFloat({ ...origin, w: origin.w + (ev.clientX - startX), h: origin.h + (ev.clientY - startY) }));
      bump();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <div className="moodle-float" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      <div className="moodle-float-bar" onPointerDown={drag}>
        <span className="moodle-float-title">{notebookName}</span>
        <button
          type="button"
          className="btn icon"
          title="Put back beside the note"
          aria-label="Put back"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDock}
        >
          <IcDock size={15} />
        </button>
        <button
          type="button"
          className="btn icon"
          title="Close"
          aria-label="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <IcClose size={15} />
        </button>
      </div>
      <div className="moodle-float-body">
        <MoodlePane
          floating
          preservePage={preservePage}
          layoutNonce={nonce}
          notebookPath={notebookPath}
          notebookName={notebookName}
          onClose={onClose}
          onInsertPdf={(path) => {
            if (!insertMoodlePdf(path)) onToast("Open the note to add this file.");
          }}
        />
      </div>
      <div className="moodle-float-foot">
        <div className="moodle-float-resize" title="Drag to resize" onPointerDown={resize} />
      </div>
    </div>
  );
}

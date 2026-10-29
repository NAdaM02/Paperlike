import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, DetectedItem, HomeTile, SearchHit, Settings } from "./api";
import { QuickAskField, QuickSeed } from "./QuickAsk";
import { messages } from "./copy/messages";
import { TrialMeter } from "./customer";
import {
  ConfirmDialog,
  ConfirmState,
  ContextMenu,
  MenuItem,
  Modal,
  PromptDialog,
  PromptState,
  coverGradient,
  pickLocalImage,
} from "./ui";
import {
  IcAsk,
  IcBook,
  IcBrief,
  IcChevron,
  IcDoc,
  IcFolder,
  IcGrid,
  IcImage,
  IcPlus,
  IcRadar,
  IcRename,
  IcSearch,
  IcSettings,
  IcTrash,
  IcUngroup,
} from "./icons";

/** Short group title from the two tiles that formed it. */
function makeGroupName(a: string, b: string): string {
  const left = (a || "Note").trim() || "Note";
  const right = (b || "Note").trim() || "Note";
  const joined = `${left} · ${right}`;
  return joined.length > 36 ? `${joined.slice(0, 33)}…` : joined;
}

const HOME_TILE_MIN = 112;
const HOME_TILE_MAX = 240;
const HOME_TILE_DEFAULT = 168;

function clampHomeTileSize(n: number): number {
  return Math.min(HOME_TILE_MAX, Math.max(HOME_TILE_MIN, Math.round(n)));
}

/** FLIP animate tiles after a layout change (size / column reflow). */
function flipHomeTiles(root: HTMLElement | null, apply: () => void) {
  if (!root) {
    apply();
    return;
  }
  const tiles = Array.from(root.querySelectorAll<HTMLElement>(".tile[data-path]"));
  const first = new Map(tiles.map((el) => [el.dataset.path!, el.getBoundingClientRect()]));
  apply();
  requestAnimationFrame(() => {
    for (const el of tiles) {
      const path = el.dataset.path;
      if (!path) continue;
      const a = first.get(path);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.classList.add("flip-animating");
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = "";
        const clear = () => {
          el.classList.remove("flip-animating");
          el.removeEventListener("transitionend", clear);
        };
        el.addEventListener("transitionend", clear);
        window.setTimeout(clear, 220);
      });
    }
  });
}

type HomeItemJson =
  | { kind: "notebook"; path: string }
  | { kind: "note"; path: string }
  | { kind: "group"; name: string; items: HomeItemJson[] };

type Props = {
  onOpenNotebook: (path: string) => void;
  onOpenStandalone: (path: string) => void;
  onToast: (msg: string) => void;
  onOpenSearch: () => void;
  onBlankNote: () => void;
  onBrief: () => void;
  onAsk: () => void;
  onQuickAsk: (seed: QuickSeed) => void;
  onCalc?: () => void;
  onAnalyze?: () => void;
  onOpenSettings: () => void;
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  /** Customer trial is over: open and look, do not create or rename. */
  expired?: boolean;
  /** Days left in the trial, shown beside the name. */
  trialDays?: number | null;
  onOpenLicense?: () => void;
  /** Open this notebook's Moodle course in a floating window. */
  onOpenCourseMoodle?: (path: string, name: string) => void;
  /** Bumped by the app when Home changed outside this view (study setup, new notes). */
  reloadKey?: number;
};

type DetectRow = DetectedItem & { checked: boolean };
type DetectState = DetectRow[] | "scanning" | "scanning-full" | null;
type ScanProgress = { walked: number; found: number; path: string };

export function HomeView({
  onOpenNotebook,
  onOpenStandalone,
  onToast,
  onOpenSearch,
  onBlankNote,
  onBrief,
  onAsk,
  onQuickAsk,
  onCalc,
  onAnalyze,
  onOpenSettings,
  settings,
  onSettingsChange,
  expired = false,
  trialDays = null,
  onOpenLicense,
  onOpenCourseMoodle,
  reloadKey = 0,
}: Props) {
  const [tiles, setTiles] = useState<HomeTile[]>([]);
  const [detect, setDetect] = useState<DetectState>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [groupOpen, setGroupOpen] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [tileSize, setTileSize] = useState(() =>
    clampHomeTileSize(settings.home_tile_size ?? HOME_TILE_DEFAULT),
  );
  const dragRef = useRef<{
    path: string;
    x: number;
    y: number;
    cx: number;
    cy: number;
    active: boolean;
    pointerId: number;
    group?: string;
  } | null>(null);
  const dropHintRef = useRef<{ path: string; zone: "before" | "after" | "into" } | null>(null);
  const suppressClick = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const tileSizeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingPathRef = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{ path: string; zone: "before" | "after" | "into" } | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  useEffect(() => {
    draggingPathRef.current = draggingPath;
  }, [draggingPath]);

  useEffect(() => {
    setTileSize(clampHomeTileSize(settings.home_tile_size ?? HOME_TILE_DEFAULT));
  }, [settings.home_tile_size]);

  useEffect(
    () => () => {
      if (tileSizeSaveTimer.current) clearTimeout(tileSizeSaveTimer.current);
    },
    [],
  );

  const applyTileSize = useCallback(
    (raw: number) => {
      const next = clampHomeTileSize(raw);
      if (next === tileSize) return;
      const root = shellRef.current;
      // Set the CSS var synchronously so FLIP measures the reflowed layout.
      flipHomeTiles(draggingPathRef.current ? null : root, () => {
        root?.style.setProperty("--home-tile-min", `${next}px`);
        setTileSize(next);
      });

      const saved = { ...settings, home_tile_size: next };
      onSettingsChange(saved);
      if (tileSizeSaveTimer.current) clearTimeout(tileSizeSaveTimer.current);
      tileSizeSaveTimer.current = setTimeout(() => {
        void api.saveSettings(saved).catch((e) => onToast(String(e)));
      }, 280);
    },
    [tileSize, settings, onSettingsChange, onToast],
  );

  const setHint = (h: { path: string; zone: "before" | "after" | "into" } | null) => {
    dropHintRef.current = h;
    setDropHint(h);
  };

  const refresh = useCallback(async () => {
    try {
      setTiles(await api.getHomeTiles());
    } catch (e) {
      onToast(String(e));
    }
  }, [onToast]);

  useEffect(() => {
    refresh();
  }, [refresh, reloadKey]);

  useEffect(() => {
    if (!groupOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroupOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groupOpen]);

  /* ── adding ── */
  const addNotebooks = async () => {
    const sel = await openDialog({ directory: true, multiple: true, title: "Select notebook folders" });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    if (!paths.length) return;
    const infos = await api.classifyPaths(paths);
    const plain = infos.filter((i) => i.kind === "folder");
    const doAdd = async () => {
      await api.addToHome(paths, true);
      await refresh();
      onToast(`Added ${paths.length} notebook(s)`);
    };
    if (plain.length) {
      setConfirm({
        title: plain.length === 1 ? "Make this folder a notebook?" : `Make ${plain.length} folders notebooks?`,
        message: "Paperlike will create a .notebook_data file inside so the folder becomes a notebook.",
        okLabel: "Make notebook",
        onOk: doAdd,
      });
    } else {
      await doAdd();
    }
  };

  const addNotes = async () => {
    const sel = await openDialog({
      multiple: true,
      title: "Select notes",
      filters: [{ name: "Paperlike notes", extensions: ["note"] }],
    });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    if (!paths.length) return;
    await api.addToHome(paths, false);
    await refresh();
    onToast(`Added ${paths.length} note(s)`);
  };

  const newNotebook = async () => {
    const parent = await openDialog({ directory: true, title: "Where should the notebook live?" });
    if (!parent || Array.isArray(parent)) return;
    setPrompt({
      title: "New notebook",
      label: "Name",
      initial: "My notebook",
      okLabel: "Create",
      onOk: async (name) => {
        if (!name.trim()) return;
        const p = await api.createNotebook(parent, name.trim());
        await refresh();
        onToast("Notebook created");
        onOpenNotebook(p);
      },
    });
  };

  /* ── detect ── */
  useEffect(() => {
    if (detect !== "scanning" && detect !== "scanning-full") {
      setScanProgress(null);
      return;
    }
    let dead = false;
    let off: (() => void) | undefined;
    void listen<ScanProgress>("detect-progress", (ev) => {
      if (!dead) setScanProgress(ev.payload);
    }).then((un) => {
      if (dead) un();
      else off = un;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, [detect]);

  const runDetect = async () => {
    setScanProgress(null);
    setDetect("scanning");
    try {
      const items = await api.detectNotes();
      setDetect(items.map((i) => ({ ...i, checked: !i.ignored })));
    } catch (e) {
      setDetect(null);
      onToast(String(e));
    }
  };

  const runFullScan = async () => {
    const previous = Array.isArray(detect) ? detect : [];
    setScanProgress(null);
    setDetect("scanning-full");
    try {
      const items = await invoke<DetectedItem[]>("detect_notes_full_scan");
      const merged = new Map(previous.map((row) => [row.path, row]));
      for (const item of items) {
        if (!merged.has(item.path)) {
          merged.set(item.path, { ...item, checked: !item.ignored });
        }
      }
      setDetect([...merged.values()]);
    } catch (e) {
      setDetect(previous);
      onToast(String(e));
    }
  };

  /* ── home.json manipulation ── */
  const loadItems = async (): Promise<HomeItemJson[]> => {
    const h = await api.getHome();
    return h.items as HomeItemJson[];
  };
  const saveItems = async (items: HomeItemJson[]) => {
    await api.saveHome({ version: 1, items: items as unknown[] });
    await refresh();
  };

  const keyOf = (it: HomeItemJson) => (it.kind === "group" ? `group:${it.name}` : it.path);

  const moveTile = async (fromKey: string, toKey: string, zone: "before" | "after" | "into") => {
    if (fromKey === toKey) return;
    try {
      const items = await loadItems();
      const fromIdx = items.findIndex((i) => keyOf(i) === fromKey);
      if (fromIdx < 0) return;
      const [moved] = items.splice(fromIdx, 1);
      const toIdx = items.findIndex((i) => keyOf(i) === toKey);
      if (toIdx < 0) {
        items.splice(fromIdx, 0, moved);
        return;
      }
      if (zone === "into" && moved.kind !== "group") {
        const target = items[toIdx];
        if (target.kind === "group") {
          target.items.push(moved);
        } else {
          const a =
            tiles.find((t) => t.kind !== "group" && t.path === target.path)?.name ?? "Note";
          const b =
            tiles.find((t) => t.kind !== "group" && t.path === moved.path)?.name ?? "Note";
          items[toIdx] = { kind: "group", name: makeGroupName(a, b), items: [target, moved] };
        }
      } else {
        const insertAt = zone === "before" ? toIdx : toIdx + 1;
        items.splice(insertAt, 0, moved);
      }
      await saveItems(items);
    } catch (e) {
      onToast(`Couldn't rearrange: ${e}`);
    }
  };

  const moveWithinGroup = async (
    groupName: string,
    fromPath: string,
    toPath: string,
    zone: "before" | "after",
  ) => {
    if (fromPath === toPath) return;
    try {
      const items = await loadItems();
      const g = items.find((i) => i.kind === "group" && i.name === groupName);
      if (!g || g.kind !== "group") return;
      const fromIdx = g.items.findIndex((i) => i.kind !== "group" && i.path === fromPath);
      if (fromIdx < 0) return;
      const [moved] = g.items.splice(fromIdx, 1);
      const toIdx = g.items.findIndex((i) => i.kind !== "group" && i.path === toPath);
      if (toIdx < 0) {
        g.items.splice(fromIdx, 0, moved);
        return;
      }
      const insertAt = zone === "before" ? toIdx : toIdx + 1;
      g.items.splice(insertAt, 0, moved);
      await saveItems(items);
    } catch (e) {
      onToast(`Couldn't rearrange: ${e}`);
    }
  };

  const removeFromGroup = async (groupName: string, path: string) => {
    try {
      const items = await loadItems();
      const g = items.find((i) => i.kind === "group" && i.name === groupName);
      if (!g || g.kind !== "group") return;
      const idx = g.items.findIndex((i) => i.kind !== "group" && i.path === path);
      if (idx < 0) return;
      const [moved] = g.items.splice(idx, 1);
      const gi = items.indexOf(g);
      items.splice(gi + 1, 0, moved);
      if (g.items.length <= 1) {
        if (g.items.length === 1) items.splice(items.indexOf(g), 1, g.items[0]);
        else items.splice(items.indexOf(g), 1);
        setGroupOpen(null);
      }
      await saveItems(items);
    } catch (e) {
      onToast(`Couldn't ungroup: ${e}`);
    }
  };

  const renameGroup = (oldName: string) => {
    setPrompt({
      title: "Rename group",
      label: "Group name",
      initial: oldName,
      onOk: async (name) => {
        if (!name.trim()) return;
        const items = await loadItems();
        const g = items.find((i) => i.kind === "group" && i.name === oldName);
        if (g && g.kind === "group") g.name = name.trim();
        await saveItems(items);
        if (groupOpen === oldName) setGroupOpen(name.trim());
      },
    });
  };

  /* ── tile actions ── */
  const tileMenu = (tile: HomeTile): MenuItem[] => {
    if (expired) {
      if (tile.kind === "group") {
        return [{ label: "Open group", icon: <IcGrid size={14} />, onClick: () => setGroupOpen(tile.name) }];
      }
      return [];
    }
    if (tile.kind === "group") {
      return [
        { label: "Open group", icon: <IcGrid size={14} />, onClick: () => setGroupOpen(tile.name) },
        { label: "Rename group", icon: <IcRename size={14} />, onClick: () => renameGroup(tile.name) },
      ];
    }
    const items: MenuItem[] = [];
    if (tile.missing) {
      items.push({
        label: "Locate…",
        icon: <IcFolder size={14} />,
        onClick: async () => {
          const sel = await openDialog(
            tile.kind === "notebook"
              ? { directory: true, title: "Locate notebook" }
              : { title: "Locate note", filters: [{ name: "Paperlike note", extensions: ["note"] }] },
          );
          if (!sel || Array.isArray(sel)) return;
          const items2 = await loadItems();
          const rewrite = (arr: HomeItemJson[]) => {
            for (const it of arr) {
              if (it.kind === "group") rewrite(it.items);
              else if (it.path === tile.path) it.path = sel;
            }
          };
          rewrite(items2);
          await saveItems(items2);
        },
      });
    }
    if (tile.kind === "notebook" && !tile.missing) {
      items.push(
        {
          label: "Rename",
          icon: <IcRename size={14} />,
          onClick: () =>
            setPrompt({
              title: "Rename notebook",
              label: "Renames the folder on disk",
              initial: tile.name,
              onOk: async (name) => {
                if (!name.trim() || name === tile.name) return;
                try {
                  await api.setNotebookMeta(tile.path, name.trim(), undefined);
                  await refresh();
                } catch (e) {
                  onToast(String(e));
                }
              },
            }),
        },
            {
              label: "Change cover",
              icon: <IcImage size={14} />,
              onClick: async () => {
            const imgs = await pickLocalImage(false);
            if (!imgs.length) return;
            try {
              await api.setNotebookCover(tile.path, imgs[0].b64);
              await refresh();
              onToast("Cover updated");
            } catch (e) {
              onToast(String(e));
            }
          },
        },
        {
          label: "Open Moodle for this course",
          icon: <IcBook size={14} />,
          onClick: () => onOpenCourseMoodle?.(tile.path, tile.name),
        },
        {
          label: "Change description",
          icon: <IcDoc size={14} />,
          onClick: () =>
            setPrompt({
              title: "Notebook description",
              label: "Shown when hovering the notebook on Home",
              initial: tile.description ?? "",
              multiline: true,
              onOk: async (d) => {
                await api.setNotebookMeta(tile.path, undefined, d);
                await refresh();
              },
            }),
        },
      );
    }
    if (tile.kind === "note" && !tile.missing) {
      items.push({
        label: "Rename",
        icon: <IcRename size={14} />,
        onClick: () =>
          setPrompt({
            title: "Rename note",
            initial: tile.name,
            onOk: async (name) => {
              if (!name.trim()) return;
              const newPath = await api.renameNote(tile.path, name.trim());
              const items2 = await loadItems();
              const rewrite = (arr: HomeItemJson[]) => {
                for (const it of arr) {
                  if (it.kind === "group") rewrite(it.items);
                  else if (it.path === tile.path) it.path = newPath;
                }
              };
              rewrite(items2);
              await saveItems(items2);
            },
          }),
      });
    }
    if (items.length) items.push("sep");
    items.push({
      label: "Remove from Home",
      icon: <IcTrash size={14} />,
      danger: true,
      onClick: async () => {
        if (tile.kind === "group") return;
        await api.removeFromHome(tile.path);
        await refresh();
      },
    });
    return items;
  };

  const openTile = (tile: HomeTile) => {
    if (tile.kind === "group") {
      setGroupOpen(tile.name);
      return;
    }
    if (tile.missing) {
      onToast("Missing on disk — right-click to locate or remove");
      return;
    }
    if (tile.kind === "notebook") onOpenNotebook(tile.path);
    else onOpenStandalone(tile.path);
  };

  /* ── pointer drag (HTML5 DnD is unreliable in WebView2) ── */
  const zoneAt = (
    clientX: number,
    el: HTMLElement,
    allowInto: boolean,
  ): "before" | "after" | "into" => {
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    if (allowInto && rel > 0.33 && rel < 0.67) return "into";
    return rel <= 0.5 ? "before" : "after";
  };

  const tileUnderPoint = (clientX: number, clientY: number, group?: string): HTMLElement | null => {
    const sel = group ? ".group-grid .tile[data-path]" : ".home-grid .tile[data-path]";
    const nodes = document.querySelectorAll<HTMLElement>(sel);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return el;
      }
    }
    return null;
  };

  const updateDropTarget = (clientX: number, clientY: number, fromPath: string, group?: string) => {
    const best = tileUnderPoint(clientX, clientY, group);
    const path = best?.dataset.path;
    if (!best || !path || path === fromPath) {
      if (dropHintRef.current) setHint(null);
      return;
    }
    const zone = zoneAt(clientX, best, !group);
    const prev = dropHintRef.current;
    if (!prev || prev.path !== path || prev.zone !== zone) setHint({ path, zone });
  };

  const endDrag = async () => {
    const d = dragRef.current;
    dragRef.current = null;
    const hint = dropHintRef.current;
    setDraggingPath(null);
    setHint(null);
    if (!d?.active) return;
    suppressClick.current = true;
    if (d.group) {
      if (hint && hint.path !== d.path) {
        await moveWithinGroup(
          d.group,
          d.path,
          hint.path,
          hint.zone === "before" ? "before" : "after",
        );
      } else if (!tileUnderPoint(d.cx, d.cy, d.group)) {
        // Dropped on empty group chrome → remove from group.
        await removeFromGroup(d.group, d.path);
      }
      return;
    }
    if (hint && hint.path !== d.path) await moveTile(d.path, hint.path, hint.zone);
  };

  const renderTile = (tile: HomeTile, inGroup?: string) => (
    <div
      key={tile.path}
      data-path={tile.path}
      role="button"
      tabIndex={0}
      aria-label={tile.name || "Untitled"}
      className={[
        "tile",
        tile.missing ? "missing" : "",
        draggingPath === tile.path ? "dragging" : "",
        dropHint?.path === tile.path
          ? `drop-${inGroup && dropHint.zone === "into" ? "after" : dropHint.zone}`
          : "",
      ].join(" ")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTile(tile);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button, input, a")) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        dragRef.current = {
          path: tile.path,
          x: e.clientX,
          y: e.clientY,
          cx: e.clientX,
          cy: e.clientY,
          active: false,
          pointerId: e.pointerId,
          group: inGroup,
        };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId || d.path !== tile.path) return;
        d.cx = e.clientX;
        d.cy = e.clientY;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.active) {
          if (dx * dx + dy * dy < 49) return;
          d.active = true;
          suppressClick.current = true;
          setDraggingPath(d.path);
        }
        updateDropTarget(e.clientX, e.clientY, d.path, d.group);
      }}
      onPointerUp={async (e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId || d.path !== tile.path) return;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        d.cx = e.clientX;
        d.cy = e.clientY;
        const wasDrag = d.active;
        await endDrag();
        if (!wasDrag && !suppressClick.current) openTile(tile);
        if (wasDrag) {
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
      }}
      onPointerCancel={() => {
        void endDrag();
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY, items: tileMenu(tile) });
      }}
    >
      <div className="tile-cover" style={{ background: coverGradient(tile.name) }}>
        {tile.kind === "group" ? (
          <div className="mosaic">
            {(tile.group_items ?? []).slice(0, 4).map((g) => (
              <div key={g.path} style={{ background: coverGradient(g.name) }}>
                {g.cover_png_base64 ? (
                  <img src={`data:image/png;base64,${g.cover_png_base64}`} alt="" draggable={false} />
                ) : g.kind === "note" ? (
                  <IcDoc size={16} />
                ) : (
                  <IcBook size={16} />
                )}
              </div>
            ))}
          </div>
        ) : tile.cover_png_base64 ? (
          <img src={`data:image/png;base64,${tile.cover_png_base64}`} alt="" draggable={false} />
        ) : (
          <div className="fallback">{tile.kind === "note" ? <IcDoc size={34} /> : <IcBook size={34} />}</div>
        )}
        {tile.missing && <span className="tile-badge">missing</span>}
        {inGroup && (
          <button
            type="button"
            className="tile-ungroup"
            title="Remove from group"
            aria-label="Remove from group"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void removeFromGroup(inGroup, tile.path);
            }}
          >
            <IcUngroup size={14} />
          </button>
        )}
      </div>
      <div className="tile-name">{tile.name || "Untitled"}</div>
      {tile.description && !inGroup && <div className="tile-tip">{tile.description}</div>}
    </div>
  );

  const groupTiles = groupOpen
    ? tiles.find((t) => t.kind === "group" && t.name === groupOpen)?.group_items ?? []
    : [];

  const tileMinStyle = { ["--home-tile-min" as string]: `${tileSize}px` };

  return (
    <div className="app-shell" ref={shellRef} style={tileMinStyle}>
      {expired && <div className="expiry-banner">{messages.expiredBanner}</div>}
      <div className="topbar">
        <div className="topbar-start">
          <div className="brand">
            Paperlike
            {trialDays != null && onOpenLicense && <TrialMeter days={trialDays} onOpen={onOpenLicense} />}
          </div>
          <button
            className="btn primary"
            data-tour="home-blank"
            onClick={onBlankNote}
            disabled={expired}
            title={expired ? messages.expiredBanner : "Start a new note"}
          >
            <IcPlus size={15} /> New note
          </button>
          <button
            className="btn outline"
            data-tour="home-add"
            disabled={expired}
            title={expired ? messages.expiredBanner : "Add, create, or find notes and notebooks"}
            onClick={(e) => {
              if (expired) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setAddMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <IcPlus size={15} /> Add
            <IcChevron size={12} />
          </button>
        </div>
        <div className="topbar-end">
          <label className="home-tile-size" title="Notebook size">
            <IcGrid size={14} />
            <input
              type="range"
              min={HOME_TILE_MIN}
              max={HOME_TILE_MAX}
              step={8}
              value={tileSize}
              aria-label="Notebook size"
              onChange={(e) => applyTileSize(Number(e.target.value))}
            />
          </label>
          <button className="btn icon" title="Search everywhere (Ctrl+Shift+F)" aria-label="Search everywhere" onClick={onOpenSearch}>
            <IcSearch size={16} />
          </button>
          <QuickAskField onAsk={onQuickAsk} onCalc={onCalc} onAnalyze={onAnalyze} disabled={expired} />
          <button
            className="btn outline"
            title={expired ? messages.premiumOff : "Study sheets and quizzes from several notes"}
            disabled={expired}
            data-tour="home-ask"
            onClick={onBrief}
          >
            <IcBrief size={15} /> Brief
          </button>
          <button
            className="btn outline"
            data-tour="home-ask"
            title={expired ? messages.premiumOff : "Chat beside your notes — attaches what you have open (Ctrl+J)"}
            disabled={expired}
            onClick={onAsk}
          >
            <IcAsk size={15} /> Ask
          </button>
          <button className="btn icon" data-tour="home-settings" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
            <IcSettings size={16} />
          </button>
        </div>
      </div>

      {!!tiles.length && (
        <p className="home-grid-hint">{messages.homeDragHint}</p>
      )}

      <div className="home-scroll">
        <div className="grid home-grid" data-tour="home-grid">
          {tiles.map((t) => renderTile(t))}
        </div>
        {!tiles.length && (
          <div className="empty-state">
            <div className="big empty-icon" aria-hidden>
              <IcBook size={40} />
            </div>
            <div>
              Nothing on Home yet. Start a new note, create a notebook, or scan your drive.{" "}
              {messages.homeDragHint}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={onBlankNote} disabled={expired}>
                <IcPlus size={15} /> New note
              </button>
              <button className="btn outline" onClick={newNotebook} disabled={expired}>
                <IcPlus size={15} /> New notebook
              </button>
              <button className="btn outline" onClick={runDetect} disabled={expired}>
                <IcRadar size={15} /> Detect
              </button>
            </div>
          </div>
        )}
      </div>

      {/* add dropdown */}
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            { label: "New notebook…", icon: <IcPlus size={14} />, onClick: newNotebook },
            { label: "New note", icon: <IcPlus size={14} />, onClick: onBlankNote },
            "sep",
            { label: "Add notebook folders…", icon: <IcFolder size={14} />, onClick: addNotebooks },
            { label: "Add .note files…", icon: <IcDoc size={14} />, onClick: addNotes },
            "sep",
            { label: "Detect notes and notebooks…", icon: <IcRadar size={14} />, onClick: runDetect },
          ]}
        />
      )}

      {/* detect modal */}
      {detect && (
        <Modal
          title="Detect notes and notebooks"
          onClose={() => setDetect(null)}
          actions={
            detect !== "scanning" &&
            detect !== "scanning-full" && (
              <>
                <button className="btn outline" onClick={() => setDetect(null)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  disabled={!detect.length}
                  onClick={async () => {
                    const add = detect.filter((d) => d.checked);
                    const ignore = detect.filter((d) => !d.checked).map((d) => d.path);
                    setDetect(null);
                    await api.applyDetect(add, ignore);
                    await refresh();
                    onToast(`Added ${add.length}, ignored ${ignore.length}`);
                  }}
                >
                  Add selected
                </button>
              </>
            )
          }
        >
          {detect === "scanning" || detect === "scanning-full" ? (
            <div className="detect-progress">
              <p className="muted" style={{ marginTop: 0 }}>
                {detect === "scanning-full"
                  ? "Scanning the whole computer, this can take a minute…"
                  : "Scanning your user profile for .note and .notebook_data files…"}
              </p>
              {scanProgress ? (
                <>
                  <p className="detect-progress-stats">
                    Checked {scanProgress.walked.toLocaleString()} items
                    {scanProgress.found ? ` · found ${scanProgress.found}` : ""}
                  </p>
                  <p className="detect-progress-path" title={scanProgress.path}>
                    {scanProgress.path}
                  </p>
                </>
              ) : (
                <p className="detect-progress-stats">Starting…</p>
              )}
            </div>
          ) : (
            <>
              {detect.length ? (
                <>
                  <p className="muted small" style={{ marginTop: 0 }}>
                    Unchecked items are remembered and stay unchecked in future scans.
                  </p>
                  {detect.map((d) => (
                    <label key={d.path} className="detect-row">
                      <input
                        type="checkbox"
                        checked={d.checked}
                        onChange={(e) =>
                          setDetect((all) =>
                            !Array.isArray(all)
                              ? all
                              : all.map((x) => (x.path === d.path ? { ...x, checked: e.target.checked } : x)),
                          )
                        }
                      />
                      {d.kind === "notebook" ? <IcBook size={16} /> : <IcDoc size={16} />}
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{d.name}</div>
                        <div className="pathline">{d.path}</div>
                      </span>
                    </label>
                  ))}
                </>
              ) : (
                <p className="muted">Nothing new found.</p>
              )}
              <div style={{ marginTop: 14 }}>
                <button type="button" className="btn outline" onClick={runFullScan}>
                  <IcRadar size={15} /> Scan entire PC (slower)
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* group overlay */}
      {groupOpen && (
        <div
          className="group-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setGroupOpen(null);
          }}
        >
          <div className="group-panel" role="dialog" aria-label={groupOpen}>
            <header className="group-panel-head">
              <div className="group-panel-titles">
                <h2>{groupOpen}</h2>
                <p>
                  {groupTiles.length} item{groupTiles.length === 1 ? "" : "s"} · drag to reorder ·
                  drop on empty space to remove
                </p>
              </div>
              <div className="group-panel-actions">
                <button className="btn outline" onClick={() => renameGroup(groupOpen)}>
                  <IcRename size={14} /> Rename
                </button>
                <button className="btn primary" onClick={() => setGroupOpen(null)}>
                  Done
                </button>
              </div>
            </header>
            <div className="group-grid">
              {groupTiles.map((t) => renderTile(t, groupOpen))}
              {!groupTiles.length && (
                <div className="group-empty">
                  <div className="big empty-icon" aria-hidden>
                    <IcGrid size={36} />
                  </div>
                  <div>This group is empty</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <PromptDialog state={prompt} onClose={() => setPrompt(null)} />
    </div>
  );
}

/* ─── global search ────────────────────────────────────────────────────── */

export function GlobalSearchModal({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (hit: SearchHit, query: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) {
        setHits([]);
        return;
      }
      setBusy(true);
      try {
        setHits(await api.searchGlobal(q));
      } catch (e) {
        console.error(e);
      } finally {
        setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Modal title="Search everywhere" onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search all notes on Home…"
        style={{ width: "100%", marginBottom: 12 }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits.length) onOpen(hits[0], q);
        }}
      />
      {busy && <p className="muted small">Searching…</p>}
      {hits.map((h) => (
        <button
          key={h.note_path}
          className="btn"
          style={{ display: "flex", width: "100%", textAlign: "left", marginBottom: 4, flexDirection: "column", alignItems: "flex-start", gap: 2 }}
          onClick={() => onOpen(h, q)}
        >
          <span>
            <b>{h.note_title || "Untitled"}</b>
            <span className="muted"> — {h.notebook_name}</span>
          </span>
          <span className="muted small">{h.snippet}</span>
        </button>
      ))}
      {!busy && q.trim() && !hits.length && <p className="muted">No matches.</p>}
    </Modal>
  );
}

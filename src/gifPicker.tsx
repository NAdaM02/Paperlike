import { useEffect, useRef, useState } from "react";
import { api, type GifHit } from "./api";
import { IcClose, IcSearch } from "./icons";

/**
 * Discord-style GIF browser. Previews load straight from the host.
 * Choosing one downloads the file into the note.
 */
export function GifPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (hit: GifHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GifHit[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState("");
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  useEffect(() => {
    let cancel = false;
    const handle = window.setTimeout(() => {
      setBusy(true);
      setErr("");
      api
        .gifSearch(q)
        .then((rows) => {
          if (cancel) return;
          setHits(rows);
          setBusy(false);
        })
        .catch((e: unknown) => {
          if (cancel) return;
          setHits([]);
          setBusy(false);
          const text = (e instanceof Error ? e.message : typeof e === "string" ? e : "").trim();
          setErr(text || "Couldn't load GIFs.");
        });
    }, q.trim() ? 220 : 0);
    return () => {
      cancel = true;
      window.clearTimeout(handle);
    };
  }, [q]);

  const paste = () => {
    const raw = url.trim();
    if (!raw) return;
    onPick({ id: "url", preview: raw, url: raw, w: 0, h: 0 });
  };

  return (
    <div className="gif-root" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="tool-wheel-back" aria-label="Close GIFs" onClick={onClose} />
      <div className="gif-panel" role="dialog" aria-label="Add a GIF">
        <div className="gif-search">
          <IcSearch size={15} />
          <input
            ref={box}
            value={q}
            placeholder="Search GIFs"
            aria-label="Search GIFs"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <button type="button" className="btn icon" title="Close" onClick={onClose}>
            <IcClose size={14} />
          </button>
        </div>
        <div className="gif-grid">
          {busy && !hits.length ? <p className="gif-status">Looking…</p> : null}
          {!busy && err ? <p className="gif-status">{err}</p> : null}
          {!busy && !err && !hits.length ? <p className="gif-status">No GIFs for that.</p> : null}
          {hits.map((h) => (
            <button key={h.id} type="button" className="gif-cell" title="Add this GIF" onClick={() => onPick(h)}>
              <img src={h.preview || h.url} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <form
          className="gif-url"
          onSubmit={(e) => {
            e.preventDefault();
            paste();
          }}
        >
          <input
            value={url}
            placeholder="Or paste a GIF link"
            aria-label="GIF link"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="btn" disabled={!url.trim()}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

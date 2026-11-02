import { memo } from "react";
import { FileObject, newId } from "./api";

/** File chips: any file embedded in a note — specs/editor.md §2.7. */

export const FILE_CHIP_H = 52;
/** Largest file a note embeds. Matches MAX_FILE in attachments.rs. */
export const FILE_MAX_BYTES = 100 * 1024 * 1024;
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

export function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** File size the way Explorer shows it. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Wide enough for the name on one line, within a comfortable range. */
export function fileChipWidth(name: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  let text = name.length * 7.4;
  if (measureCtx) {
    measureCtx.font = '500 13px "Segoe UI", system-ui, sans-serif';
    text = measureCtx.measureText(name).width;
  }
  return Math.round(Math.min(320, Math.max(184, 12 + 30 + 12 + text + 16)));
}

export function makeFileObject(name: string, size: number, x: number, y: number, z: number): FileObject {
  const width = fileChipWidth(name);
  return {
    type: "file",
    id: newId("f"),
    x: Math.round(x - width / 2),
    y: Math.round(y),
    z,
    media: `media/${newId("m").slice(2)}.${fileExt(name) || "bin"}`,
    name,
    size,
    width,
    height: FILE_CHIP_H,
  };
}

export const FileChip = memo(function FileChip({
  obj,
  selected,
  onPointerDown,
}: {
  obj: FileObject;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const ext = fileExt(obj.name).toUpperCase();
  return (
    <div
      data-oid={obj.id}
      className={`file-chip ${selected ? "selected" : ""}`}
      style={{ left: obj.x, top: obj.y, width: obj.width, height: obj.height, zIndex: 2 + obj.z }}
      onPointerDown={onPointerDown}
      title={obj.name}
    >
      <span className="file-chip-icon" aria-hidden>
        <svg viewBox="0 0 30 36" width="30" height="36">
          <path d="M4.5 1.5h14l7 7v24a2 2 0 0 1-2 2h-19a2 2 0 0 1-2-2v-29a2 2 0 0 1 2-2Z" />
          <path d="M18.5 1.5v5a2 2 0 0 0 2 2h5" />
        </svg>
        {ext && <span className={`file-chip-ext ${ext.length > 3 ? "long" : ""}`}>{ext.slice(0, 4)}</span>}
      </span>
      <span className="file-chip-text">
        <span className="file-chip-name">{obj.name}</span>
        <span className="file-chip-meta">{fileSizeLabel(obj.size)}</span>
      </span>
    </div>
  );
});

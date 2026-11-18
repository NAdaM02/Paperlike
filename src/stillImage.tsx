import { useEffect, useRef } from "react";

/** GIF bytes in base64 start with GIF87a / GIF89a. */
export function isGifBase64(b64: string): boolean {
  return b64.startsWith("R0lGO");
}

/** WebP bytes in base64 start with RIFF. */
export function isWebpBase64(b64: string): boolean {
  return b64.startsWith("UklG");
}

/** A GIF or an animated WebP: still on the first frame in previews, moving in the editor. */
export function isMotionBase64(b64: string): boolean {
  return isGifBase64(b64) || isWebpBase64(b64);
}

/** Mime for embedded picture bytes, so a WebP is not served as a GIF. */
export function imageMime(b64: string): string {
  if (isGifBase64(b64)) return "image/gif";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (isWebpBase64(b64)) return "image/webp";
  if (b64.startsWith("Qk")) return "image/bmp";
  return "image/png";
}

export function imageDataUrl(b64: string): string {
  return `data:${imageMime(b64)};base64,${b64}`;
}

/**
 * PDF preview keeps a GIF on its first frame, the way an export does.
 * The note editor keeps using a normal image so the GIF still moves.
 */
export function StillImage({
  b64,
  style,
  className,
}: {
  b64: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const still = isMotionBase64(b64);
  useEffect(() => {
    if (!still) return;
    const img = new Image();
    img.onload = () => {
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = imageDataUrl(b64);
  }, [b64, still]);
  if (!still) {
    return <img className={className} src={imageDataUrl(b64)} alt="" draggable={false} style={style} />;
  }
  return <canvas ref={ref} className={className} style={style} />;
}

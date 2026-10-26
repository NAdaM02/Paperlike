import { useEffect, useRef } from "react";

/** GIF bytes in base64 start with GIF87a / GIF89a. */
export function isGifBase64(b64: string): boolean {
  return b64.startsWith("R0lGO");
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
  const gif = isGifBase64(b64);
  useEffect(() => {
    if (!gif) return;
    const img = new Image();
    img.onload = () => {
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = `data:image/gif;base64,${b64}`;
  }, [b64, gif]);
  if (!gif) {
    return <img className={className} src={`data:image/*;base64,${b64}`} alt="" draggable={false} style={style} />;
  }
  return <canvas ref={ref} className={className} style={style} />;
}

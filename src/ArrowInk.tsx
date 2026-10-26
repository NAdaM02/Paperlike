import type { ArrowItem } from "./drawGeom";
import { arrowDraw } from "./drawGeom";

/** Shaft plus tip. Shared by the canvas, the live drag, and PDF preview. */
export function ArrowInk({
  item,
  hit = false,
}: {
  item: Pick<ArrowItem, "tail" | "head" | "c1" | "c2" | "shaft" | "width" | "color" | "head_style" | "body">;
  hit?: boolean;
}) {
  const g = arrowDraw(item);
  const strokeWidth = item.body === "double" ? Math.max(0.6, item.width * 0.5) : item.width;
  return (
    <>
      {g.shafts.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={item.color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {g.headFill && <polygon points={g.headFill} fill={item.color} />}
      {g.headOpen?.map((seg, i) => (
        <line
          key={`o${i}`}
          x1={seg[0][0]}
          y1={seg[0][1]}
          x2={seg[1][0]}
          y2={seg[1][1]}
          stroke={item.color}
          strokeWidth={Math.max(1.25, item.width * 0.95)}
          strokeLinecap="round"
        />
      ))}
      {hit &&
        g.shafts.map((d, i) => (
          <path
            key={`h${i}`}
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(14, item.width * 3)}
            strokeLinecap="round"
          />
        ))}
    </>
  );
}

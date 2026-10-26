import { CanvasObject, GroupObject } from "./api";

export const GROUP_PAD = 14;
export const GROUP_MIN_W = 160;
export const GROUP_MIN_H = 64;

type Box = { x: number; y: number; w: number; h: number };
type BoxOf = (o: CanvasObject) => Box;

/** Display frame: the stored rectangle, grown to wrap every child (plus padding). */
export function groupFrame(g: GroupObject, objects: CanvasObject[], box: BoxOf): Box {
  let x1 = g.x;
  let y1 = g.y;
  let x2 = g.x + Math.max(GROUP_MIN_W, g.width);
  let y2 = g.y + Math.max(GROUP_MIN_H, g.min_height ?? 0);
  for (const id of g.children ?? []) {
    const o = objects.find((c) => c.id === id);
    if (!o || o.type === "group") continue;
    const b = box(o);
    x1 = Math.min(x1, b.x - GROUP_PAD);
    y1 = Math.min(y1, b.y - GROUP_PAD);
    x2 = Math.max(x2, b.x + b.w + GROUP_PAD);
    y2 = Math.max(y2, b.y + b.h + GROUP_PAD);
  }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

/** Topmost expanded fold containing the point, if any. */
export function groupAtPoint(objects: CanvasObject[], x: number, y: number, box: BoxOf): string | null {
  let best: GroupObject | null = null;
  for (const o of objects) {
    if (o.type !== "group" || o.collapsed) continue;
    const f = groupFrame(o, objects, box);
    if (x >= f.x && y >= f.y && x <= f.x + f.w && y <= f.y + f.h) {
      if (!best || o.z >= best.z) best = o;
    }
  }
  return best?.id ?? null;
}

/**
 * An object drawn under an expanded fold: its centre lies in that fold, and the
 * fold does not own it. Clicks and marquees on the field must not select it.
 */
export function blockedByFold(objects: CanvasObject[], o: CanvasObject, box: BoxOf): boolean {
  if (o.type === "group") return false;
  const b = box(o);
  const top = groupAtPoint(objects, b.x + b.w / 2, b.y + b.h / 2, box);
  return !!top && groupOf(objects, o.id) !== top;
}

export function groupOf(objects: CanvasObject[], id: string): string | null {
  for (const o of objects) {
    if (o.type === "group" && (o.children ?? []).includes(id)) return o.id;
  }
  return null;
}

/** Ids hidden because their fold is collapsed. */
export function collapsedIds(objects: CanvasObject[]): Set<string> {
  const hidden = new Set<string>();
  for (const o of objects) {
    if (o.type === "group" && o.collapsed) {
      for (const id of o.children ?? []) hidden.add(id);
    }
  }
  return hidden;
}

export function withChild(objects: CanvasObject[], childId: string, groupId: string | null): CanvasObject[] {
  return objects.map((o) => {
    if (o.type !== "group") return o;
    const kids = o.children ?? [];
    const has = kids.includes(childId);
    if (o.id === groupId) return has ? o : { ...o, children: [...kids, childId] };
    return has ? { ...o, children: kids.filter((id) => id !== childId) } : o;
  });
}

/** Drop child ids that no longer exist. */
export function pruneGroups(objects: CanvasObject[]): CanvasObject[] {
  const ids = new Set(objects.map((o) => o.id));
  let changed = false;
  const next = objects.map((o) => {
    if (o.type !== "group") return o;
    const kids = o.children ?? [];
    const children = kids.filter((id) => ids.has(id));
    if (children.length === kids.length) return o;
    changed = true;
    return { ...o, children };
  });
  return changed ? next : objects;
}

/** Append `obj`, parenting it to the fold under (x, y) when there is one. */
export function placeNew(objects: CanvasObject[], obj: CanvasObject, x: number, y: number, box: BoxOf): CanvasObject[] {
  if (obj.type === "group") return pruneGroups([...objects, obj]);
  const gid = groupAtPoint(objects, x, y, box);
  const base = gid ? withChild(objects, obj.id, gid) : objects;
  return pruneGroups([...base, obj]);
}

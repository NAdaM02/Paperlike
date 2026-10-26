/** DOM helpers for OneNote-style table editing inside a contentEditable root. */

export const EMPTY_CELL = '<div class="p"><br></div>';
export const MIN_COL_WIDTH = 40;

export type CellCoord = { row: number; col: number };

export function cellCoord(td: HTMLTableCellElement): CellCoord | null {
  const tr = td.parentElement as HTMLTableRowElement | null;
  const table = td.closest("table");
  if (!tr || !table) return null;
  const rows = [...table.querySelectorAll("tbody tr, :scope > tr")];
  const row = rows.indexOf(tr);
  const col = [...tr.children].indexOf(td);
  if (row < 0 || col < 0) return null;
  return { row, col };
}

export function tableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const body = table.tBodies[0];
  return body ? [...body.rows] : [...table.rows];
}

export function cellAt(
  table: HTMLTableElement,
  row: number,
  col: number,
): HTMLTableCellElement | null {
  const tr = tableRows(table)[row];
  if (!tr) return null;
  return (tr.cells[col] as HTMLTableCellElement | undefined) ?? null;
}

export function clearCell(td: HTMLTableCellElement) {
  td.innerHTML = EMPTY_CELL;
}

export function clearCells(cells: HTMLTableCellElement[]) {
  cells.forEach(clearCell);
}

export function selectedCells(
  table: HTMLTableElement,
  a: CellCoord,
  b: CellCoord,
): HTMLTableCellElement[] {
  const r0 = Math.min(a.row, b.row);
  const r1 = Math.max(a.row, b.row);
  const c0 = Math.min(a.col, b.col);
  const c1 = Math.max(a.col, b.col);
  const out: HTMLTableCellElement[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const td = cellAt(table, r, c);
      if (td) out.push(td);
    }
  }
  return out;
}

export function applyCellSelection(
  table: HTMLTableElement,
  a: CellCoord | null,
  b: CellCoord | null,
) {
  table.querySelectorAll("td.plt-sel").forEach((td) => td.classList.remove("plt-sel"));
  if (!a || !b) return;
  selectedCells(table, a, b).forEach((td) => td.classList.add("plt-sel"));
}

export function clearAllTableSelections(root: ParentNode) {
  root.querySelectorAll("td.plt-sel").forEach((td) => td.classList.remove("plt-sel"));
}

function ensureColgroup(table: HTMLTableElement, cols: number) {
  let cg = table.querySelector("colgroup");
  if (!cg) {
    cg = document.createElement("colgroup");
    table.insertBefore(cg, table.firstChild);
  }
  while (cg.children.length < cols) {
    const col = document.createElement("col");
    col.style.width = "120px";
    cg.appendChild(col);
  }
  while (cg.children.length > cols) cg.lastElementChild?.remove();
  return cg;
}

function colCount(table: HTMLTableElement): number {
  const rows = tableRows(table);
  if (!rows.length) return 0;
  return Math.max(...rows.map((r) => r.cells.length), 0);
}

export function insertRow(table: HTMLTableElement, index: number): HTMLTableRowElement | null {
  const rows = tableRows(table);
  const cols = colCount(table);
  if (!cols) return null;
  const body = table.tBodies[0] ?? table;
  const tr = document.createElement("tr");
  for (let i = 0; i < cols; i++) {
    const td = document.createElement("td");
    td.contentEditable = "true";
    td.innerHTML = EMPTY_CELL;
    tr.appendChild(td);
  }
  const before = rows[index] ?? null;
  if (before) body.insertBefore(tr, before);
  else body.appendChild(tr);
  return tr;
}

export function insertColumn(table: HTMLTableElement, index: number) {
  const cols = colCount(table);
  const cg = ensureColgroup(table, cols);
  const col = document.createElement("col");
  col.style.width = "120px";
  const beforeCol = cg.children[index] ?? null;
  if (beforeCol) cg.insertBefore(col, beforeCol);
  else cg.appendChild(col);

  for (const tr of tableRows(table)) {
    const td = document.createElement("td");
    td.contentEditable = "true";
    td.innerHTML = EMPTY_CELL;
    const before = tr.cells[index] ?? null;
    if (before) tr.insertBefore(td, before);
    else tr.appendChild(td);
  }
  syncTableWidth(table);
}

/** Returns the replacement paragraph if the table was removed, else null. */
export function deleteRow(table: HTMLTableElement, index: number): HTMLElement | null {
  const rows = tableRows(table);
  if (rows.length <= 1) return removeTable(table);
  rows[index]?.remove();
  return null;
}

/** Returns the replacement paragraph if the table was removed, else null. */
export function deleteColumn(table: HTMLTableElement, index: number): HTMLElement | null {
  const cols = colCount(table);
  if (cols <= 1) return removeTable(table);
  const cg = table.querySelector("colgroup");
  cg?.children[index]?.remove();
  for (const tr of tableRows(table)) tr.cells[index]?.remove();
  syncTableWidth(table);
  return null;
}

export function removeTable(table: HTMLTableElement): HTMLElement {
  const p = document.createElement("div");
  p.className = "p";
  p.innerHTML = "<br>";
  table.replaceWith(p);
  return p;
}

export function toggleBorders(table: HTMLTableElement) {
  table.dataset.borders = table.dataset.borders === "false" ? "true" : "false";
}

/** Keep the table's CSS width equal to the sum of its column widths. */
export function syncTableWidth(table: HTMLTableElement) {
  const cols = colCount(table);
  const cg = ensureColgroup(table, cols);
  let sum = 0;
  for (let i = 0; i < cg.children.length; i++) {
    const col = cg.children[i] as HTMLElement;
    const w = parseFloat(col.style.width || "");
    sum += Number.isFinite(w) && w > 0 ? w : 120;
  }
  table.style.width = `${Math.round(sum)}px`;
  return sum;
}

export function setColWidth(table: HTMLTableElement, colIndex: number, width: number) {
  const cols = colCount(table);
  const cg = ensureColgroup(table, cols);
  const col = cg.children[colIndex] as HTMLElement | undefined;
  if (col) col.style.width = `${Math.max(MIN_COL_WIDTH, Math.round(width))}px`;
  return syncTableWidth(table);
}

/** Content padding (left+right) of `.content` — used when growing the text box. */
export const TABLE_BOX_PAD = 16;

export function tableOuterWidth(table: HTMLTableElement): number {
  const fromCols = syncTableWidth(table);
  return Math.max(fromCols, table.scrollWidth);
}

/** Hit-test near a cell's right border for column resize (±threshold css px). */
export function colResizeHit(
  table: HTMLTableElement,
  clientX: number,
  clientY: number,
  threshold = 5,
): { colIndex: number; startWidth: number } | null {
  const rows = tableRows(table);
  if (!rows.length) return null;
  const rect = table.getBoundingClientRect();
  if (clientY < rect.top - 2 || clientY > rect.bottom + 2) return null;

  const sample = rows[0];
  for (let i = 0; i < sample.cells.length; i++) {
    const cell = sample.cells[i] as HTMLTableCellElement;
    const r = cell.getBoundingClientRect();
    if (Math.abs(clientX - r.right) <= threshold) {
      const cg = table.querySelector("colgroup");
      const colEl = cg?.children[i] as HTMLElement | undefined;
      const w = parseFloat(colEl?.style.width || "") || r.width;
      return { colIndex: i, startWidth: w };
    }
  }
  return null;
}

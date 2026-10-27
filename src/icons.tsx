import type { ReactNode } from "react";

type P = { size?: number };

const I = ({ d, size = 16, fill = false }: P & { d: string; fill?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

export const IcHome = (p: P) => (
  <I {...p} d="M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5" />
);
export const IcPlus = (p: P) => <I {...p} d="M12 5v14M5 12h14" />;
export const IcBrief = (p: P) => <I {...p} d="M6 3.5h8.2L19 8.2V20.5H6v-17zM14 3.8V8h4.2M8.2 12.5h7.6M8.2 16h5" />;
export const IcAsk = (p: P) => (
  <I {...p} d="M20 11.5a7.5 7.5 0 0 1-11.2 6.5L4 19.5l1.5-4.3A7.5 7.5 0 1 1 20 11.5ZM12.5 8.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
);
export const IcBack = (p: P) => <I {...p} d="M19 12H5m0 0 6-6m-6 6 6 6" />;
export const IcReload = (p: P) => <I {...p} d="M20 11a8 8 0 1 0-2.3 5.7M20 4.5V11h-6.5" />;
export const IcNewChat = (p: P) => (
  <I {...p} d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.4 3.6a2 2 0 0 1 2.8 2.8L13 14.6l-3.6.8.8-3.6 8.2-8.2Z" />
);
export const IcAttach = (p: P) => (
  <I {...p} d="m20.5 11.5-8.3 8.3a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 4.9 4.9l-8.6 8.6a1.7 1.7 0 0 1-2.5-2.5l7.9-7.9" />
);
export const IcSend = (p: P) => <I {...p} d="M4 12 20 4l-5 16-3.5-6.5L4 12Zm7.5 1.5L20 4" />;
export const IcCopy = (p: P) => <I {...p} d="M9 9h11v11H9zM5 15H4V4h11v1" />;
export const IcStop = (p: P) => <I {...p} d="M7 7h10v10H7z" />;
export const IcIncognito = (p: P) => (
  <I {...p} d="M3 11h18M6 11l1.5-6h9L18 11M7 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-7-3h4" />
);
export const IcSpark = (p: P) => (
  <I {...p} d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5ZM18.5 15.5c.3 1.9 1 2.6 2.9 2.9-1.9.3-2.6 1-2.9 2.9-.3-1.9-1-2.6-2.9-2.9 1.9-.3 2.6-1 2.9-2.9Z" />
);
export const IcWide = (p: P) => <I {...p} d="M3 5h18v14H3zM9 5v14M5.5 12h1.5m10.5 0H12m2-2-2 2 2 2" />;
export const IcSearch = (p: P) => <I {...p} d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35" />;
export const IcRadar = (p: P) => (
  <I {...p} d="M12 12 19 5m2 7a9 9 0 1 1-9-9m9 9h-4m-5-9v4m0 10a5 5 0 1 1 5-5" />
);
export const IcGrid = (p: P) => (
  <I {...p} d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
);
export const IcChevron = (p: P) => <I {...p} d="m6 9 6 6 6-6" />;
export const IcChevronUp = (p: P) => <I {...p} d="m6 15 6-6 6 6" />;
/** Title bar with a downward nudge — auto-hide the note name while scrolled. */
export const IcAutoHide = (p: P) => <I {...p} d="M4 6h16M8 6v3.5M16 6v3.5M12 12.5V19m0 0-3.2-3.2M12 19l3.2-3.2" />;
export const IcFullscreen = (p: P) => <I {...p} d="M4 9V4h5M20 9V4h-5M20 15v5h-5M4 15v5h5" />;
/** A window leaving the dock. */
export const IcFloat = (p: P) => <I {...p} d="M9 9H4v11h11v-5M11 4h9v9M20 4l-8 8" />;
/** A floating window returning to the dock. */
export const IcDock = (p: P) => <I {...p} d="M14 4H4v16h10M10 12h10m0 0-4-4m4 4-4 4" />;
export const IcClose = (p: P) => <I {...p} d="M6 6l12 12M18 6 6 18" />;
export const IcSave = (p: P) => (
  <I {...p} d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2ZM7 3v5h8M7 13h10v8H7z" />
);
export const IcExport = (p: P) => (
  <I {...p} d="M12 15V3m0 0L7 8m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
);
/** Several pages leaving together — multi-note export. */
export const IcExportMulti = (p: P) => (
  <I {...p} d="M8 4h9M8 7h9M7 10h12v10H7zM13 16V12m0 0-2.2 2.2M13 12l2.2 2.2" />
);
export const IcPdf = (p: P) => (
  <I {...p} d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 17v-4h2.2a1.5 1.5 0 0 1 0 3H8" />
);
export const IcFold = (p: P) => (
  <I {...p} d="M6 4h8l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm8 0v4h4M8 13h8M8 16.5h5" />
);
export const IcImage = (p: P) => (
  <I {...p} d="M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 9.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1" />
);
export const IcPen = (p: P) => (
  <I {...p} d="m3 21 1.7-5L17 3.7a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8 19.3 3 21Z" />
);
export const IcEraser = (p: P) => (
  <I {...p} d="m5 16 9.5-9.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L14 19H8l-3-3ZM8 19h13" />
);
export const IcLine = (p: P) => <I {...p} d="M5 19 19 5" />;
export const IcRect = (p: P) => <I {...p} d="M4 6h16v12H4z" />;
export const IcEllipse = (p: P) => <I {...p} d="M12 18c4.97 0 9-2.69 9-6s-4.03-6-9-6-9 2.69-9 6 4.03 6 9 6Z" />;
export const IcArrow = (p: P) => <I {...p} d="M4 20C8 10 14 7 20 6m0 0-5-1m5 1-1 5" />;
export const IcCursor = (p: P) => <I {...p} d="m5 3 14 8-6.5 1.5L9 19 5 3Z" />;
export const IcLasso = (p: P) => (
  <I {...p} d="M7.5 17.5C4.5 16.3 3 14.4 3 12c0-4.4 4-7 9-7s9 2.6 9 7-4 7-9 7c-1 0-2-.1-2.9-.3M7.5 17.5a2 2 0 1 0 1.6-.8m-1.6.8c-.4.9-.5 2.1-.2 3.5" />
);
export const IcHighlighter = (p: P) => (
  <I {...p} d="m9 15-3 3h5l1.5-1.5M9 15l-1.5-1.5L16 5a2.1 2.1 0 0 1 3 3l-8.5 8.5L9 15Zm-6 6h18" />
);
export const IcSun = (p: P) => (
  <I {...p} d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
);
export const IcMoon = (p: P) => <I {...p} d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />;
export const IcMix = (p: P) => (
  <I {...p} d="M12 3a9 9 0 1 0 0 18Zm0 0a9 9 0 0 1 0 18m0-14v10m3-8v6m3-4v2" />
);
export const IcDoc = (p: P) => (
  <I {...p} d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M9 13h6M9 17h6" />
);
export const IcBook = (p: P) => (
  <I {...p} d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
);
export const IcTrash = (p: P) => (
  <I {...p} d="M4 7h16M10 11v6m4-6v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
);
export const IcRename = (p: P) => (
  <I {...p} d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
);
export const IcUndo = (p: P) => <I {...p} d="M4 10h11a5 5 0 0 1 0 10h-3M4 10l4-4m-4 4 4 4" />;
export const IcRedo = (p: P) => <I {...p} d="M20 10H9a5 5 0 0 0 0 10h3m8-10-4-4m4 4-4 4" />;
/** Reapply colour/width onto the stroke just drawn. */
export const IcLast = (p: P) => (
  <I {...p} d="M3 17.5h10.5M18.5 6.5v5a3.5 3.5 0 0 1-3.5 3.5H12m0 0 2-2m-2 2 2 2" />
);
export const IcTable = (p: P) => (
  <I {...p} d="M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16" />
);
export const IcCalendar = (p: P) => (
  <I {...p} d="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3-3v4m8-4v4M4 10h16" />
);
export const IcFolder = (p: P) => (
  <I {...p} d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
);
export const IcCheck = (p: P) => <I {...p} d="m4 12.5 5 5L20 6.5" />;
export const IcEye = (p: P) => (
  <I {...p} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
);
export const IcCollapse = (p: P) => <I {...p} d="m11 7-5 5 5 5m7-10-5 5 5 5" />;
export const IcMath = (p: P) => (
  <I {...p} d="M4 4h9L7.5 11.5 13 19H4m13-9 4 8m0-8-4 8" />
);
export const IcExpand = (p: P) => <I {...p} d="m13 7 5 5-5 5M6 7l5 5-5 5" />;
export const IcSettings = (p: P) => (
  <I
    {...p}
    d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13a7.7 7.7 0 0 0 .05-2l2-1.55-2-3.45-2.4.95a7.6 7.6 0 0 0-1.75-1L15 3h-6l-.3 2.95a7.6 7.6 0 0 0-1.75 1L4.55 6l-2 3.45L4.55 11a7.7 7.7 0 0 0 0 2l-2 1.55 2 3.45 2.4-.95a7.6 7.6 0 0 0 1.75 1L9 21h6l.3-2.95a7.6 7.6 0 0 0 1.75-1l2.4.95 2-3.45L19.4 13Z"
  />
);
/** Lift out of a group (arrow up-right from a tray). */
export const IcUngroup = (p: P) => (
  <I {...p} d="M4 20h7M4 20V9m0 11 7-7M14 4h6v6m0-6-8 8" />
);

function PdfGlyph({ size = 16, children }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      {children}
    </svg>
  );
}

export const IcPdfStack = (p: P) => (
  <PdfGlyph {...p}>
    <rect x="4" y="3" width="16" height="7" rx="1.2" />
    <rect x="4" y="14" width="16" height="7" rx="1.2" />
  </PdfGlyph>
);
export const IcPdfRow = (p: P) => (
  <PdfGlyph {...p}>
    <rect x="2" y="6" width="6" height="12" rx="1" />
    <rect x="9" y="6" width="6" height="12" rx="1" />
    <rect x="16" y="6" width="6" height="12" rx="1" />
  </PdfGlyph>
);
export const IcPdfOdd = (p: P) => (
  <PdfGlyph {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="3" width="8" height="8" rx="1" />
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </PdfGlyph>
);
export const IcPdfEven = (p: P) => (
  <PdfGlyph {...p}>
    <rect x="13" y="3" width="8" height="8" rx="1" />
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </PdfGlyph>
);

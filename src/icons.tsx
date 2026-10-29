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
export const IcHistory = (p: P) => <I {...p} d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3.5 2" />;
export const IcCalc = (p: P) => (
  <I {...p} d="M6 3.5h12v17H6zM9 8h6M9 12h1.5M12.5 12H14M9 16h1.5M12.5 16H14" />
);
export const IcScan = (p: P) => <I {...p} d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 12h8" />;
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
/** Light bulb: Explain. */
export const IcExplain = (p: P) => (
  <I {...p} d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" />
);
/** Pencil writing a line: Solve. */
export const IcSolve = (p: P) => (
  <I {...p} d="M4 20h7M15.5 4.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4 9.5-9.5ZM14 6l3 3" />
);
/** Shield with a check: Verify. */
export const IcVerify = (p: P) => (
  <I {...p} d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6l-7-3Zm-3.2 9.2 2.2 2.2 4.2-4.6" />
);
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

/** The chat models' own logos (from Simple Icons), drawn small next to their names. */
const CLAUDE_D = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_D = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const GEMINI_D = "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";

export function HostLogo({ host, size = 16 }: { host: "claude" | "chatgpt" | "gemini"; size?: number }) {
  if (host === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path fill="#D97757" d={CLAUDE_D} />
      </svg>
    );
  }
  if (host === "chatgpt") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="logo-chatgpt">
        <path fill="currentColor" d={OPENAI_D} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="pl-gemini-grad" x1="2" y1="20" x2="22" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1C7DFF" />
          <stop offset="0.52" stopColor="#9168C0" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path fill="url(#pl-gemini-grad)" d={GEMINI_D} />
    </svg>
  );
}

/**
 * The calculator body, drawn entirely in vector: cream shell, grained dark
 * face, CASIO lettering, solar panel and LCD bezel. Coordinates are in the
 * 267 × 565 face space used by the keys. Static, so it is memoised and the
 * browser can keep it on its own layer.
 */
import { memo } from "react";

export const CalcBody = memo(function CalcBody() {
  return (
    <svg className="calc-body" viewBox="0 0 267 565" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="cb-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f5f1" />
          <stop offset="0.9" stopColor="#efeee9" />
          <stop offset="1" stopColor="#e2e1dc" />
        </linearGradient>
        <linearGradient id="cb-shell-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.1" />
          <stop offset="0.04" stopColor="#000" stopOpacity="0" />
          <stop offset="0.96" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="cb-lip" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f1f1ef" />
          <stop offset="0.5" stopColor="#e2e2df" />
          <stop offset="1" stopColor="#c9c9c5" />
        </linearGradient>
        <linearGradient id="cb-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#323136" />
          <stop offset="0.4" stopColor="#2f2e33" />
          <stop offset="1" stopColor="#2c2b30" />
        </linearGradient>
        <linearGradient id="cb-face-edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.09" />
          <stop offset="0.03" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.97" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="cb-chin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="0.4" stopColor="#000" stopOpacity="0.1" />
          <stop offset="1" stopColor="#000" stopOpacity="0.2" />
        </linearGradient>
        <filter id="cb-grain" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="7" stitchTiles="stitch" result="n" />
          <feColorMatrix
            in="n"
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.9 0 0 0 -0.38"
          />
        </filter>
        <filter id="cb-grain-dark" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="1" seed="13" stitchTiles="stitch" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.1 0 0 0 -0.42" />
        </filter>
        {/* the ClassWiz "carbon" weave: staggered rows of soft scale-shaped ridges */}
        <pattern id="cb-weave" width="6.4" height="4.4" patternUnits="userSpaceOnUse">
          <g fill="none" strokeLinecap="round">
            <path d="M0.2 2.9 Q3.2 0.3 6.2 2.9" stroke="#000" strokeOpacity="0.55" strokeWidth="1.1" transform="translate(0 0.75)" />
            <path d="M0.2 2.9 Q3.2 0.3 6.2 2.9" stroke="#fff" strokeOpacity="0.2" strokeWidth="1.15" />
            <path d="M-3 5.1 Q0 2.5 3 5.1 M3.4 5.1 Q6.4 2.5 9.4 5.1" stroke="#000" strokeOpacity="0.55" strokeWidth="1.1" transform="translate(0 0.75)" />
            <path d="M-3 5.1 Q0 2.5 3 5.1 M3.4 5.1 Q6.4 2.5 9.4 5.1" stroke="#fff" strokeOpacity="0.2" strokeWidth="1.15" />
            <path d="M-3 0.7 Q0 -1.9 3 0.7 M3.4 0.7 Q6.4 -1.9 9.4 0.7" stroke="#000" strokeOpacity="0.55" strokeWidth="1.1" transform="translate(0 0.75)" />
            <path d="M-3 0.7 Q0 -1.9 3 0.7 M3.4 0.7 Q6.4 -1.9 9.4 0.7" stroke="#fff" strokeOpacity="0.2" strokeWidth="1.15" />
          </g>
        </pattern>
        <filter id="cb-soft" x="0" y="0" width="100%" height="100%" filterUnits="objectBoundingBox">
          <feGaussianBlur stdDeviation="0.32" />
        </filter>
        <clipPath id="cb-face-clip">
          <rect x="4" y="4.5" width="259" height="543.5" rx="11" />
        </clipPath>
        <linearGradient id="cb-solar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d1f18" />
          <stop offset="0.55" stopColor="#2c140f" />
          <stop offset="1" stopColor="#22100c" />
        </linearGradient>
        <linearGradient id="cb-solar-gloss" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.1" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.02" />
          <stop offset="0.46" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cb-bezel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2b2e" />
          <stop offset="0.07" stopColor="#232326" />
          <stop offset="0.85" stopColor="#212124" />
          <stop offset="1" stopColor="#28282b" />
        </linearGradient>
        <linearGradient id="cb-bezel-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.07" />
          <stop offset="0.035" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.965" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="cb-chin-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1c1f" />
          <stop offset="0.45" stopColor="#28282b" />
          <stop offset="1" stopColor="#323236" />
        </linearGradient>
        <linearGradient id="cb-bezel-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#55555a" />
          <stop offset="0.25" stopColor="#3c3c40" />
          <stop offset="0.85" stopColor="#333337" />
          <stop offset="1" stopColor="#424246" />
        </linearGradient>
        <pattern id="cb-dots" width="1.3" height="1.3" patternUnits="userSpaceOnUse">
          <circle cx="0.65" cy="0.65" r="0.56" fill="#e0476d" />
        </pattern>
      </defs>

      {/* cream shell with its thicker bottom lip */}
      <rect x="0" y="0" width="267" height="565" rx="12.5" fill="url(#cb-shell)" />
      <path d="M0 540 H267 V552.5 A12.5 12.5 0 0 1 254.5 565 H12.5 A12.5 12.5 0 0 1 0 552.5 Z" fill="url(#cb-lip)" />
      <rect x="0" y="0" width="267" height="565" rx="12.5" fill="url(#cb-shell-side)" />
      <rect x="0.4" y="0.4" width="266.2" height="564.2" rx="12.2" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.8" />

      {/* dark face */}
      <rect x="3.4" y="3.9" width="260.2" height="544.7" rx="11.4" fill="#18181a" />
      <g clipPath="url(#cb-face-clip)">
        <rect x="4" y="4.5" width="259" height="543.5" fill="url(#cb-face)" />
        <rect x="4" y="4.5" width="259" height="543.5" fill="url(#cb-weave)" filter="url(#cb-soft)" opacity="0.55" />
        <rect x="4" y="4.5" width="259" height="543.5" filter="url(#cb-grain)" opacity="0.16" />
        <rect x="4" y="4.5" width="259" height="543.5" filter="url(#cb-grain-dark)" opacity="0.32" />
        <rect x="4" y="527" width="259" height="21" fill="url(#cb-chin)" />
        <rect x="4" y="4.5" width="259" height="543.5" fill="url(#cb-face-edge)" />
        <rect x="4.4" y="4.9" width="258.2" height="542.7" rx="10.8" fill="none" stroke="#fff" strokeOpacity="0.07" strokeWidth="0.8" />
      </g>

      {/* lettering */}
      {/* CASIO logotype, drawn as strokes so it looks the same on every system */}
      <g className="cb-casio" fill="none" stroke="#e4e4e6" strokeWidth="2.3">
        <path d="M43.2 27.6 A4.6 2.9 0 1 0 43.2 31.4" />
        <path d="M47.4 33.4 L52.4 26.75 H54 L59 33.4" strokeLinejoin="round" />
        <path d="M50.1 31.2 H56.3" strokeWidth="1.6" />
        <path d="M71.3 28 C71.2 27 69.7 26.6 67.2 26.6 C64.6 26.6 63.3 27 63.3 28.1 C63.3 29.3 64.7 29.5 67.2 29.5 C69.7 29.5 71.4 29.7 71.4 30.9 C71.4 32 69.9 32.4 67.2 32.4 C64.5 32.4 63 32.1 62.9 30.9" />
        <path d="M75.4 25.6 V33.4" />
        <ellipse cx="85.6" cy="29.5" rx="4.9" ry="2.9" />
      </g>      <text x="40" y="55" textLength="36" lengthAdjust="spacingAndGlyphs" className="cb-model">
        fx-991EX
      </text>
      <text x="25.5" y="70" textLength="72" lengthAdjust="spacing" className="cb-classwiz" fill="url(#cb-dots)">
        CLASSWIZ
      </text>

      {/* solar panel */}
      <rect x="114.2" y="15.2" width="123.6" height="48.6" rx="3.6" fill="#0c0c0d" />
      <rect x="115.6" y="16.6" width="120.8" height="45.8" rx="2.6" fill="url(#cb-solar)" />
      <g stroke="#120806" strokeWidth="0.55" opacity="0.8">
        <line x1="145.8" y1="17" x2="145.8" y2="62" />
        <line x1="176" y1="17" x2="176" y2="62" />
        <line x1="206.2" y1="17" x2="206.2" y2="62" />
      </g>
      <rect x="115.6" y="16.6" width="120.8" height="45.8" rx="2.6" fill="url(#cb-solar-gloss)" />
      <rect x="114.2" y="15.2" width="123.6" height="48.6" rx="3.6" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="0.6" />

      {/* LCD bezel: a raised frame with dark top/side bevels, a glossy sloped
          chin that tapers at the bottom corners, and a black window */}
      <path
        d="M22 72.6 H245 Q252.6 72.6 252.6 80.2 V170 Q252.6 176.6 247 179.6 L240 183.2 Q238.6 184 236.8 184 H30.2 Q28.4 184 27 183.2 L20 179.6 Q14.4 176.6 14.4 170 V80.2 Q14.4 72.6 22 72.6 Z"
        fill="#000"
        opacity="0.55"
        transform="translate(0 1.4)"
      />
      <path
        d="M22 72.6 H245 Q252.6 72.6 252.6 80.2 V170 Q252.6 176.6 247 179.6 L240 183.2 Q238.6 184 236.8 184 H30.2 Q28.4 184 27 183.2 L20 179.6 Q14.4 176.6 14.4 170 V80.2 Q14.4 72.6 22 72.6 Z"
        fill="url(#cb-bezel)"
      />
      <path
        d="M22 72.6 H245 Q252.6 72.6 252.6 80.2 V170 Q252.6 176.6 247 179.6 L240 183.2 Q238.6 184 236.8 184 H30.2 Q28.4 184 27 183.2 L20 179.6 Q14.4 176.6 14.4 170 V80.2 Q14.4 72.6 22 72.6 Z"
        fill="url(#cb-bezel-side)"
      />
      {/* glossy chin */}
      <path d="M22.4 174.6 H244.6 L250.4 178.4 L239.4 182.6 H27.6 L16.6 178.4 Z" fill="url(#cb-chin-gloss)" />
      <path d="M28 182.3 H239" stroke="#fff" strokeOpacity="0.06" strokeWidth="0.6" />
      <path
        d="M22 73 H245 Q252.2 73 252.2 80.2 V170 Q252.2 176.4 246.8 179.3 L239.8 182.9"
        fill="none"
        stroke="url(#cb-bezel-rim)"
        strokeWidth="0.8"
      />
      <path d="M22 73 Q14.8 73 14.8 80.2 V170 Q14.8 176.4 20.2 179.3 L27.2 182.9" fill="none" stroke="url(#cb-bezel-rim)" strokeWidth="0.8" />
      {/* black window around the glass */}
      <rect x="22.4" y="79.6" width="222.2" height="95" rx="3.6" fill="#0b0b0c" />
      <rect x="22.4" y="79.6" width="222.2" height="95" rx="3.6" fill="none" stroke="#000" strokeWidth="0.9" />
      <rect x="22.9" y="80.1" width="221.2" height="94" rx="3.2" fill="none" stroke="#fff" strokeOpacity="0.05" strokeWidth="0.5" />
      <rect x="26.6" y="83.9" width="213.8" height="85.4" rx="1.4" fill="none" stroke="#2c2c2f" strokeWidth="0.7" />
    </svg>
  );
});

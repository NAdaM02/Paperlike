/** Scientific constants (CODATA 2018 values) and unit conversions, grouped like the ClassWiz CONST / CONV menus. */

export interface PhysConst {
  id: string;
  sym: string; // display symbol
  name: string;
  value: string; // decimal literal, exact where defined
}

export const CONST_GROUPS: { name: string; items: PhysConst[] }[] = [
  {
    name: "Universal",
    items: [
      { id: "h", sym: "h", name: "Planck constant", value: "6.62607015e-34" },
      { id: "hbar", sym: "ħ", name: "Reduced Planck constant", value: "1.054571817e-34" },
      { id: "c0", sym: "c₀", name: "Speed of light in vacuum", value: "299792458" },
      { id: "eps0", sym: "ε₀", name: "Electric constant", value: "8.8541878128e-12" },
      { id: "mu0", sym: "μ₀", name: "Magnetic constant", value: "1.25663706212e-6" },
      { id: "Z0", sym: "Z₀", name: "Impedance of vacuum", value: "376.730313668" },
      { id: "G", sym: "G", name: "Newtonian constant of gravitation", value: "6.6743e-11" },
      { id: "lP", sym: "lₚ", name: "Planck length", value: "1.616255e-35" },
      { id: "tP", sym: "tₚ", name: "Planck time", value: "5.391247e-44" },
    ],
  },
  {
    name: "Electromagnetic",
    items: [
      { id: "muN", sym: "μN", name: "Nuclear magneton", value: "5.0507837461e-27" },
      { id: "muB", sym: "μB", name: "Bohr magneton", value: "9.2740100783e-24" },
      { id: "qe", sym: "e", name: "Elementary charge", value: "1.602176634e-19" },
      { id: "Phi0", sym: "Φ₀", name: "Magnetic flux quantum", value: "2.067833848e-15" },
      { id: "G0", sym: "G₀", name: "Conductance quantum", value: "7.748091729e-5" },
      { id: "KJ", sym: "K_J", name: "Josephson constant", value: "483597.8484e9" },
      { id: "RK", sym: "R_K", name: "von Klitzing constant", value: "25812.80745" },
    ],
  },
  {
    name: "Atomic & nuclear",
    items: [
      { id: "mp", sym: "mₚ", name: "Proton mass", value: "1.67262192369e-27" },
      { id: "mn", sym: "mₙ", name: "Neutron mass", value: "1.67492749804e-27" },
      { id: "me", sym: "mₑ", name: "Electron mass", value: "9.1093837015e-31" },
      { id: "mmu", sym: "mμ", name: "Muon mass", value: "1.883531627e-28" },
      { id: "a0", sym: "a₀", name: "Bohr radius", value: "5.29177210903e-11" },
      { id: "alpha", sym: "α", name: "Fine-structure constant", value: "7.2973525693e-3" },
      { id: "re", sym: "rₑ", name: "Classical electron radius", value: "2.8179403262e-15" },
      { id: "lamc", sym: "λc", name: "Compton wavelength", value: "2.42631023867e-12" },
      { id: "gp", sym: "γₚ", name: "Proton gyromagnetic ratio", value: "2.6752218744e8" },
      { id: "Rinf", sym: "R∞", name: "Rydberg constant", value: "10973731.56816" },
      { id: "mup", sym: "μₚ", name: "Proton magnetic moment", value: "1.41060679736e-26" },
      { id: "mue", sym: "μₑ", name: "Electron magnetic moment", value: "-9.2847647043e-24" },
      { id: "mun", sym: "μₙ", name: "Neutron magnetic moment", value: "-9.6623651e-27" },
    ],
  },
  {
    name: "Physico-chemical",
    items: [
      { id: "u", sym: "u", name: "Atomic mass constant", value: "1.6605390666e-27" },
      { id: "F", sym: "F", name: "Faraday constant", value: "96485.33212" },
      { id: "NA", sym: "N_A", name: "Avogadro constant", value: "6.02214076e23" },
      { id: "kB", sym: "k", name: "Boltzmann constant", value: "1.380649e-23" },
      { id: "Vm", sym: "V_m", name: "Molar volume of ideal gas (273.15 K, 101.325 kPa)", value: "22.41396954e-3" },
      { id: "R", sym: "R", name: "Molar gas constant", value: "8.314462618" },
      { id: "C1", sym: "C₁", name: "First radiation constant", value: "3.741771852e-16" },
      { id: "C2", sym: "C₂", name: "Second radiation constant", value: "1.438776877e-2" },
      { id: "sigma", sym: "σ", name: "Stefan–Boltzmann constant", value: "5.670374419e-8" },
    ],
  },
  {
    name: "Adopted values",
    items: [
      { id: "gn", sym: "g", name: "Standard acceleration of gravity", value: "9.80665" },
      { id: "atm", sym: "atm", name: "Standard atmosphere (Pa)", value: "101325" },
      { id: "t0", sym: "t", name: "Celsius temperature (K)", value: "273.15" },
    ],
  },
];

export const CONSTS: Record<string, PhysConst> = Object.fromEntries(
  CONST_GROUPS.flatMap((g) => g.items.map((c) => [c.id, c])),
);

export interface Conversion {
  id: string;
  label: string; // e.g. "in▸cm"
  /** multiply by factor (decimal literal, or "a/b"), or affine temperature conversions */
  factor?: string;
  temp?: "F2C" | "C2F";
}

const pair = (from: string, to: string, factor: string, idFrom: string, idTo: string): Conversion[] => [
  { id: `${idFrom}>${idTo}`, label: `${from}▸${to}`, factor },
  { id: `${idTo}>${idFrom}`, label: `${to}▸${from}`, factor: `1/${factor}` },
];

export const CONV_GROUPS: { name: string; items: Conversion[] }[] = [
  {
    name: "Length",
    items: [
      ...pair("in", "cm", "2.54", "in", "cm"),
      ...pair("ft", "m", "0.3048", "ft", "m"),
      ...pair("yd", "m", "0.9144", "yd", "m"),
      ...pair("mile", "km", "1.609344", "mile", "km"),
      ...pair("n mile", "m", "1852", "nmile", "m"),
      ...pair("pc", "km", "30856775814913.673", "pc", "km"),
    ],
  },
  { name: "Area", items: [...pair("acre", "m²", "4046.8564224", "acre", "m2")] },
  {
    name: "Volume",
    items: [...pair("gal(US)", "L", "3.785411784", "galus", "L"), ...pair("gal(UK)", "L", "4.54609", "galuk", "L")],
  },
  { name: "Velocity", items: [...pair("km/h", "m/s", "5/18", "kmh", "ms")] },
  {
    name: "Mass",
    items: [...pair("oz", "g", "28.349523125", "oz", "g"), ...pair("lb", "kg", "0.45359237", "lb", "kg")],
  },
  {
    name: "Pressure",
    items: [
      ...pair("atm", "Pa", "101325", "atm", "Pa"),
      ...pair("mmHg", "Pa", "133.322387415", "mmHg", "Pa"),
      ...pair("kgf/cm²", "Pa", "98066.5", "kgfcm2", "Pa"),
      ...pair("lbf/in²", "kPa", "6.894757293168", "psi", "kPa"),
    ],
  },
  {
    name: "Energy & power",
    items: [
      ...pair("kgf·m", "J", "9.80665", "kgfm", "J"),
      ...pair("cal", "J", "4.184", "cal", "J"),
      ...pair("hp", "kW", "0.745699872", "hp", "kW"),
    ],
  },
  {
    name: "Temperature",
    items: [
      { id: "F>C", label: "°F▸°C", temp: "F2C" },
      { id: "C>F", label: "°C▸°F", temp: "C2F" },
    ],
  },
];

export const CONVS: Record<string, Conversion> = Object.fromEntries(
  CONV_GROUPS.flatMap((g) => g.items.map((c) => [c.id, c])),
);

/** Engineering symbols (OPTN ▸ Engineer Symbol). */
export const ENG_SYMBOLS: { sym: string; exp: number; name: string }[] = [
  { sym: "k", exp: 3, name: "kilo" },
  { sym: "M", exp: 6, name: "mega" },
  { sym: "G", exp: 9, name: "giga" },
  { sym: "T", exp: 12, name: "tera" },
  { sym: "m", exp: -3, name: "milli" },
  { sym: "μ", exp: -6, name: "micro" },
  { sym: "n", exp: -9, name: "nano" },
  { sym: "p", exp: -12, name: "pico" },
  { sym: "f", exp: -15, name: "femto" },
];

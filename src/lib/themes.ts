import type { ITheme } from "@xterm/xterm";

interface InterfaceColors {
  root: string;
  canvas: string;
  surface: string;
  raised: string;
  elevated: string;
  text: string;
  secondary: string;
  muted: string;
  dim: string;
}

type AnsiColors = readonly [string, string, string, string, string, string, string, string];
export type TerminalTheme = Required<Pick<ITheme,
  "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground" |
  "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" |
  "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
>>;

interface ThemeDefinition {
  id: string;
  name: string;
  desc: string;
  group: "soft" | "classic";
  colors: InterfaceColors;
  accent: string;
  accentHover: string;
  accentText: string;
  terminal: TerminalTheme;
}

// ANSI order: black, red, green, yellow, blue, magenta, cyan, white.
function terminalPalette(background: string, foreground: string, cursor: string, selectionBackground: string,
  normal: AnsiColors, bright: AnsiColors): TerminalTheme {
  return {
    background, foreground, cursor, cursorAccent: background, selectionBackground,
    black: normal[0], red: normal[1], green: normal[2], yellow: normal[3],
    blue: normal[4], magenta: normal[5], cyan: normal[6], white: normal[7],
    brightBlack: bright[0], brightRed: bright[1], brightGreen: bright[2], brightYellow: bright[3],
    brightBlue: bright[4], brightMagenta: bright[5], brightCyan: bright[6], brightWhite: bright[7],
  };
}

const classicColors: InterfaceColors = {
  root: "#090d12", canvas: "#0c1017", surface: "#121822", raised: "#18202d", elevated: "#1e2838",
  text: "#edf2f7", secondary: "#9aa8b9", muted: "#64748b", dim: "#475569",
};
const classicTerminal = terminalPalette("#111417", "#d6d9dc", "#8bd5a5", "#3b5e4a99",
  ["#15191d", "#e06c75", "#8bd5a5", "#e5c07b", "#74a7d8", "#c792c7", "#70c0ba", "#d6d9dc"],
  ["#66717b", "#f07f88", "#a4e3b9", "#f0cf8d", "#8dbce8", "#dda7dd", "#88d6cf", "#f2f4f5"],
);

export const themes = [
  {
    id: "emerald", name: "翡翠青绿", desc: "青绿点缀 · 经典默认", group: "classic",
    colors: classicColors, accent: "#10b981", accentHover: "#059669", accentText: "#34d399",
    terminal: classicTerminal,
  },
  {
    id: "cyan", name: "极客冰蓝", desc: "清爽冷峻 · 云原生风", group: "classic",
    colors: classicColors, accent: "#0ea5e9", accentHover: "#0284c7", accentText: "#38bdf8",
    terminal: { ...classicTerminal, cursor: "#38bdf8", selectionBackground: "#28536b99" },
  },
  {
    id: "violet", name: "霓虹紫珀", desc: "先锋前卫 · 赛博潮流", group: "classic",
    colors: classicColors, accent: "#8b5cf6", accentHover: "#7c3aed", accentText: "#a78bfa",
    terminal: { ...classicTerminal, cursor: "#a78bfa", selectionBackground: "#51416d99" },
  },
  {
    id: "amber", name: "琥珀暖金", desc: "复古经典 · 温暖沉静", group: "classic",
    colors: classicColors, accent: "#f59e0b", accentHover: "#d97706", accentText: "#fbbf24",
    terminal: { ...classicTerminal, cursor: "#fbbf24", selectionBackground: "#69543299" },
  },
  {
    id: "nord", name: "北境雾蓝", desc: "雾感蓝灰 · 清冷安静", group: "soft",
    colors: {
      root: "#242933", canvas: "#292e39", surface: "#2e3440", raised: "#353d4b", elevated: "#3e4858",
      text: "#e5e9f0", secondary: "#b2bccb", muted: "#98a5ba", dim: "#8491a6",
    },
    accent: "#88b4c4", accentHover: "#9fc5d0", accentText: "#a3c8d6",
    terminal: terminalPalette("#2e3440", "#d8dee9", "#88b4c4", "#48556b",
      ["#252b35", "#bf858b", "#a3be8c", "#d5c19a", "#8ca9c5", "#b5a0b9", "#8fbcb7", "#d8dee9"],
      ["#8793a5", "#d39a9f", "#b6cca4", "#e0ceae", "#a4bdd5", "#c7b4ca", "#a5ceca", "#eceff4"],
    ),
  },
  {
    id: "moonlight", name: "月夜靛蓝", desc: "静谧靛青 · 柔和月色", group: "soft",
    colors: {
      root: "#171923", canvas: "#1c1e2a", surface: "#222535", raised: "#292c3d", elevated: "#353a50",
      text: "#c9cee5", secondary: "#a5aecb", muted: "#929bbb", dim: "#7f89a7",
    },
    accent: "#899bc2", accentHover: "#9cadd2", accentText: "#a8b9df",
    terminal: terminalPalette("#1f2333", "#c9cee5", "#a8b9df", "#414b68",
      ["#191c29", "#cf909d", "#a5b89c", "#c9b491", "#8ea6cf", "#b3a0cd", "#91b8c0", "#c9cee5"],
      ["#828dab", "#dfa6b1", "#bacab2", "#d9c6a8", "#a8bcdd", "#c6b6db", "#aacbd1", "#e0e4f2"],
    ),
  },
  {
    id: "rose", name: "玫瑰松烟", desc: "烟紫底色 · 温柔灰粉", group: "soft",
    colors: {
      root: "#191724", canvas: "#1d1b2a", surface: "#242131", raised: "#2d293d", elevated: "#393349",
      text: "#e0dce9", secondary: "#bdb4cc", muted: "#a299b3", dim: "#8f849e",
    },
    accent: "#c4a0b3", accentHover: "#d4b1c1", accentText: "#dfbecd",
    terminal: terminalPalette("#211f2e", "#ded9e8", "#d2afc0", "#514257",
      ["#1b1926", "#cf91a6", "#a1b1a0", "#d1b594", "#96a9c5", "#b6a5ce", "#a1bec6", "#ded9e8"],
      ["#94879f", "#dfa8b8", "#b8c5b5", "#dec8ad", "#afc0d6", "#cabce0", "#b8d0d5", "#f0eaf3"],
    ),
  },
  {
    id: "forest", name: "松林薄雾", desc: "苔绿灰调 · 自然沉静", group: "soft",
    colors: {
      root: "#222925", canvas: "#272f2b", surface: "#2f3832", raised: "#364139", elevated: "#424f45",
      text: "#d5dbcc", secondary: "#b5c0af", muted: "#9ca998", dim: "#899886",
    },
    accent: "#a4b596", accentHover: "#b4c5a6", accentText: "#bacbad",
    terminal: terminalPalette("#2b332e", "#d3dacb", "#b3c5a4", "#4b5b4c",
      ["#222b25", "#c9948c", "#a4b596", "#c9bb92", "#96aeb7", "#b5a1b5", "#98b8ae", "#d3dacb"],
      ["#8c9c8d", "#daaaa2", "#bac9af", "#daccac", "#aec3c9", "#c9b7c9", "#b0ccc3", "#e6eadf"],
    ),
  },
  {
    id: "sandstone", name: "暖砂墨褐", desc: "暖灰棕调 · 细腻柔光", group: "soft",
    colors: {
      root: "#242120", canvas: "#2b2725", surface: "#322d2b", raised: "#3b3531", elevated: "#49403a",
      text: "#e0d6ca", secondary: "#c0b3a4", muted: "#ad9e90", dim: "#98897d",
    },
    accent: "#c0a184", accentHover: "#d0b298", accentText: "#d7baa0",
    terminal: terminalPalette("#2c2826", "#d9cfc1", "#d1b396", "#594d42",
      ["#24201e", "#c5948d", "#aeb798", "#c7b68f", "#9caeba", "#b8a2b7", "#9eb8b1", "#d9cfc1"],
      ["#a09387", "#d8aba4", "#c1caaf", "#dac9a8", "#b3c2cc", "#ccb9cb", "#b4cdc5", "#ede4d8"],
    ),
  },
  {
    id: "graphite", name: "石墨雾灰", desc: "中性石墨 · 克制纯粹", group: "soft",
    colors: {
      root: "#202124", canvas: "#252629", surface: "#2d2e32", raised: "#35363b", elevated: "#424349",
      text: "#dcdde1", secondary: "#bcbec5", muted: "#a0a3ac", dim: "#8c8f99",
    },
    accent: "#a4acba", accentHover: "#b6bdc9", accentText: "#c0c7d2",
    terminal: terminalPalette("#26272b", "#d4d6db", "#bdc5d1", "#4b4e58",
      ["#202125", "#c69b9f", "#a6b7a6", "#c2b69e", "#9fadc4", "#b5a5bf", "#a0b8bd", "#d4d6db"],
      ["#969ba5", "#d9b1b4", "#bccabb", "#d5cbb6", "#b7c3d5", "#cbbbd2", "#b8cdd0", "#e9eaee"],
    ),
  },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof themes)[number]["id"];
export const DEFAULT_THEME: ThemeId = "emerald";
export const THEME_STORAGE_KEY = "shellgrid-theme";
export const themeGroups = [
  { id: "soft", name: "柔和深色" },
  { id: "classic", name: "经典深色" },
] as const;

export function getTheme(value: unknown): (typeof themes)[number] {
  return themes.find((theme) => theme.id === value) ?? themes[0];
}

export function readTheme(): ThemeId {
  try { return getTheme(localStorage.getItem(THEME_STORAGE_KEY)).id; }
  catch { return DEFAULT_THEME; }
}

export function saveTheme(id: ThemeId): void {
  try { localStorage.setItem(THEME_STORAGE_KEY, id); }
  catch { /* A storage failure should not prevent changing the current appearance. */ }
}

export function applyInterfaceTheme(id: ThemeId): void {
  const theme = getTheme(id);
  const { colors, accent, terminal } = theme;
  const soft = theme.group === "soft";
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  const variables = {
    "bg-root": colors.root, "bg-canvas": colors.canvas, "bg-surface": colors.surface,
    "bg-surface-raised": colors.raised, "bg-surface-elevated": colors.elevated,
    "bg-glass": soft ? `${colors.surface}ed` : "rgba(14, 20, 29, 0.86)",
    "bg-terminal": terminal.background, "bg-diff": soft ? terminal.background : "#090c10",
    "text-main": colors.text, "text-secondary": colors.secondary, "text-muted": colors.muted, "text-dim": colors.dim,
    "accent": accent, "accent-hover": theme.accentHover, "accent-text": theme.accentText,
    "accent-subtle": `${accent}1f`, "accent-glow": `${accent}${soft ? "24" : "47"}`,
    "accent-border": `${accent}${soft ? "66" : "73"}`, "on-accent": soft ? colors.root : "#ffffff",
    "color-success": soft ? terminal.green : "#10b981", "color-success-text": soft ? terminal.brightGreen : "#6ee7b7",
    "color-warning": soft ? terminal.yellow : "#f59e0b", "color-warning-text": soft ? terminal.brightYellow : "#fbbf24",
    "color-danger": soft ? terminal.red : "#f43f5e", "color-danger-text": soft ? terminal.brightRed : "#fda4af",
    "color-info": soft ? terminal.cyan : "#38bdf8",
    "scrollbar-thumb": soft ? `${colors.dim}80` : "#273546",
    "app-glow": `radial-gradient(circle at 50% -20%, ${accent}${soft ? "08" : "0d"} 0%, transparent 60%)`,
  };
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(`--${name}`, value);
}

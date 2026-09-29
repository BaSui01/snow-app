import { useId, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

import {
  buildCells,
  LETTER_HEIGHT,
  LETTER_WIDTH,
  renderPixelArt,
  sparklePath,
} from "./pixelArt";
import type { PixelArtMap, PixelCell, PixelLogoProps } from "./pixelArt";

type RococoPixelLogoProps = PixelLogoProps & {
  isDark: boolean;
};

type RococoPalette = Record<string, string>;

type RococoLayer = {
  map: PixelArtMap;
  palette: RococoPalette;
  dx: number;
  dy: number;
};

type RococoAccent = {
  className: string;
  layers: RococoLayer[];
};

type RococoPieceSpec = {
  key: string;
  layers: RococoLayer[];
  accents: RococoAccent[];
  appearDelay: number;
};

type RococoPiece = RococoPieceSpec & {
  x: number;
  top: number;
  cell: number;
};

type RococoWalker = {
  x: number;
  top: number;
  cell: number;
  from: number;
  delay: number;
  wings: RococoLayer;
  body: RococoLayer;
};

type RococoCharm = {
  x: number;
  top: number;
  cell: number;
  layers: RococoLayer[];
  accents: RococoAccent[];
  delay: number;
  rise: number;
};

type RococoRail = {
  x: number;
  y: number;
  width: number;
  height: number;
  inlay: { x: number; y: number; width: number; height: number };
  beads: { key: string; x: number; y: number; size: number }[];
};

type RococoVeil = {
  key: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  opacity: number;
  reverse: boolean;
};

type RococoMote = {
  key: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  rise: number;
};

type RococoStar = {
  key: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
};

type RococoPetal = {
  key: number;
  x: number;
  width: number;
  height: number;
  delay: number;
  duration: number;
  opacity: number;
  drift: number;
  spin: number;
};

type RococoStrand = {
  key: string;
  x: number;
  y: number;
  length: number;
  growDelay: number;
  fadeDelay: number;
  drop: { delay: number; duration: number; fall: number } | null;
};

type RococoLace = {
  key: string;
  x: number;
  y: number;
  tall: boolean;
  delay: number;
  fadeDelay: number;
};

type RococoSpark = {
  key: string;
  cx: number;
  cy: number;
  size: number;
  delay: number;
  duration: number;
};

type RococoScene = {
  pieces: RococoPiece[];
  walker: RococoWalker;
  charm: RococoCharm;
  rail: RococoRail;
  veils: RococoVeil[];
  motes: RococoMote[];
  moon: { x: number; y: number; cell: number } | null;
  stars: RococoStar[];
  petals: RococoPetal[];
  decoDelay: number;
  fadeDelay: number;
  veilDelay: number;
};

type RococoSkin = {
  gild: string[];
  bead: string[];
  veil: string[];
  petal: string;
  mote: string;
  star: string;
  rail: string;
  inlay: string;
  lace: string;
  spark: string;
  drop: string;
  reflect: string;
};

const REFLECTION_SCALE = 0.32;
const STRAND_TAPER = [1, 0.76, 0.54, 0.34];

const SKIN_LIGHT: RococoSkin = {
  gild: ["#fff7fa", "#e9a9bb", "#b0607a"],
  bead: ["#fffdfa", "#f0d9c4", "#c9ac92"],
  veil: ["#ffd9e4", "#ffeccb", "#fffaf4"],
  petal: "#eaa8bd",
  mote: "#fbe6ee",
  star: "#f6e4c4",
  rail: "#fdf6ec",
  inlay: "#b08d57",
  lace: "#fffaf4",
  spark: "#f4d9a4",
  drop: "#fdf6ec",
  reflect: "#f3c2d2",
};

const SKIN_DARK: RococoSkin = {
  gild: ["#ffe6ee", "#c46e86", "#7a3046"],
  bead: ["#f7ead0", "#d9bd82", "#8a6a33"],
  veil: ["#f0a860", "#b44a62", "#4a2f5c"],
  petal: "#a83c52",
  mote: "#e6cd92",
  star: "#f4e8cd",
  rail: "#241c30",
  inlay: "#b39655",
  lace: "#e6cd92",
  spark: "#e6cd92",
  drop: "#e6cd92",
  reflect: "#f0c98a",
};

const ROSE_MAP: PixelArtMap = [
  "..RRR..",
  ".RRRRR.",
  "RRPPPRR",
  "RRPDPRR",
  "RRPPPRR",
  ".RRRRR.",
  "..RRR..",
];

const FOLIAGE_MAP: PixelArtMap = [
  "....LLL....",
  "..LLLLLLL..",
  ".LLLDLLDLL.",
  "LLLLLLLLLLL",
  ".LLLDLLDLL.",
  "..LLLLLLL..",
  "....LLL....",
];

const FLASK_MAP: PixelArtMap = [
  "...G...",
  "...G...",
  "..GGG..",
  ".CCCCC.",
  "CCHHCCC",
  "CCCHCCC",
  ".CRRRC.",
  ".CRRRC.",
  ".CRRRC.",
  "..CCC..",
];

const MIRROR_MAP: PixelArtMap = [
  "..GGGGG..",
  ".GCCCCCG.",
  "GCCWWWCCG",
  "GCCWWWCCG",
  ".GCCCCCG.",
  "..GGGGG..",
  "...GGG...",
  "...GGG...",
  "..GGGGG..",
];

const CANDELABRA_STAND_MAP: PixelArtMap = [
  "..G...G..",
  "..GG.GG..",
  "...GGG...",
  "....G....",
  "..GGGGG..",
  ".GGGGGGG.",
];

const CANDELABRA_CANDLES_MAP: PixelArtMap = [
  "..W...W..",
  "..W...W..",
  "..W.W.W..",
  "..W.W.W..",
  "..WWWWW..",
];

const CANDLE_FLAME_TALL_MAP: PixelArtMap = ["..F...F..", "..Y...Y.."];

const CANDLE_FLAME_CENTER_MAP: PixelArtMap = ["....F....", "....Y...."];

const GOBLET_MAP: PixelArtMap = [
  ".RRRRR.",
  "RRRRRRR",
  ".CCCCC.",
  ".CCCCC.",
  "..CCC..",
  "..CCC..",
  "...C...",
  "...C...",
  "..GGG..",
  ".GGGGG.",
];

const VASE_MAP: PixelArtMap = [
  ".GGG.",
  "GGGGG",
  ".GGG.",
  ".GGG.",
  ".GGG.",
  "GGGGG",
];

const STEM_MAP: PixelArtMap = [".L.", ".L.", "LLL"];

const GLINT_MAP: PixelArtMap = ["..H..", "..H..", "HHHHH", "..H..", "..H.."];

const GLEAM_MAP: PixelArtMap = [".H.", "HH.", ".H."];

const BUTTERFLY_WINGS_MAP: PixelArtMap = [
  ".W.....W.",
  "WWW...WWW",
  "WWWD.DWWW",
  ".WWW.WWW.",
  "..WW.WW..",
  "...W.W...",
  "...W.W...",
];

const BUTTERFLY_BODY_MAP: PixelArtMap = [
  "..A...A..",
  "...A.A...",
  "....B....",
  "...BBB...",
  "....B....",
  "....B....",
  "....B....",
];

const MOTH_WINGS_MAP: PixelArtMap = [
  ".W.....W.",
  "WWW...WWW",
  "WWDD.DDWW",
  ".WWW.WWW.",
  "..WW.WW..",
  "...W.W...",
  "...W.W...",
];

const MOTH_BODY_MAP: PixelArtMap = [
  "..A...A..",
  "...A.A...",
  "....B....",
  "...BBB...",
  "....B....",
  "....B....",
  "....B....",
];

const WINGED_HEART_MAP: PixelArtMap = [
  ".W.HHH.W.",
  "WWWHHHWWW",
  "WWWHHHWWW",
  "..HHHHH..",
  "...HHH...",
  "....H....",
];

const MASK_MAP: PixelArtMap = [
  "..GGGGGGG..",
  ".GMMMMMMMG.",
  "GMMEEMMEEMG",
  ".GMMMMMMMG.",
  "..GG.G.GG..",
];

const MOON_MAP: PixelArtMap = [
  "..MMMM..",
  ".MMMM...",
  "MMM.....",
  "MMM.....",
  "MMM.....",
  "MMM.....",
  ".MMMM...",
  "..MMMM..",
];

const MOON_PALETTE: RococoPalette = { M: "#f4e8cd" };
const ROSE_LIGHT: RococoPalette = { R: "#c9738b", P: "#f3ccd8", D: "#a8485f" };
const ROSE_DARK: RococoPalette = { R: "#b44a62", P: "#d67d92", D: "#7e2f45" };
const LEAF_LIGHT: RococoPalette = { L: "#8aa874", D: "#64815a" };
const LEAF_DARK: RococoPalette = { L: "#567a63", D: "#3c5a49" };
const FLASK_LIGHT: RococoPalette = {
  G: "#b08d57",
  C: "#dfeaf1",
  H: "#fffaf4",
  R: "#c9738b",
};
const MIRROR_LIGHT: RococoPalette = {
  G: "#b08d57",
  C: "#e6f0f6",
  W: "#fffaf4",
};
const CANDELABRA_DARK: RococoPalette = { G: "#b39655", W: "#f2e4c6" };
const FLAME_PALETTE: RococoPalette = { F: "#ef9b3f", Y: "#ffe6a8" };
const GOBLET_DARK: RococoPalette = { R: "#8e2f4a", C: "#3b3050", G: "#b39655" };
const VASE_DARK: RococoPalette = { G: "#b39655" };
const STEM_DARK: RococoPalette = { L: "#567a63" };
const IVORY_GLINT: RococoPalette = { H: "#fffaf4" };
const GOLD_GLINT: RococoPalette = { H: "#ffeec4" };
const BUTTERFLY_WINGS: RococoPalette = { W: "#f0bcd0", D: "#cf7f9a" };
const BUTTERFLY_BODY: RococoPalette = { A: "#6b4a55", B: "#573b46" };
const MOTH_WINGS: RococoPalette = { W: "#d9cbb0", D: "#8d7b5c" };
const MOTH_BODY: RococoPalette = { A: "#241c30", B: "#2f2440" };
const HEART_WINGS: RococoPalette = { W: "#e6c68e", H: "#c0607a" };
const HEART_SHIMMER: RococoPalette = { H: "#ffdbe4" };
const MASK_GOLD: RococoPalette = { G: "#b39655" };
const MASK_BODY: RococoPalette = { M: "#2f2440" };
const MASK_EYES: RococoPalette = { E: "#ffe9bb" };

const buildLightPieces = (): [
  RococoPieceSpec,
  RococoPieceSpec,
  RococoPieceSpec,
] => [
  {
    key: "bush",
    layers: [
      { map: FOLIAGE_MAP, palette: LEAF_LIGHT, dx: 0, dy: 4 },
      { map: ROSE_MAP, palette: ROSE_LIGHT, dx: 1, dy: 0 },
      { map: ROSE_MAP, palette: ROSE_LIGHT, dx: 5, dy: 5 },
    ],
    accents: [],
    appearDelay: 600 + Math.random() * 320,
  },
  {
    key: "flask",
    layers: [{ map: FLASK_MAP, palette: FLASK_LIGHT, dx: 0, dy: 0 }],
    accents: [
      {
        className: "pixel-logo-rococo-gleam",
        layers: [{ map: GLEAM_MAP, palette: IVORY_GLINT, dx: 2, dy: 4 }],
      },
    ],
    appearDelay: 960 + Math.random() * 300,
  },
  {
    key: "mirror",
    layers: [{ map: MIRROR_MAP, palette: MIRROR_LIGHT, dx: 0, dy: 0 }],
    accents: [
      {
        className: "pixel-logo-rococo-glint",
        layers: [{ map: GLINT_MAP, palette: IVORY_GLINT, dx: 2, dy: 2 }],
      },
    ],
    appearDelay: 800 + Math.random() * 340,
  },
];

const buildDarkPieces = (): [
  RococoPieceSpec,
  RococoPieceSpec,
  RococoPieceSpec,
] => [
  {
    key: "candelabra",
    layers: [
      { map: CANDELABRA_STAND_MAP, palette: CANDELABRA_DARK, dx: 0, dy: 7 },
      { map: CANDELABRA_CANDLES_MAP, palette: CANDELABRA_DARK, dx: 0, dy: 2 },
    ],
    accents: [
      {
        className: "pixel-logo-rococo-flame",
        layers: [
          { map: CANDLE_FLAME_TALL_MAP, palette: FLAME_PALETTE, dx: 0, dy: 0 },
          {
            map: CANDLE_FLAME_CENTER_MAP,
            palette: FLAME_PALETTE,
            dx: 0,
            dy: 2,
          },
        ],
      },
    ],
    appearDelay: 620 + Math.random() * 320,
  },
  {
    key: "goblet",
    layers: [{ map: GOBLET_MAP, palette: GOBLET_DARK, dx: 0, dy: 0 }],
    accents: [
      {
        className: "pixel-logo-rococo-glint",
        layers: [{ map: GLINT_MAP, palette: GOLD_GLINT, dx: 1, dy: 0 }],
      },
    ],
    appearDelay: 960 + Math.random() * 300,
  },
  {
    key: "rose-vase",
    layers: [
      { map: VASE_MAP, palette: VASE_DARK, dx: 1, dy: 8 },
      { map: STEM_MAP, palette: STEM_DARK, dx: 2, dy: 5 },
      { map: ROSE_MAP, palette: ROSE_DARK, dx: 0, dy: 0 },
    ],
    accents: [],
    appearDelay: 800 + Math.random() * 340,
  },
];

const layerWidth = (layer: RococoLayer): number => layer.map[0]?.length ?? 0;

const layersWidth = (layers: RococoLayer[]): number =>
  layers.reduce((max, layer) => Math.max(max, layer.dx + layerWidth(layer)), 0);

const layersHeight = (layers: RococoLayer[]): number =>
  layers.reduce((max, layer) => Math.max(max, layer.dy + layer.map.length), 0);

const buildScene = (
  widthPx: number,
  heightPx: number,
  pixelSize: number,
  isDark: boolean,
): RococoScene => {
  const cell = pixelSize * 0.3;
  const railHeight = pixelSize * 0.8;
  const railY = heightPx + pixelSize * 2.3;
  const baseY = railY + railHeight * 0.4;

  const specs = isDark ? buildDarkPieces() : buildLightPieces();
  const widths = specs.map((spec) => layersWidth(spec.layers) * cell);
  const heights = specs.map((spec) => layersHeight(spec.layers) * cell);

  const leftX = widthPx * 0.06 + Math.random() * widthPx * 0.1;
  const rightX = Math.max(
    leftX + widths[0] + pixelSize * 2.4,
    widthPx * 0.93 - widths[2] - Math.random() * widthPx * 0.1,
  );
  const middleLeft = leftX + widths[0];
  const centerX = Math.max(
    middleLeft + pixelSize,
    (middleLeft + rightX) / 2 -
      widths[1] / 2 +
      (Math.random() - 0.5) * widthPx * 0.06,
  );

  const pieces: RococoPiece[] = specs.map((spec, index) => ({
    ...spec,
    x: index === 0 ? leftX : index === 1 ? centerX : rightX,
    top: baseY - heights[index],
    cell,
  }));

  const wingsMap = isDark ? MOTH_WINGS_MAP : BUTTERFLY_WINGS_MAP;
  const bodyMap = isDark ? MOTH_BODY_MAP : BUTTERFLY_BODY_MAP;
  const walkerWidth = (wingsMap[0]?.length ?? 0) * cell;
  const walkerHeight = wingsMap.length * cell;
  const walkerX = Math.max(
    pixelSize * 0.6,
    rightX - walkerWidth - pixelSize * 2.6,
  );

  const charmLayers: RococoLayer[] = [
    {
      map: isDark ? MASK_MAP : WINGED_HEART_MAP,
      palette: isDark ? MASK_BODY : HEART_WINGS,
      dx: 0,
      dy: 0,
    },
  ];
  const charmAccents: RococoAccent[] = isDark
    ? [
        {
          className: "pixel-logo-rococo-eyes",
          layers: [{ map: MASK_MAP, palette: MASK_EYES, dx: 0, dy: 0 }],
        },
        {
          className: "pixel-logo-rococo-rim",
          layers: [{ map: MASK_MAP, palette: MASK_GOLD, dx: 0, dy: 0 }],
        },
      ]
    : [
        {
          className: "pixel-logo-rococo-glint",
          layers: [
            { map: WINGED_HEART_MAP, palette: HEART_SHIMMER, dx: 0, dy: 0 },
          ],
        },
      ];
  const charmWidth = layersWidth(charmLayers) * cell;
  const charmHeight = layersHeight(charmLayers) * cell;

  const railX = Math.min(leftX, walkerX) - pixelSize * 1.5;
  const railWidth =
    Math.max(rightX + widths[2], centerX + widths[1]) + pixelSize * 1.5 - railX;
  const beadSize = Math.max(1.2, pixelSize * 0.26);
  const beadStep = beadSize * 3.6;
  const beadCount = Math.max(
    3,
    Math.floor((railWidth - beadSize * 2) / beadStep),
  );

  return {
    pieces,
    walker: {
      x: walkerX,
      top: railY - walkerHeight - pixelSize * 0.4,
      cell,
      from: -(walkerX + pixelSize * 10),
      delay: 1.4 + Math.random() * 0.8,
      wings: {
        map: wingsMap,
        palette: isDark ? MOTH_WINGS : BUTTERFLY_WINGS,
        dx: 0,
        dy: 0,
      },
      body: {
        map: bodyMap,
        palette: isDark ? MOTH_BODY : BUTTERFLY_BODY,
        dx: 0,
        dy: 0,
      },
    },
    charm: {
      x: widthPx * (0.6 + Math.random() * 0.24) - charmWidth / 2,
      top: heightPx * 0.4,
      cell,
      layers: charmLayers,
      accents: charmAccents,
      delay: 1.6 + Math.random() * 0.6,
      rise: heightPx * (2.2 + Math.random() * 0.6) + charmHeight,
    },
    rail: {
      x: railX,
      y: railY,
      width: railWidth,
      height: railHeight,
      inlay: {
        x: railX + pixelSize * 0.3,
        y: railY + railHeight * 0.16,
        width: Math.max(0, railWidth - pixelSize * 0.6),
        height: Math.max(1, railHeight * 0.2),
      },
      beads: Array.from({ length: beadCount }, (_, index) => ({
        key: `bead-${index}`,
        x: railX + beadSize * 1.6 + index * beadStep,
        y: railY + railHeight * 0.56,
        size: beadSize,
      })),
    },
    veils: [
      {
        key: 0,
        cx: widthPx / 2,
        cy: -pixelSize * 2.2,
        rx: widthPx * 0.55,
        ry: pixelSize * 1.7,
        opacity: 1,
        reverse: false,
      },
      {
        key: 1,
        cx: widthPx * 0.4,
        cy: -pixelSize * 3.5,
        rx: widthPx * 0.4,
        ry: pixelSize * 1.1,
        opacity: 0.62,
        reverse: true,
      },
    ],
    motes: Array.from({ length: 6 }, (_, index) => ({
      key: index,
      x: Math.random() * widthPx,
      y: pixelSize * (1.6 + Math.random() * 3.6),
      size: 0.8 + Math.random() * 1.1,
      delay: Math.random() * 5,
      duration: 4.5 + Math.random() * 3.5,
      drift: (Math.random() - 0.5) * 10,
      rise: pixelSize * (5 + Math.random() * 4),
    })),
    moon: isDark
      ? { x: widthPx * 0.54, y: -pixelSize * 5.4, cell: pixelSize * 0.34 }
      : null,
    stars: isDark
      ? Array.from({ length: 5 }, (_, index) => ({
          key: index,
          x: Math.random() * widthPx,
          y: -pixelSize * (1.4 + Math.random() * 3),
          size: 0.5 + Math.random() * 0.7,
          delay: Math.random() * 3,
          duration: 1.8 + Math.random() * 2.2,
        }))
      : [],
    petals: Array.from(
      { length: Math.max(16, Math.round(widthPx / 5)) },
      (_, index) => ({
        key: index,
        x: Math.random() * widthPx,
        width: 1.1 + Math.random() * 1.5,
        height: 0.9 + Math.random() * 1.3,
        delay: -Math.random() * 5,
        duration: 3.2 + Math.random() * 3.6,
        opacity: 0.5 + Math.random() * 0.45,
        drift: (Math.random() - 0.5) * 14,
        spin: 90 + Math.random() * 320,
      }),
    ),
    decoDelay: 300 + Math.random() * 150,
    fadeDelay: Math.random() * 120,
    veilDelay: Math.random() * 120,
  };
};

export const RococoPixelLogo = ({
  text = "SNOW APP",
  pixelSize = 3,
  letterGap = 1,
  lineGap = 0,
  color = "currentColor",
  className,
  isDark,
}: RococoPixelLogoProps): JSX.Element => {
  const [hovered, setHovered] = useState(false);
  const uid = useId().replace(/:/g, "");
  const gildGradientId = `pixel-logo-rococo-gild-${uid}`;
  const beadGradientId = `pixel-logo-rococo-bead-${uid}`;
  const veilGradientId = `pixel-logo-rococo-veil-${uid}`;
  const reflectFadeId = `pixel-logo-rococo-reflect-fade-${uid}`;
  const reflectMaskId = `pixel-logo-rococo-reflect-mask-${uid}`;
  const clipId = `pixel-logo-rococo-clip-${uid}`;

  const skin = isDark ? SKIN_DARK : SKIN_LIGHT;
  const chars = text.split("");
  const rows = 1;

  const totalWidth =
    chars.length * LETTER_WIDTH + Math.max(0, chars.length - 1) * letterGap;
  const totalHeight = rows * LETTER_HEIGHT + Math.max(0, rows - 1) * lineGap;

  const widthPx = totalWidth * pixelSize;
  const heightPx = totalHeight * pixelSize;

  const cells = useMemo(() => buildCells(chars, letterGap), [text, letterGap]);

  const scene = useMemo(
    () => buildScene(widthPx, heightPx, pixelSize, isDark),
    [widthPx, heightPx, pixelSize, isDark],
  );

  const strands = useMemo<RococoStrand[]>(() => {
    const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    const bottomCells = cells.filter(
      (cell) => !occupied.has(`${cell.x},${cell.y + 1}`),
    );
    if (bottomCells.length === 0) {
      return [];
    }
    const shuffled = [...bottomCells].sort(() => Math.random() - 0.5);
    const count = Math.min(shuffled.length, 5 + Math.floor(Math.random() * 4));
    return shuffled.slice(0, count).map((cell, index) => {
      const length = 2 + Math.floor(Math.random() * 3);
      const hasDrop = length >= 3 && Math.random() < 0.5;
      return {
        key: `strand-${index}-${cell.x}-${cell.y}`,
        x: cell.x * pixelSize,
        y: (cell.y + 1) * pixelSize,
        length,
        growDelay: 220 + Math.random() * 780,
        fadeDelay: Math.random() * 150,
        drop: hasDrop
          ? {
              delay: 1.1 + Math.random() * 2.8,
              duration: 1.7 + Math.random() * 1.4,
              fall: 10 + Math.random() * 8,
            }
          : null,
      };
    });
  }, [cells, pixelSize]);

  const lace = useMemo<RococoLace[]>(() => {
    const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    return cells
      .filter((cell) => !occupied.has(`${cell.x},${cell.y - 1}`))
      .map((cell) => ({
        key: `lace-${cell.x}-${cell.y}`,
        x: cell.x * pixelSize,
        y: cell.y * pixelSize,
        tall: (cell.x * 5 + cell.y * 11) % 3 === 0,
        delay: 260 + cell.jitter * 3,
        fadeDelay: cell.jitter,
      }));
  }, [cells, pixelSize]);

  const sparks = useMemo<RococoSpark[]>(() => {
    const shuffled = [...cells].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 6).map((cell, index) => ({
      key: `spark-${index}`,
      cx: (cell.x + 0.5) * pixelSize,
      cy: (cell.y + 0.5) * pixelSize,
      size: pixelSize * (0.5 + Math.random() * 0.45),
      delay: 1.1 + Math.random() * 2.6,
      duration: 1.9 + Math.random() * 1.8,
    }));
  }, [cells, pixelSize]);

  const getGildDelay = (cell: PixelCell): number =>
    hovered
      ? cell.rowIndex * 80 + cell.jitter
      : (LETTER_HEIGHT - 1 - cell.rowIndex) * 50 + cell.jitter;

  const svgClassName = [
    "pixel-logo",
    "is-rococo",
    hovered ? "is-alive is-petaling" : "",
    hovered ? (isDark ? "is-lit" : "is-bloomed") : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={svgClassName}
      width={widthPx}
      height={heightPx}
      viewBox={`0 0 ${widthPx} ${heightPx}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-label={text}
      role="img"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <defs>
        <linearGradient
          id={gildGradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2={heightPx}
        >
          <stop offset="0" stopColor={skin.gild[0]} />
          <stop offset="0.45" stopColor={skin.gild[1]} />
          <stop offset="1" stopColor={skin.gild[2]} />
        </linearGradient>
        <linearGradient id={beadGradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skin.bead[0]} />
          <stop offset="0.55" stopColor={skin.bead[1]} />
          <stop offset="1" stopColor={skin.bead[2]} />
        </linearGradient>
        <linearGradient id={veilGradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={skin.veil[0]} stopOpacity="0" />
          <stop offset="0.28" stopColor={skin.veil[0]} stopOpacity="0.6" />
          <stop offset="0.58" stopColor={skin.veil[1]} stopOpacity="0.75" />
          <stop offset="0.82" stopColor={skin.veil[2]} stopOpacity="0.45" />
          <stop offset="1" stopColor={skin.veil[2]} stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={reflectFadeId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={heightPx}
          x2="0"
          y2={heightPx + heightPx * REFLECTION_SCALE}
        >
          <stop offset="0" stopColor={skin.reflect} stopOpacity="0.45" />
          <stop offset="1" stopColor={skin.reflect} stopOpacity="0" />
        </linearGradient>
        <mask
          id={reflectMaskId}
          maskUnits="userSpaceOnUse"
          x={0}
          y={heightPx}
          width={widthPx}
          height={heightPx * REFLECTION_SCALE}
        >
          <rect
            x={0}
            y={heightPx}
            width={widthPx}
            height={heightPx * REFLECTION_SCALE}
            fill={`url(#${reflectFadeId})`}
          />
        </mask>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={widthPx} height={heightPx} />
        </clipPath>
      </defs>
      <g
        aria-hidden="true"
        className="pixel-logo-rococo-veil"
        style={{ transitionDelay: `${hovered ? 1000 : scene.veilDelay}ms` }}
      >
        {scene.veils.map((veil) => (
          <ellipse
            key={veil.key}
            className="pixel-logo-rococo-band"
            cx={veil.cx}
            cy={veil.cy}
            rx={veil.rx}
            ry={veil.ry}
            opacity={veil.opacity}
            fill={`url(#${veilGradientId})`}
            style={veil.reverse ? { animationDirection: "reverse" } : undefined}
          />
        ))}
        {scene.moon && (
          <g className="pixel-logo-rococo-moon">
            {renderPixelArt(
              MOON_MAP,
              MOON_PALETTE,
              scene.moon.x,
              scene.moon.y,
              scene.moon.cell,
              "moon",
            )}
          </g>
        )}
        {scene.stars.map((star) => (
          <rect
            key={`star-${star.key}`}
            className="pixel-logo-rococo-star"
            x={star.x}
            y={star.y}
            width={star.size}
            height={star.size}
            fill={skin.star}
            style={{
              animationDuration: `${star.duration}s`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
        {scene.motes.map((mote) => (
          <rect
            key={`mote-${mote.key}`}
            className="pixel-logo-rococo-mote"
            x={mote.x}
            y={mote.y}
            width={mote.size}
            height={mote.size}
            rx={mote.size / 2}
            fill={skin.mote}
            style={
              {
                animationDuration: `${mote.duration}s`,
                animationDelay: `${mote.delay}s`,
                "--mote-rise": `${mote.rise}px`,
                "--mote-drift": `${mote.drift}px`,
              } as CSSProperties
            }
          />
        ))}
      </g>
      <g
        aria-hidden="true"
        className="pixel-logo-rococo-reflection"
        mask={`url(#${reflectMaskId})`}
        style={{ transitionDelay: `${hovered ? 720 : 60}ms` }}
      >
        <g
          transform={`translate(0 ${heightPx * (1 + REFLECTION_SCALE)}) scale(1 ${-REFLECTION_SCALE})`}
        >
          {cells.map((cell) => (
            <rect
              key={`reflect-${cell.key}`}
              x={cell.x * pixelSize}
              y={cell.y * pixelSize}
              width={pixelSize}
              height={pixelSize}
              fill={`url(#${gildGradientId})`}
            />
          ))}
        </g>
      </g>
      <g aria-hidden="true">
        <g
          className="pixel-logo-rococo-deco"
          style={{
            transitionDelay: `${hovered ? scene.decoDelay : scene.fadeDelay}ms`,
          }}
        >
          <rect
            x={scene.rail.x}
            y={scene.rail.y}
            width={scene.rail.width}
            height={scene.rail.height}
            rx={scene.rail.height / 2}
            fill={skin.rail}
          />
          <rect
            x={scene.rail.inlay.x}
            y={scene.rail.inlay.y}
            width={scene.rail.inlay.width}
            height={scene.rail.inlay.height}
            rx={scene.rail.inlay.height / 2}
            fill={skin.inlay}
          />
          {scene.rail.beads.map((bead) => (
            <rect
              key={bead.key}
              x={bead.x}
              y={bead.y}
              width={bead.size}
              height={bead.size}
              rx={bead.size / 2}
              fill={skin.inlay}
            />
          ))}
        </g>
        {scene.pieces.map((piece) => (
          <g
            key={piece.key}
            className="pixel-logo-rococo-deco"
            style={{
              transitionDelay: `${hovered ? piece.appearDelay : scene.fadeDelay}ms`,
            }}
          >
            {piece.layers.flatMap((layer, layerIndex) =>
              renderPixelArt(
                layer.map,
                layer.palette,
                piece.x + layer.dx * piece.cell,
                piece.top + layer.dy * piece.cell,
                piece.cell,
                `${piece.key}-${layerIndex}`,
              ),
            )}
            {piece.accents.map((accent) => (
              <g
                key={`${piece.key}-${accent.className}`}
                className={accent.className}
              >
                {accent.layers.flatMap((layer, layerIndex) =>
                  renderPixelArt(
                    layer.map,
                    layer.palette,
                    piece.x + layer.dx * piece.cell,
                    piece.top + layer.dy * piece.cell,
                    piece.cell,
                    `${piece.key}-${accent.className}-${layerIndex}`,
                  ),
                )}
              </g>
            ))}
          </g>
        ))}
        <g
          className="pixel-logo-rococo-walker"
          style={
            {
              "--walker-from": `${scene.walker.from}px`,
              animationDelay: `${scene.walker.delay}s`,
            } as CSSProperties
          }
        >
          <g className="pixel-logo-rococo-walker-wings">
            {renderPixelArt(
              scene.walker.wings.map,
              scene.walker.wings.palette,
              scene.walker.x,
              scene.walker.top,
              scene.walker.cell,
              "walker-wings",
            )}
          </g>
          <g className="pixel-logo-rococo-walker-body">
            {renderPixelArt(
              scene.walker.body.map,
              scene.walker.body.palette,
              scene.walker.x,
              scene.walker.top,
              scene.walker.cell,
              "walker-body",
            )}
          </g>
        </g>
        <g
          className="pixel-logo-rococo-charm"
          style={
            {
              "--charm-rise": `${scene.charm.rise}px`,
              animationDelay: `${scene.charm.delay}s`,
            } as CSSProperties
          }
        >
          {scene.charm.layers.flatMap((layer, layerIndex) =>
            renderPixelArt(
              layer.map,
              layer.palette,
              scene.charm.x + layer.dx * scene.charm.cell,
              scene.charm.top + layer.dy * scene.charm.cell,
              scene.charm.cell,
              `charm-${layerIndex}`,
            ),
          )}
          {scene.charm.accents.map((accent) => (
            <g key={`charm-${accent.className}`} className={accent.className}>
              {accent.layers.flatMap((layer, layerIndex) =>
                renderPixelArt(
                  layer.map,
                  layer.palette,
                  scene.charm.x + layer.dx * scene.charm.cell,
                  scene.charm.top + layer.dy * scene.charm.cell,
                  scene.charm.cell,
                  `charm-${accent.className}-${layerIndex}`,
                ),
              )}
            </g>
          ))}
        </g>
      </g>
      {cells.map((cell) => (
        <rect
          key={cell.key}
          x={cell.x * pixelSize}
          y={cell.y * pixelSize}
          width={pixelSize}
          height={pixelSize}
          fill={color}
        />
      ))}
      <g aria-hidden="true">
        {cells.map((cell) => (
          <rect
            key={`gild-${cell.key}`}
            className="pixel-logo-rococo-gild"
            x={cell.x * pixelSize}
            y={cell.y * pixelSize}
            width={pixelSize}
            height={pixelSize}
            fill={`url(#${gildGradientId})`}
            style={{ transitionDelay: `${getGildDelay(cell)}ms` }}
          />
        ))}
      </g>
      <g aria-hidden="true">
        {lace.map((cap) => (
          <g
            key={cap.key}
            className="pixel-logo-rococo-lace"
            style={{
              transitionDelay: `${hovered ? cap.delay : cap.fadeDelay}ms`,
            }}
          >
            <rect
              x={cap.x}
              y={cap.y - pixelSize * 0.24}
              width={pixelSize}
              height={pixelSize * 0.68}
              rx={pixelSize * 0.32}
              fill={skin.lace}
            />
            {cap.tall && (
              <rect
                x={cap.x + pixelSize * 0.18}
                y={cap.y - pixelSize * 0.6}
                width={pixelSize * 0.64}
                height={pixelSize * 0.42}
                rx={pixelSize * 0.22}
                fill={skin.lace}
              />
            )}
          </g>
        ))}
      </g>
      <g aria-hidden="true">
        {strands.map((strand) => (
          <g
            key={strand.key}
            className="pixel-logo-rococo-strand"
            style={{
              transitionDelay: `${
                hovered ? strand.growDelay : strand.fadeDelay
              }ms`,
            }}
          >
            {Array.from({ length: strand.length }, (_, row) => {
              const taper =
                STRAND_TAPER[Math.min(row, STRAND_TAPER.length - 1)];
              const size = pixelSize * taper;
              return (
                <rect
                  key={`${strand.key}-pearl-${row}`}
                  x={strand.x + (pixelSize - size) / 2}
                  y={strand.y + row * pixelSize}
                  width={size}
                  height={size}
                  rx={size / 2}
                  fill={`url(#${beadGradientId})`}
                />
              );
            })}
            {strand.drop && (
              <rect
                className="pixel-logo-rococo-drop"
                x={strand.x + pixelSize * 0.34}
                y={strand.y + strand.length * pixelSize}
                width={pixelSize * 0.32}
                height={pixelSize * 0.32}
                rx={pixelSize * 0.16}
                fill={skin.drop}
                style={
                  {
                    animationDuration: `${strand.drop.duration}s`,
                    animationDelay: `${strand.drop.delay}s`,
                    "--drop-fall": `${strand.drop.fall}px`,
                  } as CSSProperties
                }
              />
            )}
          </g>
        ))}
      </g>
      <g aria-hidden="true">
        {sparks.map((spark) => (
          <path
            key={spark.key}
            className="pixel-logo-rococo-spark"
            d={sparklePath(spark.size)}
            transform={`translate(${spark.cx} ${spark.cy})`}
            fill={skin.spark}
            style={{
              animationDuration: `${spark.duration}s`,
              animationDelay: `${spark.delay}s`,
            }}
          />
        ))}
      </g>
      <g aria-hidden="true" clipPath={`url(#${clipId})`}>
        {scene.petals.map((petal) => (
          <rect
            key={`petal-${petal.key}`}
            className="pixel-logo-rococo-petal"
            x={petal.x}
            y={0}
            width={petal.width}
            height={petal.height}
            rx={petal.height * 0.45}
            fill={skin.petal}
            style={
              {
                animationDuration: `${petal.duration}s`,
                animationDelay: `${petal.delay}s`,
                "--petal-opacity": petal.opacity,
                "--petal-drift": `${petal.drift}px`,
                "--petal-fall": `${heightPx + 10}px`,
                "--petal-spin": `${petal.spin}deg`,
              } as CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
};

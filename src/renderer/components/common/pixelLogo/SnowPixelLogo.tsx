import { useId, useMemo, useState } from "react";

import {
  buildCells,
  LETTER_HEIGHT,
  LETTER_WIDTH,
  renderPixelArt,
  sparklePath,
} from "./pixelArt";
import type { PixelArtMap, PixelCell, PixelLogoProps } from "./pixelArt";

const SNOWMAN_MAP: PixelArtMap = [
  "..WWW..",
  ".WWWWW.",
  ".WBWBW.",
  ".WWOWW.",
  ".WWWWW.",
  "WWWBWWW",
  "WWWWWWW",
  ".WWWWW.",
];

const SNOWMAN_PALETTE: Record<string, string> = {
  W: "#f6fbff",
  B: "#2c3e50",
  O: "#f59e0b",
};

const IGLOO_MAP: PixelArtMap = [
  "...III...",
  ".IIIIIII.",
  "IIDIIIDII",
  "IIIKKKIII",
  "IIKKKKKII",
  "IIKKKKKII",
];

const IGLOO_PALETTE: Record<string, string> = {
  I: "#dceefb",
  D: "#a9d2ec",
  K: "#22364e",
};

const PENGUIN_MAP: PixelArtMap = [
  "..KKK..",
  ".KKKKK.",
  ".KWWWK.",
  ".KWOWK.",
  "KKWWWKK",
  "KWWWWWK",
  ".KWWWK.",
  ".O...O.",
];

const PENGUIN_PALETTE: Record<string, string> = {
  K: "#1f2937",
  W: "#f8fafc",
  O: "#fb923c",
};

const CAMPFIRE_FLAME_MAP: PixelArtMap = [
  "..O..",
  ".OOO.",
  "OOYOO",
  "OYYYO",
  ".OOO.",
];

const CAMPFIRE_LOGS_MAP: PixelArtMap = ["L...L", "LLLLL"];

const CAMPFIRE_PALETTE: Record<string, string> = {
  O: "#f97316",
  Y: "#fde047",
  L: "#8b5a2b",
};

const REFLECTION_SCALE = 0.32;

type Snowflake = {
  key: number;
  x: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
  drift: number;
};

type IcicleDrip = {
  delay: number;
  duration: number;
  fall: number;
};

type Icicle = {
  key: string;
  x: number;
  y: number;
  length: number;
  growDelay: number;
  meltDelay: number;
  drip: IcicleDrip | null;
};

type SnowCap = {
  key: string;
  x: number;
  y: number;
  tall: boolean;
  jitter: number;
  delay: number;
};

type Sparkle = {
  key: string;
  cx: number;
  cy: number;
  size: number;
  delay: number;
  duration: number;
};

type Star = {
  key: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
};

type DecoPiece = {
  key: string;
  map: PixelArtMap;
  palette: Record<string, string>;
  x: number;
  baseY: number;
  cell: number;
  appearDelay: number;
};

type Campfire = {
  x: number;
  baseY: number;
  cell: number;
  appearDelay: number;
};

type Penguin = {
  x: number;
  baseY: number;
  cell: number;
  from: number;
  delay: number;
};

type Decorations = {
  pieces: DecoPiece[];
  campfire: Campfire;
  penguin: Penguin;
  ground: { x: number; y: number; width: number; height: number };
  groundDelay: number;
  meltDelay: number;
};

const ICICLE_TAPER = [1, 0.7, 0.45, 0.25];

const buildDecorations = (
  widthPx: number,
  heightPx: number,
  pixelSize: number,
): Decorations => {
  const cell = pixelSize * 0.3;
  const groundHeight = pixelSize * 0.8;
  const groundY = heightPx + pixelSize * 2.3;
  const baseY = groundY + groundHeight * 0.4;

  const iglooWidth = IGLOO_MAP[0].length * cell;
  const snowmanWidth = SNOWMAN_MAP[0].length * cell;
  const penguinWidth = PENGUIN_MAP[0].length * cell;
  const campfireWidth = CAMPFIRE_LOGS_MAP[0].length * cell;

  const iglooX = widthPx * 0.08 + Math.random() * widthPx * 0.15;
  const snowmanX =
    widthPx * 0.92 - snowmanWidth - Math.random() * widthPx * 0.15;

  const middleLeft = iglooX + iglooWidth;
  const middleRight = snowmanX;
  const campfireX = Math.max(
    middleLeft + pixelSize,
    (middleLeft + middleRight) / 2 -
      campfireWidth / 2 +
      (Math.random() - 0.5) * widthPx * 0.08,
  );

  const penguinX = Math.max(
    pixelSize * 0.5,
    snowmanX - penguinWidth - pixelSize * 0.8,
  );

  const groundX = Math.min(iglooX, penguinX) - pixelSize * 1.5;
  const groundRight =
    Math.max(snowmanX + snowmanWidth, campfireX + campfireWidth) +
    pixelSize * 1.5;

  return {
    pieces: [
      {
        key: "igloo",
        map: IGLOO_MAP,
        palette: IGLOO_PALETTE,
        x: iglooX,
        baseY,
        cell,
        appearDelay: 550 + Math.random() * 300,
      },
      {
        key: "snowman",
        map: SNOWMAN_MAP,
        palette: SNOWMAN_PALETTE,
        x: snowmanX,
        baseY,
        cell,
        appearDelay: 800 + Math.random() * 350,
      },
    ],
    campfire: {
      x: campfireX,
      baseY,
      cell,
      appearDelay: 950 + Math.random() * 300,
    },
    penguin: {
      x: penguinX,
      baseY,
      cell,
      from: -(penguinX + pixelSize * 10),
      delay: 1.4 + Math.random() * 0.8,
    },
    ground: {
      x: groundX,
      y: groundY,
      width: groundRight - groundX,
      height: groundHeight,
    },
    groundDelay: 300 + Math.random() * 150,
    meltDelay: Math.random() * 120,
  };
};

export const SnowPixelLogo = ({
  text = "SNOW APP",
  pixelSize = 3,
  letterGap = 1,
  lineGap = 0,
  color = "currentColor",
  className,
}: PixelLogoProps): React.JSX.Element => {
  const [hovered, setHovered] = useState(false);
  const uid = useId().replace(/:/g, "");
  const frostGradientId = `pixel-logo-frost-${uid}`;
  const icicleGradientId = `pixel-logo-icicle-${uid}`;
  const auroraGradientId = `pixel-logo-aurora-${uid}`;
  const reflectFadeId = `pixel-logo-reflect-fade-${uid}`;
  const reflectMaskId = `pixel-logo-reflect-mask-${uid}`;
  const clipId = `pixel-logo-clip-${uid}`;

  const chars = text.split("");
  const rows = 1;

  const totalWidth =
    chars.length * LETTER_WIDTH + Math.max(0, chars.length - 1) * letterGap;
  const totalHeight = rows * LETTER_HEIGHT + Math.max(0, rows - 1) * lineGap;

  const widthPx = totalWidth * pixelSize;
  const heightPx = totalHeight * pixelSize;

  const cells = useMemo(
    () => buildCells(text.split(""), letterGap),
    [text, letterGap],
  );

  const snowflakes = useMemo<Snowflake[]>(() => {
    const count = Math.max(16, Math.round(widthPx / 5));
    return Array.from({ length: count }, (_, index) => ({
      key: index,
      x: Math.random() * widthPx,
      size: 0.7 + Math.random() * 1.1,
      delay: -Math.random() * 4,
      duration: 2.4 + Math.random() * 2.6,
      opacity: 0.55 + Math.random() * 0.45,
      drift: (Math.random() - 0.5) * 8,
    }));
  }, [widthPx]);

  const icicles = useMemo<Icicle[]>(() => {
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
      const hasDrip = length >= 3 && Math.random() < 0.5;
      return {
        key: `icicle-${index}-${cell.x}-${cell.y}`,
        x: cell.x * pixelSize,
        y: (cell.y + 1) * pixelSize,
        length,
        growDelay: 200 + Math.random() * 800,
        meltDelay: Math.random() * 150,
        drip: hasDrip
          ? {
              delay: 1 + Math.random() * 3,
              duration: 1.6 + Math.random() * 1.4,
              fall: 10 + Math.random() * 8,
            }
          : null,
      };
    });
  }, [cells, pixelSize]);

  const snowCaps = useMemo<SnowCap[]>(() => {
    const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    return cells
      .filter((cell) => !occupied.has(`${cell.x},${cell.y - 1}`))
      .map((cell) => ({
        key: `cap-${cell.x}-${cell.y}`,
        x: cell.x * pixelSize,
        y: cell.y * pixelSize,
        tall: (cell.x * 7 + cell.y * 13) % 3 === 0,
        jitter: cell.jitter,
        delay: 250 + cell.jitter * 3,
      }));
  }, [cells, pixelSize]);

  const sparkles = useMemo<Sparkle[]>(() => {
    const shuffled = [...cells].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 6).map((cell, index) => ({
      key: `sparkle-${index}`,
      cx: (cell.x + 0.5) * pixelSize,
      cy: (cell.y + 0.5) * pixelSize,
      size: pixelSize * (0.5 + Math.random() * 0.4),
      delay: 1.2 + Math.random() * 2.5,
      duration: 1.8 + Math.random() * 1.6,
    }));
  }, [cells, pixelSize]);

  const stars = useMemo<Star[]>(
    () =>
      Array.from({ length: 5 }, (_, index) => ({
        key: index,
        x: Math.random() * widthPx,
        y: -pixelSize * (1.2 + Math.random() * 2.5),
        size: 0.5 + Math.random() * 0.6,
        delay: Math.random() * 3,
        duration: 1.6 + Math.random() * 2,
      })),
    [widthPx, pixelSize],
  );

  const decorations = useMemo(
    () => buildDecorations(widthPx, heightPx, pixelSize),
    [widthPx, heightPx, pixelSize],
  );

  const getFrostDelay = (cell: PixelCell): number =>
    hovered
      ? cell.rowIndex * 90 + cell.jitter
      : (LETTER_HEIGHT - 1 - cell.rowIndex) * 55 + cell.jitter;

  const svgClassName = [
    "pixel-logo",
    hovered ? "is-frozen is-snowing" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const campfireTop =
    decorations.campfire.baseY -
    (CAMPFIRE_LOGS_MAP.length + CAMPFIRE_FLAME_MAP.length) *
      decorations.campfire.cell;
  const penguinTop =
    decorations.penguin.baseY - PENGUIN_MAP.length * decorations.penguin.cell;

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
          id={frostGradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2={heightPx}
        >
          <stop offset="0" stopColor="#eaf7ff" />
          <stop offset="0.45" stopColor="#9bd8ff" />
          <stop offset="1" stopColor="#3f9fe6" />
        </linearGradient>
        <linearGradient id={icicleGradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4fbff" />
          <stop offset="0.55" stopColor="#b9e3f9" />
          <stop offset="1" stopColor="#7fc8ef" />
        </linearGradient>
        <linearGradient id={auroraGradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#34d399" stopOpacity="0" />
          <stop offset="0.25" stopColor="#34d399" stopOpacity="0.7" />
          <stop offset="0.5" stopColor="#22d3ee" stopOpacity="0.8" />
          <stop offset="0.75" stopColor="#a78bfa" stopOpacity="0.7" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={reflectFadeId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={heightPx}
          x2="0"
          y2={heightPx + heightPx * REFLECTION_SCALE}
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
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
        className="pixel-logo-sky"
        style={{ transitionDelay: `${hovered ? 1100 : 100}ms` }}
      >
        <ellipse
          className="pixel-logo-aurora-band"
          cx={widthPx / 2}
          cy={-pixelSize * 2.2}
          rx={widthPx * 0.55}
          ry={pixelSize * 1.7}
          fill={`url(#${auroraGradientId})`}
        />
        <ellipse
          className="pixel-logo-aurora-band"
          cx={widthPx * 0.4}
          cy={-pixelSize * 3.4}
          rx={widthPx * 0.4}
          ry={pixelSize * 1.1}
          fill={`url(#${auroraGradientId})`}
          opacity={0.6}
          style={{ animationDirection: "reverse" }}
        />
        {stars.map((star) => (
          <rect
            key={`star-${star.key}`}
            className="pixel-logo-star"
            x={star.x}
            y={star.y}
            width={star.size}
            height={star.size}
            style={{
              animationDuration: `${star.duration}s`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </g>
      <g
        aria-hidden="true"
        className="pixel-logo-reflection"
        mask={`url(#${reflectMaskId})`}
        style={{ transitionDelay: `${hovered ? 700 : 60}ms` }}
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
              fill={`url(#${frostGradientId})`}
            />
          ))}
        </g>
      </g>
      <g aria-hidden="true">
        <g
          className="pixel-logo-deco"
          style={{
            transitionDelay: `${
              hovered ? decorations.groundDelay : decorations.meltDelay
            }ms`,
          }}
        >
          <rect
            x={decorations.ground.x}
            y={decorations.ground.y}
            width={decorations.ground.width}
            height={decorations.ground.height}
            rx={decorations.ground.height / 2}
            fill="#e9f5fd"
          />
        </g>
        {decorations.pieces.map((piece) => (
          <g
            key={piece.key}
            className="pixel-logo-deco"
            style={{
              transitionDelay: `${
                hovered ? piece.appearDelay : decorations.meltDelay
              }ms`,
            }}
          >
            {renderPixelArt(
              piece.map,
              piece.palette,
              piece.x,
              piece.baseY - piece.map.length * piece.cell,
              piece.cell,
              piece.key,
            )}
          </g>
        ))}
        <g
          className="pixel-logo-deco"
          style={{
            transitionDelay: `${
              hovered ? decorations.campfire.appearDelay : decorations.meltDelay
            }ms`,
          }}
        >
          {renderPixelArt(
            CAMPFIRE_LOGS_MAP,
            CAMPFIRE_PALETTE,
            decorations.campfire.x,
            decorations.campfire.baseY -
              CAMPFIRE_LOGS_MAP.length * decorations.campfire.cell,
            decorations.campfire.cell,
            "logs",
          )}
          <g className="pixel-logo-flame">
            {renderPixelArt(
              CAMPFIRE_FLAME_MAP,
              CAMPFIRE_PALETTE,
              decorations.campfire.x,
              campfireTop,
              decorations.campfire.cell,
              "flame",
            )}
          </g>
        </g>
        <g
          className="pixel-logo-penguin"
          style={
            {
              "--penguin-from": `${decorations.penguin.from}px`,
              animationDelay: `${decorations.penguin.delay}s`,
            } as React.CSSProperties
          }
        >
          <g className="pixel-logo-penguin-body">
            {renderPixelArt(
              PENGUIN_MAP,
              PENGUIN_PALETTE,
              decorations.penguin.x,
              penguinTop,
              decorations.penguin.cell,
              "penguin",
            )}
          </g>
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
            key={`frost-${cell.key}`}
            className="pixel-logo-pixel-frost"
            x={cell.x * pixelSize}
            y={cell.y * pixelSize}
            width={pixelSize}
            height={pixelSize}
            fill={`url(#${frostGradientId})`}
            style={{ transitionDelay: `${getFrostDelay(cell)}ms` }}
          />
        ))}
      </g>
      <g aria-hidden="true">
        {snowCaps.map((cap) => (
          <g
            key={cap.key}
            className="pixel-logo-snowcap"
            style={{
              transitionDelay: `${hovered ? cap.delay : cap.jitter}ms`,
            }}
          >
            <rect
              x={cap.x}
              y={cap.y - pixelSize * 0.2}
              width={pixelSize}
              height={pixelSize * 0.6}
              rx={pixelSize * 0.28}
              fill="#f4faff"
            />
            {cap.tall && (
              <rect
                x={cap.x + pixelSize * 0.15}
                y={cap.y - pixelSize * 0.55}
                width={pixelSize * 0.7}
                height={pixelSize * 0.4}
                rx={pixelSize * 0.2}
                fill="#f4faff"
              />
            )}
          </g>
        ))}
      </g>
      <g aria-hidden="true">
        {icicles.map((icicle) => (
          <g
            key={icicle.key}
            className="pixel-logo-icicle"
            style={{
              transitionDelay: `${
                hovered ? icicle.growDelay : icicle.meltDelay
              }ms`,
            }}
          >
            {Array.from({ length: icicle.length }, (_, row) => {
              const taper =
                ICICLE_TAPER[Math.min(row, ICICLE_TAPER.length - 1)];
              const width = pixelSize * taper;
              return (
                <rect
                  key={`${icicle.key}-row-${row}`}
                  x={icicle.x + (pixelSize - width) / 2}
                  y={icicle.y + row * pixelSize}
                  width={width}
                  height={pixelSize}
                  fill={`url(#${icicleGradientId})`}
                />
              );
            })}
            {icicle.drip && (
              <rect
                className="pixel-logo-drip"
                x={icicle.x + pixelSize * 0.35}
                y={icicle.y + icicle.length * pixelSize}
                width={pixelSize * 0.3}
                height={pixelSize * 0.3}
                style={
                  {
                    animationDuration: `${icicle.drip.duration}s`,
                    animationDelay: `${icicle.drip.delay}s`,
                    "--drip-fall": `${icicle.drip.fall}px`,
                  } as React.CSSProperties
                }
              />
            )}
          </g>
        ))}
      </g>
      <g aria-hidden="true">
        {sparkles.map((sparkle) => (
          <path
            key={sparkle.key}
            className="pixel-logo-sparkle"
            d={sparklePath(sparkle.size)}
            transform={`translate(${sparkle.cx} ${sparkle.cy})`}
            fill="#ffffff"
            style={{
              animationDuration: `${sparkle.duration}s`,
              animationDelay: `${sparkle.delay}s`,
            }}
          />
        ))}
      </g>
      <g aria-hidden="true" clipPath={`url(#${clipId})`}>
        {snowflakes.map((flake) => (
          <rect
            key={`flake-${flake.key}`}
            className="pixel-logo-flake"
            x={flake.x}
            y={0}
            width={flake.size}
            height={flake.size}
            style={
              {
                animationDuration: `${flake.duration}s`,
                animationDelay: `${flake.delay}s`,
                "--flake-opacity": flake.opacity,
                "--flake-drift": `${flake.drift}px`,
                "--flake-fall": `${heightPx + 8}px`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
};

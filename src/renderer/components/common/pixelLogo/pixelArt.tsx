import type { JSX } from "react";

export type PixelLetter = ReadonlyArray<string>;

export type PixelLogoProps = {
  text?: string;
  pixelSize?: number;
  letterGap?: number;
  lineGap?: number;
  color?: string;
  className?: string;
};

export type PixelArtMap = ReadonlyArray<string>;

export type PixelCell = {
  key: string;
  x: number;
  y: number;
  rowIndex: number;
  jitter: number;
};

export const LETTER_WIDTH = 5;
export const LETTER_HEIGHT = 7;

export const PIXEL_LETTERS: Record<string, PixelLetter> = {
  S: [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

export const getLetter = (char: string): PixelLetter => {
  const upper = char.toUpperCase();
  return PIXEL_LETTERS[upper] ?? PIXEL_LETTERS[" "];
};

export const buildCells = (chars: string[], letterGap: number): PixelCell[] => {
  const cells: PixelCell[] = [];

  chars.forEach((char, charIndex) => {
    const letter = getLetter(char);
    const offsetX = charIndex * (LETTER_WIDTH + letterGap);

    letter.forEach((row, rowIndex) => {
      row.split("").forEach((cell, colIndex) => {
        if (cell === "#") {
          cells.push({
            key: `${charIndex}-${rowIndex}-${colIndex}`,
            x: offsetX + colIndex,
            y: rowIndex,
            rowIndex,
            jitter: (charIndex * 13 + rowIndex * 29 + colIndex * 7) % 90,
          });
        }
      });
    });
  });

  return cells;
};

export const renderPixelArt = (
  map: PixelArtMap,
  palette: Record<string, string>,
  originX: number,
  originY: number,
  cell: number,
  keyPrefix: string,
): JSX.Element[] => {
  const rects: JSX.Element[] = [];

  map.forEach((row, rowIndex) => {
    row.split("").forEach((ch, colIndex) => {
      const fill = palette[ch];
      if (fill) {
        rects.push(
          <rect
            key={`${keyPrefix}-${rowIndex}-${colIndex}`}
            x={originX + colIndex * cell}
            y={originY + rowIndex * cell}
            width={cell}
            height={cell}
            fill={fill}
          />,
        );
      }
    });
  });

  return rects;
};

export const sparklePath = (size: number): string => {
  const inner = size * 0.28;
  return `M 0 ${-size} L ${inner} ${-inner} L ${size} 0 L ${inner} ${inner} L 0 ${size} L ${-inner} ${inner} L ${-size} 0 L ${-inner} ${-inner} Z`;
};

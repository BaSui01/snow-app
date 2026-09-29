import type { JSX } from "react";

import type { PixelLogoProps } from "./pixelLogo/pixelArt";
import { RococoPixelLogo } from "./pixelLogo/RococoPixelLogo";
import { SnowPixelLogo } from "./pixelLogo/SnowPixelLogo";
import { useThemeAppearance } from "../../hooks/useThemeAppearance";

export type { PixelLogoProps };

export const PixelLogo = (props: PixelLogoProps): JSX.Element => {
  const { presetId, isDark } = useThemeAppearance();

  if (presetId === "rococo") {
    return <RococoPixelLogo {...props} isDark={isDark} />;
  }

  return <SnowPixelLogo {...props} />;
};

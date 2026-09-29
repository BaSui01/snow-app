import { useEffect, useState } from "react";

export type ThemeAppearance = {
  presetId: string;
  isDark: boolean;
};

const readAppearance = (): ThemeAppearance => {
  const root = document.documentElement;
  return {
    presetId: root.getAttribute("data-theme-preset") ?? "",
    isDark: root.getAttribute("data-theme") === "dark",
  };
};

export const useThemeAppearance = (): ThemeAppearance => {
  const [appearance, setAppearance] = useState<ThemeAppearance>(readAppearance);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setAppearance(readAppearance()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-preset"],
    });
    return () => observer.disconnect();
  }, []);

  return appearance;
};

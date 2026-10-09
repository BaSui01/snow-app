import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setActiveLocale } from "./activeLocale";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  normalizeLocale,
  type Locale,
} from "./locales";
import { translate, type TranslateOptions } from "./translate";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  supportedLocales: typeof SUPPORTED_LOCALES;
  t: (key: string, options?: TranslateOptions) => string;
};

type I18nProviderProps = {
  children: ReactNode;
};

type LocaleState = {
  locale: Locale;
  hasBrowserCache: boolean;
};

const LANGUAGE_SETTING_NAME = "Language";
const LANGUAGE_SETTING_CODE = "language";

const I18nContext = createContext<I18nContextValue | null>(null);

const cacheLocale = (locale: Locale): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage access errors. Locale still works for current session.
  }
};

const readInitialLocaleState = (): LocaleState => {
  if (typeof window === "undefined") {
    return { locale: DEFAULT_LOCALE, hasBrowserCache: false };
  }

  try {
    const storedLocale = normalizeLocale(
      window.localStorage.getItem(LOCALE_STORAGE_KEY),
    );

    if (storedLocale) {
      return { locale: storedLocale, hasBrowserCache: true };
    }
  } catch {
    // Ignore storage access errors and fall back to browser/default locale.
  }

  return {
    locale: normalizeLocale(window.navigator.language) ?? DEFAULT_LOCALE,
    hasBrowserCache: false,
  };
};

const writeLocaleSetting = (locale: Locale): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.snow
    ?.setSystemSetting(LANGUAGE_SETTING_NAME, LANGUAGE_SETTING_CODE, locale)
    .catch((error) => {
      console.warn("Failed to persist locale system setting:", error);
    });
};

export const I18nProvider = ({
  children,
}: I18nProviderProps): React.JSX.Element => {
  const [localeState, setLocaleState] = useState<LocaleState>(
    readInitialLocaleState,
  );
  const { locale, hasBrowserCache } = localeState;

  // 同步给模块级工具函数（如 formatMessageTime 的 Intl 格式化），
  // 这些函数拿不到 Hook，只能读这份快照。
  useEffect(() => {
    setActiveLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (hasBrowserCache) {
      writeLocaleSetting(locale);
      return;
    }

    let isCancelled = false;

    window.snow
      ?.getSystemSettingValue(LANGUAGE_SETTING_CODE)
      .then((settingValue) => {
        if (isCancelled) {
          return;
        }

        const databaseLocale = normalizeLocale(settingValue);

        if (databaseLocale) {
          cacheLocale(databaseLocale);
          setLocaleState({ locale: databaseLocale, hasBrowserCache: true });
          return;
        }

        cacheLocale(locale);
        setLocaleState({ locale, hasBrowserCache: true });
        writeLocaleSetting(locale);
      })
      .catch((error) => {
        if (isCancelled) {
          return;
        }

        console.warn("Failed to read locale system setting:", error);
        cacheLocale(locale);
        setLocaleState({ locale, hasBrowserCache: true });
      });

    return () => {
      isCancelled = true;
    };
  }, [hasBrowserCache, locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    cacheLocale(nextLocale);
    setLocaleState({ locale: nextLocale, hasBrowserCache: true });
    writeLocaleSetting(nextLocale);
  }, []);

  const t = useCallback(
    (key: string, options?: TranslateOptions) =>
      translate(locale, key, options),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      supportedLocales: SUPPORTED_LOCALES,
      t,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nContextValue => {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider.");
  }

  return context;
};

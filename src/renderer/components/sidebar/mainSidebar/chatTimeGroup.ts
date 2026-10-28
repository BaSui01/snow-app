import type { ChatConversationRecord } from "../../../../preload";

export type TimeGroupKey =
  "pinned" | "running" | "today" | "yesterday" | "last7days" | "earlier";

export type TimeGroup = {
  key: TimeGroupKey;
  conversations: ChatConversationRecord[];
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type TimeTranslate = (
  key: string,
  options?: { defaultValue?: string },
) => string;

const WEEKDAY_KEYS = [
  "sidebar.chatWeekdaySun",
  "sidebar.chatWeekdayMon",
  "sidebar.chatWeekdayTue",
  "sidebar.chatWeekdayWed",
  "sidebar.chatWeekdayThu",
  "sidebar.chatWeekdayFri",
  "sidebar.chatWeekdaySat",
];

const WEEKDAY_FALLBACKS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Parse a SQLite datetime string ("YYYY-MM-DD HH:MM:SS" in local time)
 * into a JavaScript Date object.
 */
export const parseDbTimestamp = (dateStr: string): Date => {
  if (!dateStr) {
    return new Date(0);
  }

  const normalized = dateStr.includes("T")
    ? dateStr
    : dateStr.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);

  return new Date(hasTimezone ? normalized : normalized);
};

/**
 * Determine which time group a date falls into, relative to "now".
 */
export const getTimeGroup = (date: Date, now: Date): TimeGroupKey => {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday.getTime() - ONE_DAY_MS);
  const startOf7Days = new Date(startOfToday.getTime() - 6 * ONE_DAY_MS);

  if (date.getTime() >= startOfToday.getTime()) {
    return "today";
  }

  if (date.getTime() >= startOfYesterday.getTime()) {
    return "yesterday";
  }

  if (date.getTime() >= startOf7Days.getTime()) {
    return "last7days";
  }

  return "earlier";
};

/**
 * Format a short time label for display on a chat item.
 * - Today: "HH:mm"
 * - Yesterday: "yesterday" (caller provides via i18n)
 * - This week: localized weekday name
 * - Earlier: "M/D"
 */
export const formatTimeLabel = (
  date: Date,
  now: Date,
  t?: TimeTranslate,
): string => {
  const group = getTimeGroup(date, now);

  if (group === "today") {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  if (group === "yesterday") {
    return "yesterday";
  }

  if (group === "last7days") {
    const index = date.getDay();
    return t
      ? t(WEEKDAY_KEYS[index], { defaultValue: WEEKDAY_FALLBACKS[index] })
      : WEEKDAY_FALLBACKS[index];
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
};

/** 相对时间单位由粗到细，命中第一个不超过差值的单位。 */
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/** 超过 1 小时不再显示相对时间，改用具体时刻。 */
const ABSOLUTE_TIME_THRESHOLD_SECONDS = 60 * 60;

/** 是否与 now 处于同一个自然日（本地时区）。 */
const isSameLocalDay = (date: Date, now: Date): boolean =>
  date.getFullYear() === now.getFullYear() &&
  date.getMonth() === now.getMonth() &&
  date.getDate() === now.getDate();

/**
 * 悬浮卡片上的会话时间标签，按界面语言本地化：
 * - 1 小时内：相对时间（如「5 分钟前」）；
 * - 1 小时前但仍在当天：「今天 14:30」；
 * - 更早：绝对时间（如「2026年10月28日 14:30」）；
 * - 时间无效返回空串。
 */
export const formatTooltipTimeLabel = (
  date: Date,
  locale: string,
  t: TimeTranslate,
  now: Date = new Date(),
): string => {
  const time = date.getTime();
  if (!Number.isFinite(time) || time <= 0) {
    return "";
  }
  const diffSeconds = Math.round((time - now.getTime()) / 1000);
  if (Math.abs(diffSeconds) >= ABSOLUTE_TIME_THRESHOLD_SECONDS) {
    const clock = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    if (isSameLocalDay(date, now)) {
      return `${t("sidebar.chatTimeToday", { defaultValue: "Today" })} ${clock}`;
    }
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "long",
  });
  for (const [unit, unitSeconds] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= unitSeconds || unit === "second") {
      return formatter.format(Math.round(diffSeconds / unitSeconds), unit);
    }
  }
  return formatter.format(0, "second");
};

/**
 * Group a list of conversations into time-based sections.
 *
 * 运行中的会话（streamingIds）会被独立分组为 "running"，
 * 显示在所有时间分组的顶部。该分组只包含运行中的会话，
 * 其余会话按 today/yesterday/last7days/earlier 分组。
 *
 * 采用「先按 key 聚合成 Map，再按固定顺序输出」的方式，而不是依赖
 * "相邻同组项合并"。侧边栏列表在运行中会话置顶、记录刷新失效时可能
 * 不满足严格的时间倒序，相邻合并会把同一个时间分组切成多个重复的
 * 组头（例如两个"昨天"）；聚合方式保证每个分组只出现一次，
 * 组内再按 updatedAt 倒序输出，渲染顺序不受输入乱序影响。
 */
export const groupConversationsByTime = (
  conversations: ChatConversationRecord[],
  now: Date = new Date(),
  streamingIds?: Set<string>,
): TimeGroup[] => {
  const buckets = new Map<TimeGroupKey, ChatConversationRecord[]>();

  for (const conversation of conversations) {
    const key =
      streamingIds && streamingIds.has(conversation.conversationId)
        ? "running"
        : getTimeGroup(parseDbTimestamp(conversation.updatedAt), now);

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(conversation);
    } else {
      buckets.set(key, [conversation]);
    }
  }

  const orderedKeys: TimeGroupKey[] = [
    "running",
    "today",
    "yesterday",
    "last7days",
    "earlier",
  ];

  const groups: TimeGroup[] = [];
  for (const key of orderedKeys) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    bucket.sort(
      (a, b) =>
        parseDbTimestamp(b.updatedAt).getTime() -
        parseDbTimestamp(a.updatedAt).getTime(),
    );
    groups.push({ key, conversations: bucket });
  }

  return groups;
};

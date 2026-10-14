export const TREND_WINDOW_MS = 60000;
export const TREND_MAX_POINTS = 120;
export const CONTINUOUS_SAMPLE_GAP_MS = 2500;

export type UsageSample = {
  atMs: number;
  cpu: number | null;
  memory: number | null;
  breakBefore: boolean;
};
export type SampleStamp = {
  id: number;
  atMs: number;
  scopeKey: string;
  continuity: number;
};

export const pruneUsageSamples = (
  samples: UsageSample[],
  now: number,
): UsageSample[] =>
  samples
    .filter(
      (sample) =>
        sample.atMs >= now - TREND_WINDOW_MS && sample.atMs <= now + 1000,
    )
    .slice(-TREND_MAX_POINTS);

/** Called once per successful process response, never on clock-only updates. */
export const appendUsageSample = (
  samples: UsageSample[],
  sample: UsageSample,
): UsageSample[] => {
  const retained = pruneUsageSamples(samples, sample.atMs);
  const previous = retained.at(-1);
  if (previous && sample.atMs <= previous.atMs) return retained;
  return [
    ...retained,
    {
      ...sample,
      breakBefore:
        sample.breakBefore ||
        !previous ||
        sample.atMs - previous.atMs > CONTINUOUS_SAMPLE_GAP_MS,
    },
  ].slice(-TREND_MAX_POINTS);
};

/** Null and long intervals split SVG paths; unknown samples are never plotted as zero. */
export const usageSegments = (
  samples: UsageSample[],
  metric: "cpu" | "memory",
): UsageSample[][] => {
  const segments: UsageSample[][] = [];
  let current: UsageSample[] = [];
  let previousAt = 0;
  for (const sample of samples) {
    const value = sample[metric];
    if (
      sample.breakBefore ||
      sample.atMs - previousAt > CONTINUOUS_SAMPLE_GAP_MS ||
      value == null
    ) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (value != null && Number.isFinite(value)) current.push(sample);
    previousAt = sample.atMs;
  }
  if (current.length) segments.push(current);
  return segments;
};

export type AlertOptions = {
  enabled: boolean;
  cpuPercent: number;
  memoryMiB: number;
  durationSecs: number;
  /** Deliver a system notification when a metric alert newly becomes active. */
  systemNotify: boolean;
};
export type MetricAlert = {
  sinceMs: number | null;
  lastAtMs: number | null;
  active: boolean;
  dismissed: boolean;
};
export type UsageAlerts = { cpu: MetricAlert; memory: MetricAlert };
export const emptyMetricAlert = (): MetricAlert => ({
  sinceMs: null,
  lastAtMs: null,
  active: false,
  dismissed: false,
});
export const emptyUsageAlerts = (): UsageAlerts => ({
  cpu: emptyMetricAlert(),
  memory: emptyMetricAlert(),
});
export const alertOptionsValid = (options: AlertOptions): boolean =>
  Number.isFinite(options.cpuPercent) &&
  options.cpuPercent >= 0 &&
  options.cpuPercent <= 100 &&
  Number.isFinite(options.memoryMiB) &&
  options.memoryMiB >= 1 &&
  options.memoryMiB <= 1048576 &&
  Number.isInteger(options.durationSecs) &&
  options.durationSecs >= 3 &&
  options.durationSecs <= 120;

const advanceMetricAlert = (
  previous: MetricAlert,
  sample: UsageSample,
  value: number | null,
  threshold: number,
  durationMs: number,
): MetricAlert => {
  if (value == null || !Number.isFinite(value) || value < threshold)
    return emptyMetricAlert();
  const continuous =
    !sample.breakBefore &&
    previous.lastAtMs != null &&
    sample.atMs > previous.lastAtMs &&
    sample.atMs - previous.lastAtMs <= CONTINUOUS_SAMPLE_GAP_MS;
  const sinceMs =
    continuous && previous.sinceMs != null ? previous.sinceMs : sample.atMs;
  return {
    sinceMs,
    lastAtMs: sample.atMs,
    active: sample.atMs - sinceMs >= durationMs,
    dismissed: continuous ? previous.dismissed : false,
  };
};

/** Independent metric clocks: alternating CPU/memory spikes cannot accumulate duration. */
export const advanceUsageAlerts = (
  previous: UsageAlerts,
  sample: UsageSample,
  options: AlertOptions,
): UsageAlerts => {
  if (!options.enabled || !alertOptionsValid(options))
    return emptyUsageAlerts();
  return {
    cpu: advanceMetricAlert(
      previous.cpu,
      sample,
      sample.cpu,
      options.cpuPercent,
      options.durationSecs * 1000,
    ),
    memory: advanceMetricAlert(
      previous.memory,
      sample,
      sample.memory,
      options.memoryMiB * 1048576,
      options.durationSecs * 1000,
    ),
  };
};

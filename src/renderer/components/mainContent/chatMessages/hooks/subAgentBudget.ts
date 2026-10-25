type SubAgentBudgetLimits = {
  maxModelRequests: number;
  maxActiveDurationMs: number;
};
export const loadSubAgentBudgetLimits =
  async (): Promise<SubAgentBudgetLimits> => {
    const [requests, duration] = await Promise.all([
      window.snow.getSystemSettingValue("sub_agent_max_model_requests"),
      window.snow.getSystemSettingValue("sub_agent_max_active_duration_ms"),
    ]);
    const limit = (
      value: string | null | undefined,
      fallback: number,
    ): number => {
      if (value == null || value === "") return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(
          "CONFIGURATION_ERROR: sub-agent budget must be a positive integer",
        );
      return parsed;
    };
    return {
      maxModelRequests: limit(requests, 128),
      maxActiveDurationMs: limit(duration, 30 * 60 * 1000),
    };
  };

/** One clock per run. Human/capacity waits pause it; tool/network timeout contracts stay independent. */
export const createSubAgentBudget = (
  limits: SubAgentBudgetLimits,
  onExhausted: (error: Error) => void,
) => {
  let requests = 0;
  let remaining = limits.maxActiveDurationMs;
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exhausted: Error | undefined;
  const fail = (code: string): Error => {
    if (!exhausted) {
      exhausted = new Error(`${code}: sub-agent run budget exhausted`);
      onExhausted(exhausted);
    }
    return exhausted;
  };
  const pause = (): void => {
    if (startedAt !== undefined)
      remaining -= Math.max(0, performance.now() - startedAt);
    startedAt = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const resume = (): void => {
    if (exhausted) throw exhausted;
    if (startedAt !== undefined) return;
    if (remaining <= 0) throw fail("ACTIVE_DURATION_BUDGET_EXHAUSTED");
    startedAt = performance.now();
    timer = setTimeout(() => {
      pause();
      fail("ACTIVE_DURATION_BUDGET_EXHAUSTED");
    }, remaining);
  };
  const check = (): void => {
    if (exhausted) throw exhausted;
    if (
      remaining -
        (startedAt === undefined ? 0 : performance.now() - startedAt) <=
      0
    )
      throw fail("ACTIVE_DURATION_BUDGET_EXHAUSTED");
  };
  return {
    pause,
    resume,
    check,
    request(): void {
      check();
      if (requests >= limits.maxModelRequests)
        throw fail("MODEL_REQUEST_BUDGET_EXHAUSTED");
      requests += 1;
    },
    get error(): Error | undefined {
      return exhausted;
    },
  };
};

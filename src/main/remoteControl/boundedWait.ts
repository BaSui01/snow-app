export const waitForCallbackOrTimeout = (
  start: (done: () => void) => void,
  timeoutMs: number,
): Promise<"completed" | "timed_out"> =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: "completed" | "timed_out"): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish("timed_out"), timeoutMs);
    try {
      start(() => finish("completed"));
    } catch {
      finish("completed");
    }
  });

export const withTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

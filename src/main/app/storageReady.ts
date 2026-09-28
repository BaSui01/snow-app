/**
 * Storage readiness gate.
 *
 * The Rust native bridge initialises its SQLite database asynchronously via
 * `initializeAppStorage`. Until that finishes, any IPC handler that calls a
 * native database method would fail. To avoid blocking window creation on
 * storage init, we expose a shared Promise that resolves once the database
 * is ready. The Proxy in `nativeBridge.ts` awaits this Promise before
 * forwarding database-backed calls, so individual IPC handlers stay
 * unchanged. 纯 git / 文件系统 / 进程类方法不依赖数据库，直接执行，
 * 不参与门控（否则启动时会被拖到存储就绪的同一瞬间一起返回）。
 */

let resolveReady: () => void;
let rejectReady: (reason: unknown) => void;
let storageIsReady = false;

/** Resolves when `markStorageReady()` is called; rejects on `markStorageFailed()`. */
export const storageReady: Promise<void> = new Promise<void>(
  (resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  },
);

/** Called by `initializeApplicationServices` on success. */
export const markStorageReady = (): void => {
  storageIsReady = true;
  resolveReady();
};

/**
 * 存储是否已就绪。未就绪时，不依赖数据库的读取可按默认值先行返回，
 * 不必卡在 `storageReady` 上（例如启动期的 git 状态查询）。
 */
export const isStorageReady = (): boolean => storageIsReady;

/** Called by `initializeApplicationServices` on failure. */
export const markStorageFailed = (reason: unknown): void => {
  rejectReady(reason);
};

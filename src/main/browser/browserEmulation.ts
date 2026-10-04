import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
} from "../ipc/handlers/browserNetworkRecorder";

/**
 * 页面仿真（CDP Emulation / Network 域）：配色方案、CPU 节流、地理位置、
 * 额外请求头、网络档位、UA、视口；resize_page 复用视口仿真。
 */

export type EmulateParams = {
  colorScheme?: "dark" | "light" | "auto";
  cpuThrottlingRate?: number;
  extraHttpHeaders?: Record<string, string> | null;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  } | null;
  networkConditions?: string | null;
  userAgent?: string | null;
  viewport?: string | null;
};

export const NETWORK_CONDITIONS: Record<
  string,
  {
    latency: number;
    downloadThroughput: number;
    uploadThroughput: number;
    offline?: boolean;
  }
> = {
  Offline: {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  },
  "Slow 3G": {
    latency: 400,
    downloadThroughput: 51200,
    uploadThroughput: 51200,
  },
  "Fast 3G": {
    latency: 150,
    downloadThroughput: 209715,
    uploadThroughput: 96000,
  },
  "Slow 4G": {
    latency: 150,
    downloadThroughput: 524288,
    uploadThroughput: 393216,
  },
  "Fast 4G": {
    latency: 50,
    downloadThroughput: 1310720,
    uploadThroughput: 655360,
  },
};

const parseViewport = (
  value: string,
): {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  landscape: boolean;
} => {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const dims = (parts.shift() ?? "").toLowerCase().split("x");
  const width = Number.parseInt(dims[0] ?? "", 10);
  const height = Number.parseInt(dims[1] ?? "", 10);
  const rawDpr = dims[2] ? Number.parseFloat(dims[2]) : 1;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      'Invalid viewport; expected "<width>x<height>[x<devicePixelRatio>][,mobile][,touch][,landscape]"',
    );
  }
  const flags = new Set(parts.map((part) => part.toLowerCase()));
  const dpr = Number.isFinite(rawDpr) ? Math.min(Math.max(rawDpr, 0.1), 8) : 1;
  return {
    width: Math.min(Math.max(Math.round(width), 50), 8000),
    height: Math.min(Math.max(Math.round(height), 50), 8000),
    deviceScaleFactor: dpr,
    mobile: flags.has("mobile"),
    touch: flags.has("touch"),
    landscape: flags.has("landscape"),
  };
};

export const applyBrowserEmulation = async (
  webContentsId: number,
  params: EmulateParams,
): Promise<Record<string, unknown>> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const applied: Record<string, unknown> = {};

  if (params.colorScheme !== undefined) {
    const scheme = params.colorScheme;
    await contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features:
        scheme === "auto"
          ? []
          : [{ name: "prefers-color-scheme", value: scheme }],
    });
    applied.colorScheme = scheme;
  }
  if (params.cpuThrottlingRate !== undefined) {
    await contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
      rate: params.cpuThrottlingRate,
    });
    applied.cpuThrottlingRate = params.cpuThrottlingRate;
  }
  if (params.extraHttpHeaders !== undefined) {
    const headers = params.extraHttpHeaders ?? {};
    await contents.debugger.sendCommand("Network.setExtraHTTPHeaders", {
      headers,
    });
    applied.extraHttpHeaders = Object.keys(headers).length;
  }
  if (params.geolocation !== undefined) {
    if (params.geolocation === null) {
      await contents.debugger.sendCommand("Emulation.clearGeolocationOverride");
      applied.geolocation = null;
    } else {
      await contents.debugger.sendCommand("Emulation.setGeolocationOverride", {
        latitude: params.geolocation.latitude,
        longitude: params.geolocation.longitude,
        accuracy: params.geolocation.accuracy ?? 1,
      });
      applied.geolocation = params.geolocation;
    }
  }
  if (params.networkConditions !== undefined) {
    if (params.networkConditions === null || params.networkConditions === "") {
      await contents.debugger.sendCommand("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      applied.networkConditions = "online";
    } else {
      const preset = NETWORK_CONDITIONS[params.networkConditions];
      if (!preset) {
        throw new Error(
          `Unknown network condition preset: ${params.networkConditions}; use one of ${Object.keys(NETWORK_CONDITIONS).join(", ")}`,
        );
      }
      await contents.debugger.sendCommand("Network.emulateNetworkConditions", {
        offline: preset.offline ?? false,
        latency: preset.latency,
        downloadThroughput: preset.downloadThroughput,
        uploadThroughput: preset.uploadThroughput,
      });
      applied.networkConditions = params.networkConditions;
    }
  }
  if (params.userAgent !== undefined) {
    const userAgent = params.userAgent ?? "";
    await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
      userAgent,
    });
    applied.userAgent = userAgent || "(cleared)";
  }
  if (params.viewport !== undefined) {
    if (params.viewport === null || params.viewport === "") {
      await contents.debugger.sendCommand(
        "Emulation.clearDeviceMetricsOverride",
      );
      await contents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: false,
        },
      );
      applied.viewport = null;
    } else {
      const parsed = parseViewport(params.viewport);
      let { width, height } = parsed;
      if (parsed.landscape && width < height) {
        const swap = width;
        width = height;
        height = swap;
      }
      await contents.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        {
          width,
          height,
          deviceScaleFactor: parsed.deviceScaleFactor,
          mobile: parsed.mobile,
        },
      );
      await contents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: parsed.touch,
          ...(parsed.touch ? { configuration: "mobile" } : {}),
        },
      );
      applied.viewport = {
        width,
        height,
        deviceScaleFactor: parsed.deviceScaleFactor,
        mobile: parsed.mobile,
        touch: parsed.touch,
        landscape: parsed.landscape,
      };
    }
  }
  return applied;
};

export const resizeBrowserViewport = async (
  webContentsId: number,
  width: number,
  height: number,
): Promise<{ width: number; height: number }> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { width, height };
};

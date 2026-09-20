import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { build as buildVite, type Plugin } from "vite";

/** 移动端远控页面（src/mobile）源码与产物目录；主进程按产物目录提供静态资源。 */
const MOBILE_PAGE_ROOT = resolve(__dirname, "src/mobile");
const MOBILE_PAGE_OUT_DIR = resolve(__dirname, "out/mobile");

/**
 * 移动端远控页面是独立的 Vite 构建，由本插件挂在 main 构建上：
 * - electron-vite build：构建主进程时一并产出 out/mobile（electron-builder 的
 *   files: out/** 会自动打包进 asar）；
 * - electron-vite dev：对 src/mobile 启动 Vite watch，改动即重建，手机刷新可见。
 * 页面用到的 npm 依赖（如 highlight.js）会随该构建打包进 assets/*，
 * 产物为 index.html + assets/*，由远控服务直接读取。
 */
const createMobilePageBuildConfig = (isWatch: boolean) => ({
  configFile: false as const,
  root: MOBILE_PAGE_ROOT,
  base: "/",
  publicDir: false as const,
  logLevel: "warn" as const,
  // 不要擦除 electron-vite dev 的终端输出。
  clearScreen: false,
  build: {
    outDir: MOBILE_PAGE_OUT_DIR,
    emptyOutDir: true,
    target: "es2020",
    minify: !isWatch,
    sourcemap: isWatch,
    // Vite 默认注入的 modulepreload polyfill 是内联脚本，而远控页 CSP 只允许
    // 'self' 脚本；现代手机浏览器均原生支持 modulepreload。
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 700,
  },
});

const mobilePageAssetsPlugin = (): Plugin => {
  let started = false;
  return {
    name: "snow-mobile-page-assets",
    async buildStart() {
      if (started) return;
      started = true;
      if (!this.meta.watchMode) {
        await buildVite(createMobilePageBuildConfig(false));
        return;
      }
      const config = createMobilePageBuildConfig(true);
      // watch 模式交给 Vite 自行监听 src/mobile：改动即重建，无需在此处理事件。
      await buildVite({
        ...config,
        build: { ...config.build, watch: {} },
      });
    },
  };
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), mobilePageAssetsPlugin()],
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          // 内置浏览器 webview 的密码助手（guest 页面 preload，独立入口
          // 以输出单独的 webview-browser.mjs 供 <webview preload> 引用）。
          "webview-browser": resolve(
            __dirname,
            "src/preload/webviewBrowserPreload.ts",
          ),
          // 桌面宠物窗口的轻量 preload（输出 pet.mjs）。
          pet: resolve(__dirname, "src/preload/petPreload.ts"),
        },
        // Electron 37 的 <webview> preload 静默丢弃 ESM（.mjs），
        // 必须输出 CJS 才能加载。
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          chunkFileNames: "[name]-[hash].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
      },
    },
    plugins: [react()],
    worker: {
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name].js",
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          // 桌面宠物窗口页面（独立入口，输出 pet.html）。
          pet: resolve(__dirname, "src/renderer/pet.html"),
          // 独立浏览器窗口页面（「在新窗口中打开」的浏览器 tab，输出 browserWindow.html）。
          browserWindow: resolve(__dirname, "src/renderer/browserWindow.html"),
        },
        output: {
          chunkFileNames: "assets/[name].js",
          manualChunks: {
            // React 核心 — 首屏必需，独立 chunk 利于缓存
            "vendor-react": ["react", "react-dom"],
            // 图标库 — 体积较大但首屏需要少量图标
            "vendor-lucide": ["lucide-react"],
            // 代码高亮 — 仅 chat 消息渲染时需要
            "vendor-highlightjs": ["highlight.js"],
            // 终端模拟 — 仅打开终端 tab 时需要
            "vendor-xterm": [
              "@xterm/xterm",
              "@xterm/addon-fit",
              "@xterm/addon-webgl",
            ],
          },
        },
      },
    },
  },
});

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { LyricsApp, makeT, resolveUiLang } from "@ai-lyrics/ui";
import type { LyricsProvider } from "@ai-lyrics/lyrics-core";
import { SpicetifyPlayerAdapter } from "./SpicetifyPlayerAdapter.js";
import { makeCosmosFetch } from "./cosmos-fetch.js";
import { Router } from "./router.js";
import { trackMainViewInsets } from "./insets.js";
import { startPrefetch } from "./prefetch.js";

const ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM2.5 3.5v9h11v-9h-11z"/><path d="M3.5 6h6v1.2h-6zM10.5 6h2v1.2h-2zM3.5 9h2v1.2h-2zM6.5 9h6v1.2h-6z"/></svg>`;

async function waitForSpicetify(): Promise<void> {
  // 扩展加载早于 Player/Platform 就绪，轮询等待。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = (window as unknown as { Spicetify?: any }).Spicetify;
    if (s?.Player?.getProgress && s?.Platform?.History) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 等待匹配元素出现（挂播放栏按钮用）。 */
function waitForElement(selector: string, timeoutMs = 60000): Promise<HTMLElement | null> {
  const existing = document.querySelector(selector) as HTMLElement | null;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(document.querySelector(selector) as HTMLElement | null);
    }, timeoutMs);
  });
}

/**
 * 在播放栏加入口按钮；返回设置激活态的函数。
 * 优先用官方 Spicetify.Playbar.Button（由 Spicetify 安全管理插入位置，不打扰
 * extraControls 的 React 渲染——队列/当前播放视图按钮就住在那里，直接往里塞
 * 外来节点可能破坏其 reconciliation 导致它们失效）；不可用时降级为手动 append。
 */
async function createPlayerbarButton(
  onClick: () => void,
  label: string,
): Promise<(active: boolean) => void> {
  const sp = (window as unknown as { Spicetify?: any }).Spicetify;
  try {
    if (sp?.Playbar?.Button) {
      const b = new sp.Playbar.Button(label, ICON, () => onClick(), false, false);
      return (active: boolean) => {
        try {
          b.active = active;
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* 降级到手动方式 */
  }

  const container = await waitForElement(
    ".main-nowPlayingBar-right .main-nowPlayingBar-extraControls",
  );
  const btn = document.createElement("button");
  btn.className = "main-genericButton-button ai-lyrics-pbtn";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = ICON;
  btn.style.cssText =
    "display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:inherit;cursor:pointer;padding:0 8px;";
  btn.addEventListener("click", onClick);
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
  return (active: boolean) => {
    btn.style.color = active ? "#1db954" : "";
  };
}

const STORAGE_KEY = "ai-lyrics:settings:hy18b-v1";

/** Spotify 客户端语言（界面语言设为 auto 时据此决定）。 */
function getHostLocale(): string | undefined {
  try {
    return (window as unknown as { Spicetify?: any }).Spicetify?.Locale?.getLocale?.() || undefined;
  } catch {
    return undefined;
  }
}
/** 读取已保存的界面语言设置（未设置则 auto）。 */
function readUiLangSetting(): string {
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { uiLang?: string }).uiLang || "auto";
  } catch {
    return "auto";
  }
}

async function main(): Promise<void> {
  await waitForSpicetify();

  const hostLocale = getHostLocale();
  const adapter = new SpicetifyPlayerAdapter();
  const extraProviders: LyricsProvider[] = []; // Local setup: LRCLIB only.
  // 直连（默认，隐私安全、内网可达）；经 Spicetify cors-proxy 转发为备用（公网无 CORS）。
  const directFetch: typeof fetch = (...args) => window.fetch(...args);
  const proxyFetch = makeCosmosFetch();

  // 路由式挂载（对齐 lucid-lyrics）：进入 /ai-lyrics 时把页面渲染进主视图。
  const router = new Router("ai-lyrics", {
    hideSiblings: true,
    onMount: (el) => {
      const root = createRoot(el);
      root.render(
        createElement(LyricsApp, {
          player: adapter,
          extraProviders,
          directFetch,
          proxyFetch,
          userAgent: "ai-lyrics (https://github.com/ai-lyrics)",
          onClose: () => router.toggle(),
          hostLocale,
        }),
      );
      const stopInsets = trackMainViewInsets(el);
      return () => {
        stopInsets();
        root.unmount();
      };
    },
  });
  await router.init();

  // 播放栏入口按钮：切换路由，并随路由高亮。按钮文案按界面语言（auto→Spotify locale）本地化。
  const btnLabel = makeT(resolveUiLang(readUiLangSetting(), hostLocale))("app.name");
  createPlayerbarButton(() => router.toggle(), btnLabel)
    .then((setActive) => router.onChange(setActive))
    .catch(() => {
      /* 容器未找到时忽略 */
    });

  // 快捷键 Cmd/Ctrl+Shift+L 切换；Esc 退出。
  try {
    Spicetify.Mousetrap?.bind("mod+shift+l", () => router.toggle());
  } catch {
    /* ignore */
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && router.isActive()) router.toggle();
  });

  // 后台预取（设置开启时生效）：提前解析当前 + 队列后续歌曲，写入共享缓存。
  startPrefetch(adapter, {
    extraProviders,
    userAgent: "ai-lyrics (https://github.com/ai-lyrics)",
    directFetch,
    proxyFetch,
    storageKey: "ai-lyrics:settings:hy18b-v1",
    isPanelActive: () => router.isActive(),
  });

  window.aiLyrics = { show: () => router.toggle(), hide: () => router.toggle(), toggle: () => router.toggle() };
}

// 加载即打印（确认脚本被执行），就绪后再打印一次（确认路由/按钮/预取已挂好）。
console.log("[ai-lyrics] 扩展脚本已加载，等待 Spicetify 就绪…");
main()
  .then(() => console.log("[ai-lyrics] ✓ 初始化完成（路由 /ai-lyrics、播放栏按钮、预取已就绪）"))
  .catch((e) => console.error("[ai-lyrics] 启动失败:", e));

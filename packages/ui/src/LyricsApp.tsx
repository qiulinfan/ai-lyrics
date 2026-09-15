import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PlayerAdapter } from "@ai-lyrics/player-core";
import {
  LrclibProvider,
  LyricsService,
  createLocalStorageCache,
  getActiveLineIndex,
  lyricsMatchTarget,
  type LyricsProvider,
} from "@ai-lyrics/lyrics-core";

const NO_LINES: string[] = [];
import {
  AiService,
  MAX_RECENT_MODELS,
  createAiProvider,
  createLocalStorageAnalysisCache,
  defaultAiSettings,
  type AiSettings,
} from "@ai-lyrics/ai-core";
import { injectStyles } from "./styles.js";
import { useAllAnalyses, useLyrics, usePlayerState } from "./hooks.js";
import { LyricsView } from "./LyricsView.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { KawarpBackground } from "./KawarpBackground.js";
import { I18nProvider, makeT, resolveUiLang } from "./i18n.js";

export interface LyricsAppProps {
  player: PlayerAdapter;
  /** 关闭（宿主侧通常是路由返回）。 */
  onClose?: () => void;
  /** 宿主特定的额外歌词源（如 Spicetify 的 Spotify color-lyrics），置于 LRCLIB 之前。 */
  extraProviders?: LyricsProvider[];
  /** LRCLIB 请求标识。 */
  userAgent?: string;
  /** 直连端点的 fetch（默认）。 */
  directFetch?: typeof fetch;
  /** 经代理转发的 fetch（设置开启时用，如 Spicetify CosmosAsync→cors-proxy）。 */
  proxyFetch?: typeof fetch;
  /** 设置持久化 key。 */
  storageKey?: string;
  /** 宿主语言（如 Spicetify.Locale.getLocale()）；界面语言设为 auto 时据此决定，取不到回退英文。 */
  hostLocale?: string;
}

/** 把旧版单 model 字段迁移成 models[]，并保证 models 至少一个。 */
function normModels(
  src: { models?: unknown; model?: unknown } | undefined,
  fallback: string[],
): string[] {
  const arr = Array.isArray(src?.models)
    ? (src!.models as unknown[]).filter((m): m is string => typeof m === "string" && m.trim() !== "")
    : typeof src?.model === "string" && src.model.trim()
      ? [src.model]
      : [];
  return arr.length ? arr.slice(0, 3) : fallback;
}

function loadSettings(key: string): AiSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    if (!raw) return defaultAiSettings;
    const p = JSON.parse(raw) as Partial<AiSettings> & {
      ollama?: { baseUrl?: string; model?: string; models?: string[] };
      openai?: { baseUrl?: string; apiKey?: string; model?: string; models?: string[] };
    };
    return {
      ...defaultAiSettings,
      ...p,
      ollama: {
        baseUrl: p.ollama?.baseUrl ?? defaultAiSettings.ollama.baseUrl,
        models: normModels(p.ollama, defaultAiSettings.ollama.models),
      },
      openai: {
        baseUrl: p.openai?.baseUrl ?? defaultAiSettings.openai.baseUrl,
        apiKey: p.openai?.apiKey ?? defaultAiSettings.openai.apiKey,
        models: normModels(p.openai, defaultAiSettings.openai.models),
      },
      prefetchCount: Math.min(3, Math.max(1, p.prefetchCount ?? 1)),
      recentModels: Array.isArray(p.recentModels) ? p.recentModels.slice(0, MAX_RECENT_MODELS) : [],
      fontSizes: { ...defaultAiSettings.fontSizes, ...(p.fontSizes ?? {}) },
      background: { ...defaultAiSettings.background, ...(p.background ?? {}) },
    };
  } catch {
    return defaultAiSettings;
  }
}

function saveSettings(key: string, s: AiSettings) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function LyricsApp({
  player,
  extraProviders,
  userAgent,
  directFetch,
  proxyFetch,
  storageKey = "ai-lyrics:settings:hy18b-v1",
  hostLocale,
}: LyricsAppProps) {
  useEffect(() => injectStyles(), []);

  const [settings, setSettings] = useState<AiSettings>(() => loadSettings(storageKey));
  const [showSettings, setShowSettings] = useState(false);

  // 界面语言：设置为 auto 时跟随宿主 locale（取不到回退英文）。t 直接用解析后的语言，
  // 同时通过 I18nProvider 把同一函数下发给子组件（LyricsView / SettingsPanel）。
  const uiLang = resolveUiLang(settings.uiLang, hostLocale);
  const t = useMemo(() => makeT(uiLang), [uiLang]);

  const lyricsService = useMemo(
    () =>
      new LyricsService({
        providers: [...(extraProviders ?? []), new LrclibProvider({ userAgent })],
        cache: createLocalStorageCache(),
      }),
    [extraProviders, userAgent],
  );

  const analysisCache = useMemo(() => createLocalStorageAnalysisCache(), []);
  const aiService = useMemo(() => {
    const chosenFetch = settings.useCorsProxy ? proxyFetch : directFetch;
    const provider = createAiProvider(settings, { fetchImpl: chosenFetch });
    return new AiService(provider, settings.targetLang, analysisCache);
  }, [settings, directFetch, proxyFetch, analysisCache]);

  const { track, progressMs, playing } = usePlayerState(player);
  const [refreshKey, setRefreshKey] = useState(0);
  const lyricsState = useLyrics(lyricsService, track, refreshKey);

  const lyrics = lyricsState.status === "found" ? lyricsState.lyrics : null;
  // 歌词文本（带时间轴 / 纯文本都取出来解析）：synced 用 LyricLine.text，纯文本本就是字符串数组。
  const linesText = useMemo(
    () => (lyrics ? (lyrics.synced ? lyrics.lines.map((l) => l.text) : lyrics.lines) : []),
    [lyrics],
  );
  // 跳过条件：歌词语言与「翻译目标语言」一致（无需翻译）。例如目标=English 则跳过英文歌。
  const skipAnalysis = useMemo(
    () => lyricsMatchTarget(linesText, settings.targetLang),
    [linesText, settings.targetLang],
  );
  const showAll = settings.showAllAnalyses;
  const aiReady = aiService.isReady();

  // 当前高亮行仅对「带时间轴」歌词有意义；纯文本无进度对应 → activeIndex=-1（不追随、不滚动，但照常解析）。
  const activeIndex = lyrics?.synced ? getActiveLineIndex(lyrics.lines, progressMs) : -1;
  const ctx = { trackTitle: track?.title, artist: track?.artists[0], songId: track?.id };

  // 多批次全量解析（翻译+语法+关键词一起到）：块大小由用户设置（默认 22），按当前行就近排块。
  // 本地单模型端点 → 串行派发（serial），当前行附近一块接一块最先出、不互抢算力；远端并发提吞吐。
  const aiBaseUrl = settings.provider === "ollama" ? settings.ollama.baseUrl : settings.openai.baseUrl;
  const isLocalAi = /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/i.test(aiBaseUrl);
  const all = useAllAnalyses(
    aiService,
    skipAnalysis ? NO_LINES : linesText,
    ctx,
    refreshKey,
    activeIndex,
    settings.chunkSize,
    isLocalAi,
  );
  const byIndex = all.byIndex;
  const aiError = all.error;

  // 解析进度：左上角统一显示，不再每行"解析中"。
  const analyzable = useMemo(() => linesText.filter((t) => t.trim() !== "").length, [linesText]);
  const doneCount = useMemo(
    () => linesText.reduce((n, t, i) => n + (t.trim() !== "" && byIndex[i] ? 1 : 0), 0),
    [linesText, byIndex],
  );
  // 一轮解析刚结束的瞬时提示：有结果才算"完成"，0 结果说明整轮失败 → 提示"失败"（不再误报完成）。
  const [endState, setEndState] = useState<null | "done" | "fail">(null);
  const prevLoadingRef = useRef(false);
  const doneRef = useRef(0);
  doneRef.current = doneCount;
  useEffect(() => {
    if (prevLoadingRef.current && !all.loading && analyzable > 0) {
      setEndState(doneRef.current > 0 ? "done" : "fail");
      const t = window.setTimeout(() => setEndState(null), 2200);
      prevLoadingRef.current = all.loading;
      return () => clearTimeout(t);
    }
    prevLoadingRef.current = all.loading;
    return undefined;
  }, [all.loading, analyzable]);
  const progressText = !aiReady
    ? null
    : all.loading && analyzable > 0
      ? t("progress.analyzing", { done: doneCount, total: analyzable })
      : endState === "done"
        ? doneCount >= analyzable
          ? t("progress.done")
          : t("progress.donePartial", { done: doneCount, total: analyzable })
        : endState === "fail"
          ? t("progress.failed")
          : null;

  // 单词点查：未命中行内关键词时，对该词单独查一次（复用 analyze，按词全局缓存）。
  const lookupWord = useCallback(
    async (word: string): Promise<{ reading?: string; pos?: string; meaning: string } | null> => {
      if (!aiService.isReady()) return null;
      try {
        const a = await aiService.analyze({ line: word });
        const kw = a.keywords.find((k) => k.word.toLowerCase() === word.toLowerCase()) ?? a.keywords[0];
        const meaning = kw?.meaning || a.translation || "";
        return meaning ? { reading: kw?.reading, pos: kw?.pos, meaning } : null;
      } catch {
        return null;
      }
    },
    [aiService],
  );

  const onSettingsSave = (s: AiSettings) => {
    setSettings(s);
    saveSettings(storageKey, s);
  };

  // 长按设置按钮：强制重新解析当前歌词（清缓存 + 重取）。
  const [toast, setToast] = useState<string | null>(null);
  const longPressFired = useRef(false);
  const pressTimer = useRef<number | undefined>(undefined);

  const forceRefresh = useCallback(() => {
    if (!track) {
      setToast(t("toast.noTrack"));
      window.setTimeout(() => setToast(null), 1600);
      return;
    }
    // 清歌词缓存（仅 found 会被缓存）+ 清当前行解析 → bump refreshKey 强制重取歌词并重解析。
    // 当前无歌词（not-found/error）时不缓存，bump 后会重新打网络重试。
    void lyricsService.evict({
      title: track.title,
      artist: track.artists[0] ?? "",
      album: track.album,
      durationMs: track.durationMs,
      id: track.id,
    });
    void aiService.clearLines(track.id, linesText);
    setRefreshKey((k) => k + 1);
    setToast(lyricsState.status === "found" ? t("toast.refetchAnalyze") : t("toast.refetch"));
    window.setTimeout(() => setToast(null), 1600);
  }, [track, lyricsService, aiService, linesText, lyricsState.status, t]);

  const startPress = () => {
    longPressFired.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      forceRefresh();
    }, 550);
  };
  const endPress = () => {
    if (pressTimer.current !== undefined) {
      clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
  };
  const onFabClick = () => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return; // 长按已触发，吞掉这次 click
    }
    setShowSettings(true);
  };

  const rootStyle = {
    "--ail-fs-lyric": `${settings.fontSizes.lyric}px`,
    "--ail-fs-active": `${settings.fontSizes.active}px`,
    "--ail-fs-grammar": `${settings.fontSizes.grammar}px`,
    "--ail-fs-translation": `${settings.fontSizes.translation}px`,
    "--ail-fs-analysis": `${settings.fontSizes.analysis}px`,
  } as CSSProperties;

  return (
    <I18nProvider lang={uiLang}>
    <div className="ail-root" style={rootStyle}>
      {settings.background.mode === "color" ? (
        <div className="ail-bg" style={{ background: settings.background.color }} />
      ) : (
        <KawarpBackground imageSrc={track?.coverUrl} />
      )}
      <div className="ail-window">
        {progressText && (
          <div className={`ail-progress${endState === "fail" ? " fail" : ""}`}>
            {all.loading && <span className="ail-dot" />}
            {progressText}
          </div>
        )}
        <LyricsView
          lyricsState={lyricsState}
          analyses={byIndex}
          activeIndex={activeIndex}
          progressMs={progressMs}
          aiReady={aiReady}
          aiError={aiError}
          showAll={showAll}
          blurMax={settings.blurMax}
          activeHighlightBox={settings.activeHighlightBox}
          wordLookup={false}
          lookupWord={lookupWord}
          onClickLine={(line) => {
            player.seek(line.timeMs);
            if (!playing) player.togglePlay?.();
          }}
          onOpenSettings={() => setShowSettings(true)}
        />

        <button
          className="ail-fab"
          title={t("fab.title")}
          aria-label={t("settings.aria")}
          onPointerDown={startPress}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onClick={onFabClick}
        >
          ⚙
        </button>
        {toast && <div className="ail-toast">{toast}</div>}
      </div>

      {showSettings && (
        <SettingsPanel settings={settings} onSave={onSettingsSave} onClose={() => setShowSettings(false)} />
      )}
    </div>
    </I18nProvider>
  );
}

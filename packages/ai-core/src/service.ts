import { OllamaProvider } from "./providers/ollama.js";
import { OpenAiCompatProvider } from "./providers/openai-compat.js";
import type { AiProvider, AnalyzeInput, LineAnalysis } from "./types.js";

export type AiProviderKind = "ollama" | "openai";

/** 用户可配置的 AI 设置（持久化于 UI 层）。 */
export interface AiSettings {
  provider: AiProviderKind;
  ollama: { baseUrl: string; models: string[] };
  openai: { baseUrl: string; apiKey: string; models: string[] };
  /** 翻译目标语言，默认中文。 */
  targetLang: string;
  /** 界面语言（UI 文案）："auto"=跟随宿主/Spotify，或具体语言码（en/zh-CN/ja/ko…）。默认 auto。 */
  uiLang: string;
  /** 是否对全部歌词行展示解析；默认仅展示当前高亮行。 */
  showAllAnalyses: boolean;
  /** 是否经 Spicetify 公共代理转发 AI 请求（公网无 CORS 端点用；内网勿开）。 */
  useCorsProxy: boolean;
  /** 免预检（简化）请求：不发 Authorization/JSON 头以跳过 CORS 预检。 */
  simpleRequest: boolean;
  /** 是否流式输出（边生成边显示，感知更快）。 */
  streaming: boolean;
  /** 关闭模型「深度思考/推理」（更快，可能略降准确度）；请求会带上多种主流关闭字段。 */
  disableThinking: boolean;
  /**
   * 每次请求的歌词行数（分块大小，建议 8-44，默认 22）。
   * 偏小：每块更快返回、当前行附近更早出，但请求次数多、整曲语境被反复重发、总耗时偏长；
   * 偏大：单块产出慢、首屏等待久，过大还可能超出输出上限被截断而漏行。本地小模型推荐 ~22。
   */
  chunkSize: number;
  /** 是否后台预取（当前 + 队列后续若干首提前解析缓存）。 */
  prefetch: boolean;
  /** 预取数量（含当前歌曲），1-3。 */
  prefetchCount: number;
  /** 最近输入过的模型名（去重，最新在前）。 */
  recentModels: string[];
  /** 单词点查：悬浮单词显示释义（当前仅英文）。 */
  wordLookup: boolean;
  /** 文本大小（px）：默认歌词 / 高亮歌词 / 语法 / 翻译 / 其他解析文本。 */
  fontSizes: { lyric: number; active: number; grammar: number; translation: number; analysis: number };
  /** 非高亮行模糊上限（px）。 */
  blurMax: number;
  /** 当前高亮行是否持续显示「悬浮高亮」（把 :hover 的轻微提亮常驻到当前行）。 */
  activeHighlightBox: boolean;
  /** 背景：动态封面(kawarp) 或 固定纯色(color)。 */
  background: { mode: "kawarp" | "color"; color: string };
}

export const MAX_MODELS = 3;
/** 「最近模型」记录最多保存的条数。 */
export const MAX_RECENT_MODELS = 5;

export const defaultAiSettings: AiSettings = {
  provider: "openai",
  ollama: { baseUrl: "http://localhost:11434", models: ["qwen2.5"] },
  openai: { baseUrl: "http://127.0.0.1:11435/v1", apiKey: "", models: ["lyrics-hy18b"] },
  targetLang: "中文",
  uiLang: "zh-CN",
  showAllAnalyses: true,
  useCorsProxy: false,
  simpleRequest: false,
  streaming: true,
  disableThinking: true,
  chunkSize: 8,
  prefetch: false,
  prefetchCount: 1,
  recentModels: [],
  wordLookup: false,
  fontSizes: { lyric: 28, active: 36, grammar: 16, translation: 18, analysis: 16 },
  blurMax: 1,
  activeHighlightBox: false,
  background: { mode: "kawarp", color: "#0b0b0f" },
};

/** 依据设置构造提供方；未正确配置（如选 openai 但缺 key/模型）时返回 null。 */
export function createAiProvider(
  s: AiSettings,
  opts?: { fetchImpl?: typeof fetch },
): AiProvider | null {
  const fetchImpl = opts?.fetchImpl;
  if (s.provider === "ollama") {
    const models = s.ollama.models.filter(Boolean);
    if (!s.ollama.baseUrl || models.length === 0) return null;
    return new OllamaProvider({
      baseUrl: s.ollama.baseUrl,
      models,
      fetchImpl,
      streaming: s.streaming,
      disableThinking: s.disableThinking,
    });
  }
  const models = s.openai.models.filter(Boolean);
  if (!s.openai.baseUrl || models.length === 0) return null;
  // 本地端点（LM Studio / vLLM / llama.cpp server 等）通常无需 API Key，免 Key 放行；
  // 非本地端点仍要求 Key（防误配）。免预检模式本就不发鉴权头，同样放行。
  const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(s.openai.baseUrl.trim());
  if (!s.openai.apiKey && !s.simpleRequest && !isLocalEndpoint) return null;
  return new OpenAiCompatProvider({
    baseUrl: s.openai.baseUrl,
    apiKey: s.openai.apiKey,
    models,
    fetchImpl,
    simpleRequest: s.simpleRequest,
    streaming: s.streaming,
    disableThinking: s.disableThinking,
  });
}

/* ------------------------------ 缓存 ------------------------------ */

/** AI 解析结果的持久化缓存。 */
export interface AnalysisCache {
  get(key: string): Promise<LineAnalysis | null>;
  set(key: string, value: LineAnalysis): Promise<void>;
  delete(key: string): Promise<void>;
}

interface StoredAnalysis {
  v: 1;
  at: number;
  a: LineAnalysis;
}

/** localStorage 实现（Spicetify / Tauri webview 通用）；无 localStorage 时降级空操作。 */
export function createLocalStorageAnalysisCache(opts?: {
  prefix?: string;
  ttlMs?: number;
}): AnalysisCache {
  const prefix = opts?.prefix ?? "ai-lyrics:ai:";
  const ttlMs = opts?.ttlMs ?? 365 * 24 * 60 * 60 * 1000; // 1 年（翻译相对稳定）
  const ls: Storage | null = typeof localStorage !== "undefined" ? localStorage : null;
  return {
    async get(key) {
      if (!ls) return null;
      const raw = ls.getItem(prefix + key);
      if (!raw) return null;
      try {
        const p = JSON.parse(raw) as StoredAnalysis;
        if (Date.now() - p.at > ttlMs) {
          ls.removeItem(prefix + key);
          return null;
        }
        return p.a;
      } catch {
        ls.removeItem(prefix + key);
        return null;
      }
    },
    async set(key, value) {
      if (!ls) return;
      try {
        ls.setItem(prefix + key, JSON.stringify({ v: 1, at: Date.now(), a: value } as StoredAnalysis));
      } catch {
        /* 配额满：忽略 */
      }
    },
    async delete(key) {
      ls?.removeItem(prefix + key);
    },
  };
}

/* --------------------------- 分块与并发 --------------------------- */

/** 按字符预算把连续歌词切成 [start,end) 区间（end 不含），动态评估每次请求行数。 */
export function planChunks(lines: string[], targetChars = 400): Array<[number, number]> {
  const n = lines.length;
  if (n === 0) return [];
  const total = lines.reduce((s, l) => s + Math.max(l.length, 1), 0);
  const avg = total / n;
  let size = Math.round(targetChars / Math.max(avg, 1));
  // 上限 6 行/块：推理模型批量偶尔漏行，块小更可靠、也更不易截断。
  size = Math.max(3, Math.min(6, size));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < n; i += size) ranges.push([i, Math.min(n, i + size)]);
  return ranges;
}

/** 把按序的若干行按字符预算 + 行数上限分组（用于去重后的唯一行分块）。 */
export function groupByBudget<T extends { text: string }>(
  items: T[],
  targetChars = 400,
  maxItems = 6,
): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    const len = Math.max(it.text.length, 1);
    if (cur.length >= maxItems || (cur.length > 0 && chars + len > targetChars)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if ((e as Error)?.name === "AbortError") throw e;
    }
  }
  throw lastErr;
}

/** 解析是否「空」（无翻译/语法/关键词）——用于「不让空值覆盖已填好的行」。 */
function isEmptyAnalysis(a: LineAnalysis | null | undefined): boolean {
  return (
    !a ||
    (!a.translation?.trim() && (a.keywords?.length ?? 0) === 0 && !a.grammar?.trim())
  );
}

/* ------------------------------ 服务 ------------------------------ */

export interface AnalyzeAllContext {
  trackTitle?: string;
  artist?: string;
  /** 歌曲标识：缓存按歌曲隔离（同句在不同歌可能译法不同）。 */
  songId?: string;
}

export interface AnalyzeAllOptions {
  onUpdate: (index: number, analysis: LineAnalysis) => void;
  onError?: (err: Error, range: [number, number]) => void;
  signal?: AbortSignal;
  concurrency?: number;
  /** 优先解析的行（当前高亮行）：其所在分组最先请求，其余由近及远。 */
  priorityIndex?: number;
  /**
   * 分块大小（4-44，默认 22）。本地顺序执行的端点建议中小块：
   * 配合流式逐行吐出 + 按优先行排块，当前行附近最先就位。
   */
  chunkSize?: number;
  /**
   * 串行派发分块（本地单模型端点用）：按优先顺序一块接一块请求，避免多块并发
   * 互抢算力导致每块都变慢、当前行附近迟迟不出。远端可并发（false）以提高吞吐。
   */
  serial?: boolean;
}

/**
 * AI 解析服务：内存 + 持久化缓存、在途去重、批量分块进度式解析。
 * provider 可热替换（用户改设置后重建）。
 */
export class AiService {
  private provider: AiProvider | null;
  private targetLang: string;
  private readonly persist?: AnalysisCache;
  private readonly mem = new Map<string, LineAnalysis>();
  private readonly inflight = new Map<string, Promise<LineAnalysis>>();
  private remember(key: string, value: LineAnalysis): void {
    this.mem.delete(key);
    this.mem.set(key, value);
    while (this.mem.size > 1024) this.mem.delete(this.mem.keys().next().value!);
  }

  constructor(provider: AiProvider | null, targetLang = "中文", cache?: AnalysisCache) {
    this.provider = provider;
    this.targetLang = targetLang;
    this.persist = cache;
  }

  setProvider(provider: AiProvider | null) {
    this.provider = provider;
  }

  setTargetLang(lang: string) {
    if (lang !== this.targetLang) {
      this.targetLang = lang;
      this.mem.clear();
      this.inflight.clear();
    }
  }

  isReady(): boolean {
    return this.provider !== null;
  }

  /** 清除某歌曲指定行的解析缓存（内存+持久化），用于强制重新解析。 */
  async clearLines(songId: string, lines: string[]): Promise<void> {
    for (const line of lines) {
      const key = this.keyOf(songId, line);
      this.mem.delete(key);
      this.inflight.delete(key);
      if (this.persist) await this.persist.delete(key);
    }
  }

  /** 缓存 key：歌曲 + 目标语言 + 行文本（按歌曲隔离；同一首歌内相同行仍复用）。 */
  private keyOf(songId: string, line: string): string {
    return `local-hy18b-v3:${songId}${this.targetLang}${line}`;
  }

  /** 解析单行：内存 → 持久化 → 请求；相同行并发合并。用于单词点查等按需场景。 */
  async analyze(input: AnalyzeInput, signal?: AbortSignal): Promise<LineAnalysis> {
    if (!this.provider) throw new Error("AI 未配置");
    const key = this.keyOf(input.songId ?? "", input.line);

    const cached = this.mem.get(key) ?? (this.persist ? await this.persist.get(key) : null);
    if (cached) {
      this.remember(key, cached);
      return cached;
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const provider = this.provider;
    const p = provider
      .analyzeLine({ ...input, targetLang: this.targetLang }, signal)
      .then(async (res) => {
        this.remember(key, res);
        if (this.persist) await this.persist.set(key, res);
        this.inflight.delete(key);
        return res;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, p);
    return p;
  }

  /**
   * 解析整首歌：去重（相同歌词只解析一次，结果分发到所有出现处）→ 缓存填充 →
   * 把未命中的唯一行按字符预算分块、限并发请求，进度式回调。
   * 全部命中缓存时不发任何请求；重复行（如副歌）不会重复请求。
   */
  async analyzeAll(
    lines: string[],
    ctx: AnalyzeAllContext,
    opts: AnalyzeAllOptions,
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) throw new Error("AI 未配置");
    const songId = ctx.songId ?? "";

    // 1) 去重：文本 → 首个下标；并记录每个首个下标对应的所有重复下标。
    const firstIndexOf = new Map<string, number>();
    const dupsOf = new Map<number, number[]>();
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const first = firstIndexOf.get(text);
      if (first === undefined) firstIndexOf.set(text, i);
      else {
        const list = dupsOf.get(first);
        if (list) list.push(i);
        else dupsOf.set(first, [i]);
      }
    }
    // 把一个结果分发到首个下标及其所有重复下标。
    const propagate = (canon: number, a: LineAnalysis) => {
      opts.onUpdate(canon, a);
      const dups = dupsOf.get(canon);
      if (dups) for (const d of dups) opts.onUpdate(d, a);
    };

    const canonical = Array.from(firstIndexOf.values()).sort((a, b) => a - b);
    // 去重后的全曲（每个唯一行按歌序一次）作为语境：保留全曲语义、折叠重复副歌与多余间奏，
    // 显著缩小每次请求的 payload（与慢端点耗时正相关），且不影响指定行的按 i 对齐。
    const dedupContext = canonical.map((i) => lines[i]);

    // 2) 缓存填充（仅唯一行）；跳过空行/间奏。
    const needed: number[] = [];
    await Promise.all(
      canonical.map(async (i) => {
        const text = lines[i];
        if (!text.trim()) return; // 间奏：UI 不展示解析
        const key = this.keyOf(songId, text);
        let hit = this.mem.get(key) ?? null;
        if (!hit && this.persist) hit = await this.persist.get(key);
        if (hit) {
          this.remember(key, hit);
          propagate(i, hit);
        } else {
          needed.push(i);
        }
      }),
    );
    if (opts.signal?.aborted) return;

    if (needed.length === 0) return;

    // 3) ≤块大小则整首一次请求（全曲上下文，最准、请求最少）；更长的歌按块拆分
    //    （每块仍带全曲语境，不损准确度）。块大小可调：远端大块省请求数，本地小块更快首批。
    const CHUNK = Math.max(4, Math.min(44, opts.chunkSize ?? 22));
    const chunks: number[][] = [];
    if (needed.length <= CHUNK) {
      chunks.push(needed);
    } else {
      for (let i = 0; i < needed.length; i += CHUNK) chunks.push(needed.slice(i, i + CHUNK));
    }
    // 按「离优先行（当前高亮行）最近」排块：本地端点顺序执行（FIFO），当前行附近最先就位。
    const prio = opts.priorityIndex ?? -1;
    if (prio >= 0 && chunks.length > 1) {
      const dist = (c: number[]) => Math.min(...c.map((i) => Math.abs(i - prio)));
      chunks.sort((a, b) => dist(a) - dist(b));
    }

    const writeAndPropagate = async (globalIdx: number, a: LineAnalysis) => {
      const key = this.keyOf(songId, lines[globalIdx]);
      // 不让空结果（模型漏行 / 末尾整段重解析丢行）覆盖已经填好的行——否则会出现
      // 「已解析的行突然回到空」的闪烁。已有好值时直接跳过这次空写入。
      if (isEmptyAnalysis(a) && !isEmptyAnalysis(this.mem.get(key))) return;
      this.remember(key, a);
      if (this.persist) await this.persist.set(key, a);
      propagate(globalIdx, a);
    };

    const runChunk = async (chunk: number[]) => {
        if (opts.signal?.aborted) return;
        const targetLines = chunk.map((i) => lines[i]);
        // 流式增量：每完成一行立即显示（onLine 的 sliceIndex 是该块内下标）。
        const onLine = (sliceIndex: number, a: LineAnalysis) => {
          const gi = chunk[sliceIndex];
          if (gi === undefined) return;
          const key = this.keyOf(songId, lines[gi]);
          if (isEmptyAnalysis(a) && !isEmptyAnalysis(this.mem.get(key))) return;
          this.remember(key, a);
          if (this.persist) void this.persist.set(key, a);
          propagate(gi, a);
        };
        try {
          const res = await withRetry(() =>
            provider.analyzeLines(
              targetLines,
              {
                targetLang: this.targetLang,
                trackTitle: ctx.trackTitle,
                artist: ctx.artist,
                contextLines: dedupContext, // 去重后的全曲作为语境
              },
              opts.signal,
              onLine,
            ),
          );
          // 末尾用完整结果补全（流式可能漏发某行 / 非流式只有这里）。
          for (let j = 0; j < chunk.length; j++) await writeAndPropagate(chunk[j], res[j]);
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          try {
            console.error("[ai-lyrics] 解析失败:", (err as Error)?.message ?? err);
          } catch {
            /* ignore */
          }
          opts.onError?.(err as Error, [chunk[0] ?? 0, chunk[chunk.length - 1] ?? 0]);
        }
    };

    if (opts.serial) {
      // 本地单模型：按优先顺序一块接一块，当前行附近最先完成、不互抢算力。
      for (const chunk of chunks) {
        if (opts.signal?.aborted) return;
        await runChunk(chunk);
      }
    } else {
      await Promise.all(chunks.map(runChunk));
    }

    // 补漏：模型有时会在一个大块里漏掉若干行。对仍为空的唯一行用更小的块再请求一次
    // （只跑一轮，不递归）；隔离成小块能显著提高这些行的命中率。
    if (opts.signal?.aborted) return;
    const stillEmpty = needed.filter((i) => isEmptyAnalysis(this.mem.get(this.keyOf(songId, lines[i]))));
    if (stillEmpty.length > 0) {
      const RC = Math.min(CHUNK, 8);
      const repairChunks: number[][] = [];
      for (let i = 0; i < stillEmpty.length; i += RC) repairChunks.push(stillEmpty.slice(i, i + RC));
      for (const chunk of repairChunks) {
        if (opts.signal?.aborted) return;
        await runChunk(chunk);
      }
    }
  }
}

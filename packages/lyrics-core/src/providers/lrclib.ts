import { parseLrc } from "../lrc.js";
import type { Lyrics, LyricsProvider, LyricsQuery, LyricsResult } from "../types.js";

/** LRCLIB /api/get 与 /api/search 返回的记录结构（取用到的字段）。 */
interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface LrclibOptions {
  /**
   * 标识请求来源。浏览器禁止用 fetch 设置 `User-Agent`，故走 `x-user-agent`
   * （LRCLIB 接受），与参考实现 lucid-lyrics 一致；Tauri 端可传 fetchImpl 设置真 UA。
   */
  userAgent?: string;
  /** 注入自定义 fetch（Tauri/Node 测试用）。默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://lrclib.net";

/**
 * LRCLIB 歌词源：免费、无需鉴权、返回标准 LRC。
 * 主路 /api/get 精确匹配（带 duration）；未命中回退 /api/search 取时长最接近者。
 */
export class LrclibProvider implements LyricsProvider {
  readonly id = "lrclib";
  private readonly ua: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(opts: LrclibOptions = {}) {
    this.ua = opts.userAgent ?? "ai-lyrics (https://github.com/ai-lyrics)";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.base = opts.baseUrl ?? DEFAULT_BASE;
  }

  async fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult> {
    try {
      const exact = await this.getExact(query, signal);
      if (exact) return this.toResult(exact);

      const best = await this.searchBest(query, signal);
      if (best) return this.toResult(best);

      return { status: "not-found" };
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return { status: "error", message: "aborted" };
      return { status: "error", message: String((err as Error)?.message ?? err) };
    }
  }

  private headers(): HeadersInit {
    return { "x-user-agent": this.ua };
  }

  private async getExact(q: LyricsQuery, signal?: AbortSignal): Promise<LrclibRecord | null> {
    const params = new URLSearchParams({
      track_name: q.title,
      artist_name: q.artist,
      duration: String(Math.round(q.durationMs / 1000)),
    });
    if (q.album) params.set("album_name", q.album);

    const res = await this.fetchImpl(`${this.base}/api/get?${params}`, {
      headers: this.headers(),
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lrclib get ${res.status}`);
    return (await res.json()) as LrclibRecord;
  }

  private async searchBest(q: LyricsQuery, signal?: AbortSignal): Promise<LrclibRecord | null> {
    const targetSec = q.durationMs / 1000;
    const search = async (includeArtist: boolean): Promise<LrclibRecord[]> => {
      const params = new URLSearchParams({ track_name: q.title });
      if (includeArtist) params.set("artist_name", q.artist);
      const res = await this.fetchImpl(`${this.base}/api/search?${params}`, {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) return [];
      const list = (await res.json()) as LrclibRecord[];
      return Array.isArray(list) ? list : [];
    };
    const best = (list: LrclibRecord[], exactTitle: boolean): LrclibRecord | null => {
      const title = q.title.normalize("NFKC").trim().toLowerCase();
      const ranked = list
        .filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics))
        .filter((r) => !exactTitle || r.trackName.normalize("NFKC").trim().toLowerCase() === title)
        .filter((r) => !r.duration || (targetSec > 0 && Math.abs(r.duration - targetSec) <= 15))
        .sort((a, b) => {
          const synced = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
          if (synced !== 0) return synced;
          return Math.abs((a.duration ?? 0) - targetSec) - Math.abs((b.duration ?? 0) - targetSec);
        });
      return ranked[0] ?? null;
    };

    const withArtist = !!q.artist.trim();
    const match = best(await search(withArtist), !withArtist);
    if (match || !withArtist || targetSec <= 0) return match;

    // Spotify 可能显示本地化艺人名，而 LRCLIB 使用另一种语言的艺名。
    // 只在艺人搜索未命中时，凭精确曲名与 ±15 秒时长作最后回退。
    return best(await search(false), true);
  }

  private toResult(rec: LrclibRecord): LyricsResult {
    if (rec.instrumental) return { status: "not-found" };

    if (rec.syncedLyrics) {
      const lines = parseLrc(rec.syncedLyrics);
      if (lines.length > 0) {
        const lyrics: Lyrics = { synced: true, lines, provider: this.id };
        return { status: "found", lyrics };
      }
    }
    if (rec.plainLyrics) {
      const lines = rec.plainLyrics.split(/\r?\n/).map((l) => l.trim());
      const lyrics: Lyrics = { synced: false, lines, provider: this.id };
      return { status: "found", lyrics };
    }
    return { status: "not-found" };
  }
}

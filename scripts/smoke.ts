import { parseLrc, getActiveLineIndex, detectLang, lyricsMatchTarget, LrclibProvider, LyricsService } from "@ai-lyrics/lyrics-core";
import {
  parseAnalysis,
  parseBatchAnalysis,
  planChunks,
  extractContent,
  AiService,
  OllamaProvider,
  OpenAiCompatProvider,
  type AiProvider,
  type LineAnalysis,
} from "@ai-lyrics/ai-core";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

// 1) parseLrc — 离线确定性测试
console.log("# parseLrc");
const sample = [
  "[ti:Test Song]",
  "[ar:Tester]",
  "[00:00.50]First line",
  "[00:03.20][00:55.00]Repeated line",
  "[00:10.00]<00:10.50>Word <00:11.00>timed line",
  "[01:05.10]♪",
].join("\n");
// 排序后：500/First, 3200/Repeated, 10000/Word timed, 55000/Repeated, 65100/♪
const lines = parseLrc(sample);
assert(lines.length === 5, `5 行（重复时间戳展开为两行），实际 ${lines.length}`);
assert(lines[0].timeMs === 500 && lines[0].text === "First line", "首行 500ms / First line");
assert(lines[1].timeMs === 3200 && lines[2].timeMs === 10000, "升序排序正确");
assert(lines[2].text === "Word timed line", `剥离逐字标签，实际 "${lines[2].text}"`);
assert(lines[3].timeMs === 55000 && lines[3].text === "Repeated line", "重复时间戳第二处展开正确");
assert(lines[4].text === "", `♪ 归一为空（间奏），实际 "${lines[4].text}"`);

// 2) getActiveLineIndex
console.log("# getActiveLineIndex");
assert(getActiveLineIndex(lines, 0) === -1, "进度早于首行 → -1");
assert(getActiveLineIndex(lines, 600) === 0, "600ms → 第 0 行");
assert(getActiveLineIndex(lines, 9999) === 1, "9999ms → 第 1 行（10s 行未到）");
assert(getActiveLineIndex(lines, 10001) === 2, "10001ms → 第 2 行");
assert(getActiveLineIndex(lines, 999999) === lines.length - 1, "超末尾 → 末行");

// 3) 在线 LRCLIB（需联网；失败不致命，仅告警）
console.log("# LRCLIB live fetch (Queen - Bohemian Rhapsody)");
const service = new LyricsService({ providers: [new LrclibProvider({ userAgent: "ai-lyrics-smoke" })] });
try {
  const res = await service.getLyrics({
    title: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night at the Opera",
    durationMs: 354_000,
  });
  if (res.status === "found") {
    const kind = res.lyrics.synced ? "synced" : "plain";
    const n = res.lyrics.synced ? res.lyrics.lines.length : res.lyrics.lines.length;
    console.log(`  ✓ 命中 [${res.lyrics.provider}] ${kind}, ${n} 行`);
    if (res.lyrics.synced) {
      for (const l of res.lyrics.lines.slice(0, 3)) {
        console.log(`    ${l.timeMs}ms  ${l.text}`);
      }
    }
  } else {
    console.log(`  ⚠ 状态: ${res.status}（可能离线或来源未收录）`);
  }
} catch (e) {
  console.log("  ⚠ 在线检索异常（可能沙箱无网络）:", (e as Error).message);
}

// 本地化艺人名未收录时，按精确曲名和时长回退；不能拿同名远时长版本或异曲顶替。
console.log("# LRCLIB localized artist fallback");
const localizedTitle = "ロマンスがありあまる";
const goodRecord = {
  id: 1,
  trackName: localizedTitle,
  artistName: "Gesu no Kiwami Otome",
  albumName: null,
  duration: 225,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: "[00:01.00]matched line",
};
const wrongTitle = { ...goodRecord, id: 2, trackName: "another song", syncedLyrics: "[00:01.00]wrong title" };
const wrongDuration = { ...goodRecord, id: 3, duration: 180, syncedLyrics: "[00:01.00]wrong duration" };
const searchCalls: URL[] = [];
const mockLrclib = (includeMatch: boolean) =>
  (async (input: unknown) => {
    const url = new URL(String(input));
    searchCalls.push(url);
    const status = url.pathname.endsWith("/get") ? 404 : 200;
    const records = url.searchParams.has("artist_name")
      ? []
      : includeMatch
        ? [wrongTitle, wrongDuration, goodRecord]
        : [wrongTitle, wrongDuration];
    return { ok: status === 200, status, json: async () => records } as Response;
  }) as typeof fetch;
const localizedQuery = { title: localizedTitle, artist: "極品下流少女", durationMs: 225_000 };
const localizedResult = await new LrclibProvider({ fetchImpl: mockLrclib(true) }).fetch(localizedQuery);
assert(localizedResult.status === "found" && localizedResult.lyrics.synced && localizedResult.lyrics.lines[0]?.text === "matched line", "本地化艺人名回退命中正确同步歌词");
assert(searchCalls.length === 3 && searchCalls[1].searchParams.has("artist_name") && !searchCalls[2].searchParams.has("artist_name"), "艺人检索无结果后才按曲名重试");
const noSafeResult = await new LrclibProvider({ fetchImpl: mockLrclib(false) }).fetch(localizedQuery);
assert(noSafeResult.status === "not-found", "异曲或时长偏差过大时不误配歌词");

// 4) ai-core parseAnalysis — 容错解析（带 ```json 包裹 + 前后噪声）
console.log("# parseAnalysis (AI JSON 容错)");
const messy = 'Sure! Here you go:\n```json\n{"translation":"这是真实人生吗？","language":"English","keywords":[{"word":"fantasy","reading":"/ˈfæntəsi/","pos":"n.","meaning":"幻想"}],"examples":[{"src":"It was pure fantasy.","zh":"那纯属幻想。"}]}\n```\nHope it helps!';
const a = parseAnalysis(messy);
assert(a.translation === "这是真实人生吗？", "翻译字段解析");
assert(a.keywords.length === 1 && a.keywords[0].word === "fantasy", "关键词解析");
assert(a.examples.length === 1 && a.examples[0].zh === "那纯属幻想。", "例句解析");
const garbage = parseAnalysis("not json at all");
assert(garbage.translation === "" && garbage.keywords.length === 0, "纯垃圾输入容错为空（不再抛错）");
console.log("  ✓ 容错字段提取正常");

// 4b) 批量分块与批量解析
console.log("# planChunks / parseBatchAnalysis");
const many = Array.from({ length: 30 }, (_, i) => `line number ${i} with some words`);
const ranges = planChunks(many);
assert(ranges.length > 0, "分块非空");
assert(ranges[0][0] === 0 && ranges[ranges.length - 1][1] === 30, "分块完整覆盖 0..30");
let contiguous = true;
for (let i = 1; i < ranges.length; i++) if (ranges[i][0] !== ranges[i - 1][1]) contiguous = false;
assert(contiguous, "分块连续无缝");
assert(ranges.every(([s, e]) => e - s >= 1 && e - s <= 14), "每块大小 ≤14");

const batchJson = '{"lines":[{"translation":"行一","keywords":[],"examples":[]},{"translation":"行二","keywords":[{"word":"w","meaning":"释"}],"examples":[]}]}';
const batch = parseBatchAnalysis(batchJson, 4); // 期望 4，实际给 2 → 补齐
assert(batch.length === 4, `批量对齐到 4，实际 ${batch.length}`);
assert(batch[0].translation === "行一" && batch[1].keywords[0].word === "w", "批量字段解析");
assert(batch[3].translation === "" && batch[3].keywords.length === 0, "不足部分补空");

// 压缩短键 {i,t}（两段式翻译批量的输出形状）
const shortKeys = parseBatchAnalysis('{"lines":[{"i":1,"t":"短键一"},{"i":2,"t":"短键二"}]}', 2);
assert(shortKeys[0].translation === "短键一" && shortKeys[1].translation === "短键二", "短键 {i,t} 可解析");

// 形状容错：顶层数组 / {"0":..} 数字键对象
const batchArr = parseBatchAnalysis('[{"translation":"甲"},{"translation":"乙"}]', 2);
assert(batchArr[0].translation === "甲" && batchArr[1].translation === "乙", "顶层数组形式可解析");
const batchNum = parseBatchAnalysis('```json\n{"0":{"translation":"a"},"1":{"translation":"b"}}\n```', 2);
assert(batchNum[0].translation === "a" && batchNum[1].translation === "b", "数字键对象+代码块可解析");

// 截断容错：末尾被切断，应修复并抢救（前两行完整，第三行可能含部分文本）
const truncated = '{"lines":[{"translation":"一"},{"translation":"二"},{"translation":"三是被截断的长';
const sal = parseBatchAnalysis(truncated, 3);
assert(sal.length === 3, "截断输出对齐到 3（不报错）");
assert(sal[0].translation === "一" && sal[1].translation === "二", "截断输出恢复出完整前两行");
assert(sal[2].translation.startsWith("三"), `修复恢复出部分末行，实际 "${sal[2].translation}"`);
// 空内容不应抛错
assert(parseBatchAnalysis("", 2).length === 2, "空内容返回等长空数组（不报错）");

// 按行号 i 归位：乱序 + 缺中间行也不错位
const iMapped = parseBatchAnalysis('{"lines":[{"i":3,"translation":"丙"},{"i":1,"translation":"甲"}]}', 3);
assert(iMapped[0].translation === "甲", "i=1 放到第0行");
assert(iMapped[1].translation === "" , "缺失的第2行留空（不被后面挤占）");
assert(iMapped[2].translation === "丙", "i=3 放到第2行");
// 无 i 时按顺序
const seqMapped = parseBatchAnalysis('{"lines":[{"translation":"a"},{"translation":"b"}]}', 2);
assert(seqMapped[0].translation === "a" && seqMapped[1].translation === "b", "无 i 时按出现顺序");

// extractContent：SSE 流式 + 单 JSON
console.log("# extractContent (SSE / 单JSON)");
const sse = [
  'data: {"choices":[{"delta":{"content":"{\\"translation\\":\\"你"}}]}',
  'data: {"choices":[{"delta":{"content":"好\\"}"}}]}',
  "data: [DONE]",
].join("\n");
assert(extractContent(sse) === '{"translation":"你好"}', `SSE 拼接 delta，实际 ${extractContent(sse)}`);
const single = '{"choices":[{"message":{"content":"hi"}}]}';
assert(extractContent(single) === "hi", "单 JSON 取 message.content");

// 4c) analyzeAll 去重：相同歌词只请求一次，结果分发到所有出现处
console.log("# analyzeAll 去重");
const requested: string[][] = [];
const mockProvider: AiProvider = {
  id: "mock",
  async analyzeLine() {
    return { translation: "x", keywords: [], examples: [] };
  },
  async analyzeLines(ls) {
    requested.push(ls);
    return ls.map((l) => ({ translation: `T:${l}`, keywords: [], examples: [] }) as LineAnalysis);
  },
};
const svc = new AiService(mockProvider, "中文");
const songLines = ["A", "B", "A", "C", "B", "A"]; // 唯一: A,B,C
const got: (LineAnalysis | null)[] = new Array(songLines.length).fill(null);
await svc.analyzeAll(songLines, {}, { onUpdate: (i, a) => (got[i] = a) });
const flatReq = requested.flat();
assert(flatReq.length === 3, `仅请求 3 个唯一行，实际 ${flatReq.length}`);
assert(new Set(flatReq).size === 3, "请求的都是唯一行");
assert(
  got[0]?.translation === "T:A" && got[2]?.translation === "T:A" && got[5]?.translation === "T:A",
  "A 的结果分发到全部 3 处",
);
assert(got[1]?.translation === "T:B" && got[4]?.translation === "T:B", "B 的结果分发到 2 处");

// 4d) 多模型 fallback：第一个模型失败 → 自动用第二个
console.log("# 多模型 fallback");
const fbCalls: string[] = [];
const fbFetch = (async (_url: unknown, init?: { body?: string }) => {
  const b = JSON.parse(init?.body ?? "{}") as { model?: string };
  fbCalls.push(b.model ?? "");
  if (b.model === "bad") {
    return { ok: false, status: 500, text: async () => "server error" } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"lines":[{"i":1,"translation":"好"}]}' } }] }),
  } as unknown as Response;
}) as unknown as typeof fetch;
const fbProvider = new OpenAiCompatProvider({
  baseUrl: "http://x/v1",
  apiKey: "k",
  models: ["bad", "good"],
  fetchImpl: fbFetch,
  streaming: false,
});
const fbRes = await fbProvider.analyzeLines(["hello"], { targetLang: "中文" });
assert(fbCalls.includes("bad") && fbCalls.includes("good"), "失败后尝试了第二个模型");
assert(fbRes[0]?.translation === "好", "第二个模型成功返回翻译");

// 4e) 语言识别 + 「歌词语言==目标语言则跳过」判定
console.log("# detectLang / lyricsMatchTarget");
assert(detectLang(["我爱你", "今天天气真好"]) === "zh", "中文歌→zh");
assert(detectLang(["I love you", "hello world"]) === "en", "英文歌→en");
assert(detectLang(["Hello 我 的 朋友 你好 世界 多 一些 中文 字"]) === "zh", "中文为主混合→zh");
// 日文：含汉字但有假名 → ja（不应误判中文，修复误跳过 bug）
assert(detectLang(["君の名は", "残酷な天使のテーゼ"]) === "ja", "日文（假名+汉字）→ja");
assert(detectLang(["夜に駆ける", "沈むように溶けてゆくように"]) === "ja", "汉字偏多的日文→ja");
assert(detectLang(["사랑해 너를", "오늘 날씨 좋다"]) === "ko", "韩文→ko");
// 跳过判定：歌词语言==目标语言才跳过
assert(lyricsMatchTarget(["我爱你", "今天天气真好"], "中文") === true, "中文歌+目标中文→跳过");
assert(lyricsMatchTarget(["I love you", "hello world"], "中文") === false, "英文歌+目标中文→解析");
assert(lyricsMatchTarget(["I love you", "hello world"], "English") === true, "英文歌+目标English→跳过");

// 5) Ollama 在线（仅当本地有服务时）
console.log("# Ollama live (仅当本地 11434 在跑)");
try {
  const ollama = new OllamaProvider({ model: "qwen2.5" });
  const r = await ollama.analyzeLine({ line: "Is this the real life?" });
  console.log(`  ✓ Ollama 返回翻译: ${r.translation || "(空)"}`);
} catch (e) {
  console.log("  ⚠ Ollama 不可用（未安装/未运行，预期内）:", (e as Error).message.slice(0, 80));
}

console.log("\nALL OFFLINE ASSERTIONS PASSED");

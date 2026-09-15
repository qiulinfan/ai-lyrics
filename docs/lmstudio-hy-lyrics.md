# Hy-MT2 with LM Studio on macOS

This fork adds a local Chinese-translation setup to [onewilk/ai-lyrics](https://github.com/onewilk/ai-lyrics), based on upstream commit `2ad6558dfc2a9c1ff58c36fbdb683828d299a18c`.

## Requirements

- macOS, Node.js 18 or newer, Python 3, and pnpm.
- Spotify desktop with [Spicetify](https://spicetify.app/docs/getting-started) installed.
- LM Studio with its `lms` CLI available at `~/.lmstudio/bin/lms`.
- The [Tencent Hy-MT2-1.8B GGUF model](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF), preferably Q8_0 for this setup. Its LM Studio model key must be `hy-mt2-1.8b`.

Download the model in LM Studio, or select its quantization with:

```sh
lms get https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF --gguf --select
```

## Install

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:lyrics-service
```

On a first-time Spicetify installation, back up the unmodified Spotify client with `spicetify backup`. Then build and apply the extension:

```sh
pnpm --filter @ai-lyrics/spicetify apply
./scripts/lmstudio-lyrics/启动歌词翻译.command
```

The startup command launches the lightweight bridge; it does not load model weights. In Spotify, click the captions icon in the playbar or press **Command + Shift + L**.

The fork defaults to:

| Setting | Value |
|---|---|
| Provider | OpenAI-compatible |
| Base URL | `http://127.0.0.1:11435/v1` |
| Model | `lyrics-hy18b` |
| API key | Empty |
| Translation language | Chinese |
| UI language | Simplified Chinese |
| Background prefetch | Off |

The bridge serves this fixed local model and Chinese target. It is not a general-purpose OpenAI proxy. It connects to LM Studio at `127.0.0.1:1234`; no public model endpoint is used. Lyrics are fetched from LRCLIB. The fork disables the Spotify private-lyrics fallback.

## Translation and lifecycle

The service deduplicates a song's lyric lines and translates them sequentially, one model request per unique line. This avoids a small model merging lines and shifting subsequent subtitle assignments. Cross-line context is consequently limited, and machine translations can still misinterpret poetic language.

The extension requests batches; the bridge combines requests for the same song into one shared task and returns the relevant lines from the result. Existing timestamps control highlighting. Results are displayed after validation rather than exposing partially aligned model output.

- A cache miss loads one fixed LM Studio instance, `lyrics-hy18b`, with an 8192-token context and parallelism of 1.
- Translation-cache hits do not load an unloaded model.
- Valid translation requests refresh idle time. Active work prevents unloading; task completion restarts the idle countdown. Health checks do not keep the model alive.
- After **10 idle minutes**, the bridge unloads only `lyrics-hy18b` and remains available for the next request.
- Loading and unloading are serialized. A new request arriving during unloading waits and then reloads the model.
- The service does not watch Spotify windows, quit LM Studio, or unload other model instances.
- There is no login item or launch agent. Run the startup command after restarting the computer.

## Resource limits

- One active song task, two queued tasks, and at most eight waiting clients.
- Identical requests share work. Once every waiting client cancels, queued work is removed or active generation is cancelled.
- Requests exceeding the queue limit return HTTP 429 rather than allocating more model instances.
- Song-task timeout: 45 seconds. Each line allows at most 256 output tokens.
- Request body: at most 64 KiB. Song context: at most 10,000 characters across supplied context and selected lines, and 80 unique lyric lines.
- Bridge result cache: at most 128 entries / 4 MiB, expiring after one hour. The extension's in-memory analysis cache is capped at 1024 lines.
- The HTTP listener binds to loopback and permits browser access only from Spotify's desktop origin.

These are service bounds, not a system-wide RAM quota. Manually loading other models or changing LM Studio settings can still increase total memory use.

## Verification and diagnostics

```sh
pnpm test:lyrics-service
curl http://127.0.0.1:11435/health
lms ps --json
```

The tests cover queue capacity, duplicate sharing, cancellation, cache bounds, line mapping, the exact idle threshold, concurrent loading, unloading races, and recovery from a failed load. Local integration testing also exercised real model loading, idle unloading, cache hits without a loaded model, and reloading with an accelerated idle threshold. The production threshold remains 600,000 ms.

Runtime files are written beside the bridge scripts and ignored by Git:

- `bridge.pid`, `startup.lock`
- `bridge.log`
- `bridge-metrics.jsonl` and its rotated predecessor

Metrics include lifecycle events, timings, and counts; they do not log lyric text. LM Studio's own logging settings are managed separately.

The existing `ai-lyrics.js` distribution entry is regenerated with `pnpm release`. Source changes alone do not update an already-running Spotify client; rebuild and apply them explicitly.

## Credits and scope

The original interface, player integration, lyric retrieval, and analysis infrastructure are from **onewilk/ai-lyrics**, under MIT. This fork adds the local Hy-MT2 defaults, bounded bridge, and model lifecycle management. The upstream license remains in `LICENSE`.

Model weights, full lyrics, translated lyric datasets, private installation paths, local benchmarks, and runtime logs are not distributed in this repository. Model and lyric licenses remain separate from the code license.

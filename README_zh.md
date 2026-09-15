# AI 歌词学习器 (ai-lyrics)

> **本 fork：macOS 本地中文歌词翻译。** 新增 Hy-MT2-1.8B / LM Studio 适配、全局并发限制、模型按需加载和空闲 10 分钟卸载；默认中文翻译，歌词来源为 LRCLIB。详见[安装与生命周期说明](docs/lmstudio-hy-lyrics.md)。基于 [onewilk/ai-lyrics](https://github.com/onewilk/ai-lyrics)，保留上游署名和 MIT 许可证。

[English](./README.md) · **简体中文**

边听歌边学语言：自动识别当前播放歌曲 → 联网抓取歌词 → 整页跟随进度滚动显示歌词，每行下方用 AI 提供**翻译 / 关键词解析 / 语法要点 / 例句**，支持点击歌词或拖动底部进度条同步调整播放进度。

以 **Spicetify 扩展**（Spotify 桌面客户端）形式运行。AI 可插拔——支持**本地模型**（LM Studio / Ollama，隐私、免费、离线）或任意 **OpenAI 兼容**云端端点。翻译目标语言与界面语言均可在设置中配置。

> ⚠️ **免责声明**：本项目仅供个人学习与研究。Spicetify 通过修改 Spotify 桌面客户端实现注入，这在技术上可能违反 Spotify 的服务条款，请自行评估风险。歌词来自 [LRCLIB](https://lrclib.net/)（社区贡献）及 Spotify 客户端内的歌词接口，版权归原始权利方所有；AI 翻译为机器生成、仅供参考。使用本工具产生的任何后果由使用者自行承担。

## 截图

![ai-lyrics — 整页歌词 + AI 翻译/关键词/语法解析](docs/preview.png)

## 功能

- 整页歌词跟随播放进度滚动、高亮当前行；点击任意行或拖动进度条跳转。
- 每行 AI **翻译 + 关键词 + 语法要点 + 例句**；流式逐行显示，当前行附近优先。
- 解析结果按歌曲持久化缓存（localStorage），重复播放与副歌重复行不再请求。
- 歌词语言与翻译目标语言一致时自动跳过解析（例如目标设为 English 时跳过英文歌）。
- 无时间轴的纯文本歌词也会逐行翻译解析。
- 界面多语言（跟随 Spotify 语言，或手动切换）。

## 结构（pnpm monorepo）

```
packages/
  player-core/   纯 TS：PlayerAdapter 接口 + Track 类型（曲目/进度/seek/事件）
  lyrics-core/   纯 TS：LRC 解析、歌词源（LRCLIB）、进度→当前行、语言识别、缓存
  ai-core/       纯 TS：翻译/解词/语法/例句服务，可插拔 provider（Ollama / OpenAI 兼容）
  ui/            React 组件与 hooks（仅依赖 props/hooks，不引用宿主全局）
apps/
  spicetify/     Spicetify 扩展：SpicetifyPlayerAdapter + 路由挂载 + esbuild 构建
```

核心逻辑（`packages/*`）与宿主解耦、不直接引用 `Spicetify.*` 全局，便于独立测试与维护。

## 安装与开发

前置：[Node.js](https://nodejs.org/) ≥ 18、[pnpm](https://pnpm.io/)、已安装并启用 [Spicetify](https://spicetify.app/)。

```bash
pnpm install
pnpm --filter @ai-lyrics/spicetify apply   # 构建并安装扩展到 Spicetify，自动 refresh
```

完成后在 Spotify 中：

- 播放栏的字幕图标，或快捷键 **Cmd/Ctrl + Shift + L**，打开/关闭歌词页；**Esc** 退出。
- 其他命令：`pnpm dev`（watch 构建并安装）、`pnpm typecheck`（类型检查）、`pnpm smoke`（核心逻辑 headless 验证）。

## 配置 AI

打开歌词页右下角 ⚙ 设置（点击打开设置；长按可强制重新检索并解析当前歌词），选择提供方并填写：

### 本地模型（推荐，隐私 + 免费）

- **LM Studio**：下载并加载一个模型（如 `Qwen3-4B-Instruct-2507` 的 MLX 量化版），在开发者页启动本地服务器并**打开 CORS 开关**。
  - 提供方：OpenAI 兼容；Base URL：`http://localhost:1234/v1`；API Key：留空；模型：填服务器显示的模型 id。
- **Ollama**：`ollama pull <model>` 后，设置环境变量 `OLLAMA_ORIGINS="*"` 允许浏览器跨源访问。
  - 提供方：Ollama；Base URL：`http://localhost:11434`；模型：你拉取的模型名。

### OpenAI 兼容云端

提供方：OpenAI 兼容；填入 Base URL、API Key 与模型名。**密钥仅保存在浏览器本地（localStorage），不会提交到仓库或发往第三方。**

> **关于 CORS**：若你的端点不返回 `Access-Control-Allow-Origin`，浏览器会拦截直连。可用 `scripts/local-proxy.mjs` 起一个本地转发代理（见脚本内注释），或改用自带 CORS 的本地端点（LM Studio / Ollama）。

### 本地模型推荐

任务是「整首歌词逐行翻译 + 语法/关键词 JSON 输出」，对**指令遵循**和 **JSON 稳定性**要求高于纯翻译。建议如下：

| 模型 | 量化 | 适用机器 | 取舍 |
|---|---|---|---|
| **Qwen3-4B-Instruct-2507** ⭐ | MLX 4bit | M 系 8–16GB | 速度/质量均衡，**首选**。Instruct 变体不“深度思考”，避免推理模型先想一分钟再作答 |
| Qwen3.5-4B | MLX 4bit | M 系 8–16GB | 更新一代、质量略好；**注意**它默认开思考、且关思考开关在 LM Studio 中可能不生效，会显著变慢 |
| Qwen3-1.7B / 0.6B | 4bit | 低配 / 求快 | 更快更省内存，讲解深度下降，适合只要翻译 |
| Qwen3-8B / 14B | 4bit | 16GB+ | 质量更好但更慢、更吃内存 |

经验法则：

- **Apple Silicon 选 MLX 格式**，比同量化的 GGUF 快约 20–30%。
- **优先 Instruct（非思考）变体**——推理/思考模型会先输出大段思考再吐 JSON，本任务下纯属拖慢。
- 加载时**上下文长度 ≥ 8192**（要容纳整首歌语境 + 批量 JSON，4096 可能截断）。
- 想再快可在 LM Studio 开 **Speculative Decoding**（用 0.6B 当 4B 的草稿模型，JSON 这类规整输出接受率高，质量无损）。
- 每次请求的歌词行数（分块大小）可在设置中调整，默认 22。

### 性能参考（实测）

> 测试环境：Apple M4 / 16GB / macOS 26.5；LM Studio + `qwen3-4b-instruct-2507-mlx`（MLX 4bit，上下文 8192）；流式、关思考；分块 22 行、本地串行。

**歌曲**：Viva La Vida — Coldplay（约 4:02）　**歌词**：48 行（44 行可解析，去重后 31 个唯一行）

| 阶段（**冷启动，无缓存**） | 用时 |
|---|---|
| 歌词获取（LRCLIB） | ≈ 8 s（受网络影响） |
| **首行翻译出现（流式逐行）** | **≈ 3.5 s** |
| 全曲解析完成（44 行：翻译 + 语法 + 关键词） | ≈ 66 s（后台进行） |
| **再次播放同一首（缓存命中）** | **≈ 即时（0 请求）** |

> 说明：解析流式逐行输出、当前行附近优先，**首行约 3.5 秒即出现**，全曲解析在后台继续、无需等待。结果按歌曲持久化缓存，重复播放或副歌重复行不再请求。换更小的模型（如 1.7B）或开投机解码可进一步缩短全曲耗时。

## 致谢

本项目的部分实现参考了 [**Lucid Lyrics**](https://gitlab.com/sanoojes/lucid-lyrics)——一个优秀的 Spicetify 歌词扩展。我们在路由式整页挂载（通过 `Spicetify.Platform.History` 注册路由、命中时接管主视图）等方面学习并借鉴了它的做法。感谢 [@sanoojes](https://gitlab.com/sanoojes) 及其贡献者的开源工作。

## 许可

[MIT](./LICENSE) © ai-lyrics contributors

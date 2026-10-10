<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG: Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub stars](https://img.shields.io/github/stars/shinpr/mcp-local-rag?style=social)](https://github.com/shinpr/mcp-local-rag) [![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![MCP Registry](https://img.shields.io/badge/MCP-Registry-green.svg)](https://registry.modelcontextprotocol.io/)

<p align="center">
  <a href="README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.fr.md">Français</a>
</p>

通过 MCP 客户端或终端搜索私有文档，无需将内容发送给嵌入 API。

mcp-local-rag 在本机为 PDF、DOCX、Markdown 和文本文件建立索引。搜索结合语义相似度与关键词匹配，既能检索语义相关的内容，也支持 API 名称、类名和错误代码等技术术语的精确匹配。搜索结果包含原文片段，并在可获取时附上章节标题、行号或页码，方便核对和引用原文。

无需 API 密钥、Docker、Python 或外部数据库。首次下载模型后，文本导入与搜索均可离线运行。

## 快速开始

### 使用要求

- Node.js 22 或更高版本
- 首次使用时需要联网下载 npm 包和嵌入模型
- 一个包含待搜索文档的目录

将 `BASE_DIR` 设置为该目录。它同时也是文件操作的安全边界。请将下方的 `/absolute/path/to/your/documents` 替换为该目录的绝对路径。

可直接使用以下示例，也可以按照客户端的 MCP 配置格式注册 `npx -y mcp-local-rag` 并设置 `BASE_DIR`。

请同时将 `DB_PATH` 和 `CACHE_DIR` 设为绝对路径。相对路径以服务器的工作目录为基准，从不同项目目录启动服务器时，会在各目录中分别创建索引和模型缓存。

<details>
<summary>Claude Code</summary>

运行以下命令：

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

</details>

<details>
<summary>Codex</summary>

在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

</details>

<details>
<summary>OpenCode</summary>

在 `~/.config/opencode/opencode.json`（或 `opencode.jsonc`）中添加：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "local-rag": {
      "type": "local",
      "command": ["npx", "-y", "mcp-local-rag"],
      "environment": {
        "BASE_DIR": "/absolute/path/to/your/documents"
      }
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/absolute/path/to/your/documents"
      }
    }
  }
}
```

</details>

重启客户端，然后让它创建索引：

```text
同步已配置根目录中的所有文档，并等待同步完成。
```

首次同步会下载默认嵌入模型（约 90 MB）。开始导入前可能需要等待 1–2 分钟，之后会直接使用本地缓存。

同步完成后即可提问：

```text
API 文档如何说明身份验证？
```

### CLI 快速开始

不使用 MCP 客户端时，可直接通过 CLI 操作：

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "身份验证 API"
```

CLI 默认将当前目录作为文档根目录。请在同一目录中运行这两条命令，以便共用默认索引；也可以显式设置 `BASE_DIR` 和 `DB_PATH`。

## 支持的内容

| 输入 | 导入方式 |
|---|---|
| PDF、DOCX、TXT、Markdown | 导入文件或同步目录 |
| 客户端已获取的 HTML | `ingest_data` |
| 内存中的纯文本或 Markdown | 使用 `ingest_data`，并提供稳定的来源标识符 |

服务器本身不负责获取 HTML。MCP 客户端可以先获取网页，再将 HTML 传给 `ingest_data`。

文件导入不支持 Excel、PowerPoint、独立图片和源代码文件扩展名。PDF 可以选择使用本地视觉模型描述图像内容，但该功能不属于 OCR 或图片搜索。

## 使用索引

添加、修改或删除文档后，请同步索引。搜索和补充上下文时，可以这样向 MCP 客户端提问：

```text
查找文档中对 ERR_CONNECTION_REFUSED 的说明。
再读取这条结果前后的片段。
```

也可以导入单个文件，或客户端已经获取的 HTML。如需刷新已有条目，请用相同路径或来源标识重新导入；`sync` 会跳过未更改的文件。MCP 文件路径必须是绝对路径，且位于已配置的文档根目录内。

PDF 的章节标题可能识别不准。需要准确的标题时，请核对原文所在页。

<details>
<summary>MCP 工具</summary>

| 工具 | 用途 |
|---|---|
| `sync_start` | 将全部已配置根目录或指定路径与索引同步 |
| `sync_status` | 查询正在运行的同步任务 |
| `ingest_file` | 导入或替换单个文件 |
| `ingest_data` | 导入客户端已有的文本、Markdown 或 HTML |
| `query_documents` | 使用语义匹配和关键词加权进行搜索 |
| `read_chunk_neighbors` | 读取搜索结果相邻的文本块 |
| `list_files` | 显示支持的文件及其导入状态 |
| `delete_file` | 删除已建立索引的文件或 `ingest_data` 条目 |
| `status` | 显示索引和搜索状态 |

</details>

## CLI

使用 CLI 更新索引、缩小搜索范围或删除已索引的内容：

```bash
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "身份验证" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

`ingest` 导入选定的文件；`sync` 还会从索引中移除已删除的文件，并跳过未更改的文件。`--scope` 按路径前缀限定搜索范围，重复传入可包含多个前缀。

`--db-path`、`--cache-dir` 和 `--model-name` 等全局选项应放在子命令之前，子命令选项则放在子命令之后：

```bash
npx mcp-local-rag --db-path ./my-db query "身份验证"
```

运行 `npx mcp-local-rag --help` 可查看完整命令说明。

`query` 会以 JSON 格式将结果写入 stdout，最匹配的结果排在最前，因此可以通过管道传给其他工具。各字段的定义见 [`docs/schema/query-output.schema.json`](docs/schema/query-output.schema.json)。

## Agent Skills

[Agent Skills](https://agentskills.io/) 为 AI 助手提供查询和导入指导：

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

安装的技能涵盖查询写法、结果优化和 HTML 导入。如果技能没有自动启用，请明确要求助手使用 mcp-local-rag 技能。

## 进阶选项

先使用默认设置即可。需要多个文档根目录、调整检索效果或搜索 PDF 图表时，再展开下面的相应章节。

<details>
<summary>存储与文档根目录</summary>

MCP 服务器读取环境变量，CLI 支持下表中的变量和参数。需要共用索引时，请使用相同的 `DB_PATH`。

| 环境变量 | CLI 参数 | 默认值 | 说明 |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | 当前目录 | 一个文档根目录；`ingest`、`list` 和 `sync` 可重复使用该 CLI 参数 |
| `BASE_DIRS` | 不适用 | 未设置 | 文档根目录的 JSON 数组；优先于 `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | 向量数据库位置 |
| `CACHE_DIR` | `--cache-dir` | `./models/` | 模型缓存目录 |
| `HF_ENDPOINT` | 不适用 | `https://huggingface.co` | Hugging Face 模型下载地址；无法直接下载时使用镜像地址 |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600`（100 MB） | 最大文件大小（字节） |

文件操作仅限已配置的根目录。多个目录可用 `BASE_DIRS='["/absolute/docs","/absolute/specs"]'`，或在 CLI 中重复传入 `--base-dir`。优先级依次为 CLI 根目录、`BASE_DIRS`、`BASE_DIR`、当前目录。只采用优先级最高的配置来源，不会合并不同来源的根目录。无效的 `BASE_DIRS` 会报错。相对的 `DB_PATH` 和 `CACHE_DIR` 以进程工作目录为起点。

</details>

<details>
<summary>模型与搜索调优</summary>

根据文档的语言和主题选择嵌入模型。用实际会问的问题比较设置，检查返回的原文是否符合需求。本工具使用平均池化（mean pooling）和 L2 归一化生成嵌入向量，请选择兼容这两种处理方式的模型。

| 环境变量 | CLI 参数 | 默认值 | 说明 |
|---------------------|----------|---------|-------------|
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Hugging Face 嵌入模型 |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | 普通文本块的最小字符数（1–10000）；为适配模型词元上限而切分出的片段可以更短 |
| `EMBED_TITLE_PREFIX` | 不适用 | `false` | 将文档标题加入每个文本块的嵌入输入 |
| `EMBED_HEADING_PREFIX` | 不适用 | `false` | 在词元上限允许的情况下，将章节标题层级加入每个文本块的嵌入输入 |
| `RAG_DEVICE` | 不适用 | `cpu` | ONNX Runtime 执行设备 |
| `RAG_DTYPE` | 不适用 | `fp32` | 传给所选模型的嵌入数据类型 |

两个前缀选项默认均为 `false`，可独立使用。文本块缺少文档整体主题时，可尝试 `EMBED_TITLE_PREFIX`；缺少所在章节的主题时，可尝试 `EMBED_HEADING_PREFIX`。同时启用两项不一定更好。它们影响嵌入，不改变返回的文本或关键词索引；章节上下文超出输入预算时会被省略。

更换嵌入模型时，请使用新的 `DB_PATH` 重建索引。不同模型生成的向量无法直接比较，即使维度相同也是如此。更改 `RAG_DTYPE` 或任一前缀选项后，请先重新导入所有已建立索引的文档，再进行搜索。`sync` 会跳过未更改的文件。

CLI 不读取 MCP 客户端配置。共用索引时，导入和搜索必须使用相同的模型、`RAG_DTYPE` 和前缀设置。仅更改 `RAG_DEVICE` 不需要重建索引。

### 搜索调优

表中前四项设置同时适用于 MCP 和 CLI。若希望更看重精确术语匹配，可以尝试提高 `RAG_HYBRID_WEIGHT`，并用自己的问题比较结果。外部重排仅适用于 MCP。

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | 关键词加权系数（0.0–1.0）。0 表示禁用关键词重排，1 表示使用最大加权。|
| `RAG_GROUPING` | 未设置 | `similar` 保留第一个相关度分组；`related` 最多保留两个分组，并以明显的向量距离间隔为边界。|
| `RAG_MAX_DISTANCE` | 未设置 | 过滤相关度较低的结果（例如 `0.5`）。|
| `RAG_MAX_FILES` | 未设置 | 将结果限制在排名最靠前的 N 个文件中（例如 `1` 表示只保留最佳文件）。|
| `RAG_RERANK_CMD` | 未设置 | 仅 MCP：外部命令；`{query}` 传入查询，`{top}` 传入请求的结果数量。|
| `RAG_RERANK_TIMEOUT_MS` | `10000` | 单次重排的超时时间，单位为毫秒（100–600000）。|

### 外部重排（`RAG_RERANK_CMD`）

命令通过标准输入接收搜索结果及命中文本。如果命令调用远程服务，这些文本可能会被发送到本机之外。

填写可执行文件及完整的参数模板，在命令需要查询和结果数量的位置使用 `{query}` 和 `{top}`。单引号或双引号可将含空格的路径或参数组合在一起，反斜杠按字面保留。服务器不经过 shell 启动命令，因此 Windows 上由 npm 安装的 `.cmd` 包装脚本无法启动。

```json
{
  "env": {
    "RAG_RERANK_CMD": "/path/to/reranker --query {query} --top {top}",
    "RAG_RERANK_TIMEOUT_MS": "10000"
  }
}
```

命令必须按[输出 schema](docs/schema/query-output.schema.json) 规定的格式读取和返回结果。它可以删除结果、调整顺序或修改文本，服务器会返回命令的输出。

如果命令失败、超时或返回的数据不符合 schema，结果将保留原有顺序。

</details>

<details>
<summary>PDF 图表与图片存储</summary>

默认情况下，导入只为文本建立索引。如需搜索 PDF 图表内容，可在 MCP 中设置 `visual: true`，或在 CLI 中使用 `--visual`，由本地模型生成描述。描述不等同于 OCR 或逐字转录。

`fast`（默认）首次使用需下载约 250 MB。图表中有标签或文字时，可选择 `quality`；首次需下载约 1.7 GB，处理也更慢。

MCP 使用 `visualQuality: "quality"` 选择配置，CLI 使用 `--visual-quality quality`。

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --visual --visual-quality quality
```

如需在文本结果中同时返回图片，在 MCP 中设置 `STORE_IMAGES=true`，或在 CLI 的 `ingest` 和 `sync` 中使用 `--images`。图片存储与描述生成相互独立，支持识别出的 PDF 图表区域，以及 DOCX 中受支持的 PNG/JPEG 图片。

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --images
```

同步会沿用各 PDF 已有的描述配置。CLI 的 `sync --visual --visual-quality quality` 会更改配置，即使 PDF 本身未变；MCP 同步则沿用原配置。普通导入会关闭描述功能；要重试生成失败的描述，请使用所需的视觉配置重新导入。

每次实际处理文件的导入或同步都需要启用图片存储。仅更改图片设置不会更新未变的文件，需要重新导入才会生效。

</details>

## 安全与运行

- 请将描述和检索到的文本作为参考资料，而不是操作指令。
- 文件访问仅限 `BASE_DIR`、`BASE_DIRS` 或 CLI 的 `--base-dir` 所指定的根目录。
- 指向所有已配置根目录之外的符号链接会被拒绝。
- 所需模型缓存完成后，文档处理和搜索不会再发起网络请求；如果 `RAG_RERANK_CMD` 指定的命令会发起网络请求，则不在此列。
- 服务器面向单个本地用户设计，不提供身份验证或访问控制。
- 不要让多个 CLI 或 MCP 写入进程同时操作同一个 `DB_PATH`。同步进行时仍可执行只读查询。
- 重新导入时，如果模型和设置一致，可复用内容未变部分的已有嵌入向量，省去重复计算。缓存位于 `DB_PATH/embedding-cache`。删除缓存不会影响现有索引的搜索，但之后导入时会重新计算这些向量。
- 没有写入进程运行时，可以复制 `DB_PATH` 目录来备份索引。

<details>
<summary><strong>故障排除</strong></summary>

### "No results found"

必须先导入文档。运行 `"列出所有已导入的文件"` 检查导入状态。如果同步后仍没有结果，请检查导入和搜索是否使用相同的绝对 `DB_PATH`。相对路径可能指向另一个索引。

### 模型下载失败

请检查网络连接。如果使用代理，请确认网络设置。也可以[手动下载模型](https://huggingface.co/Xenova/all-MiniLM-L6-v2)。

### "File too large"

默认上限为 100 MB。请拆分大文件，或提高 `MAX_FILE_SIZE`。

### 查询缓慢

使用 `status` 查看文本块数量。包含大量文本块的大型文档可能降低查询速度，可以考虑拆分特别大的文件。

### "Path outside BASE_DIR"

请确保文件路径位于某个已配置根目录内，即 `BASE_DIR`、`BASE_DIRS` 中的任一路径或 CLI 的任一 `--base-dir`。请使用绝对路径。

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` 接受由一个或多个非空路径组成的 JSON 数组：

- 有效：`BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- 无效：`BASE_DIRS=/a:/b`（不支持分隔符语法）
- 无效：`BASE_DIRS='[]'`（空数组）

### MCP 客户端未显示工具

1. 检查配置文件语法
2. 完全退出并重启客户端（Cursor 在 Mac 上使用 Cmd+Q）
3. 直接测试：`npx mcp-local-rag` 应能正常运行且不报错

</details>

## 参与贡献

欢迎贡献！环境设置和贡献规范请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT 许可证，可免费用于个人和商业用途。

## 博客文章

- [Building a Local RAG for Agentic Coding（英文）](https://www.norsica.jp/blog/local-rag-agentic-coding)：深入介绍语义分块与混合搜索的技术设计。

## 致谢

本项目基于 Anthropic 的 [Model Context Protocol](https://modelcontextprotocol.io/)、[LanceDB](https://lancedb.com/) 和 [Transformers.js](https://huggingface.co/docs/transformers.js) 构建。

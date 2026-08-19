<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG: Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub stars](https://img.shields.io/github/stars/shinpr/mcp-local-rag?style=social)](https://github.com/shinpr/mcp-local-rag)
[![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-green.svg)](https://registry.modelcontextprotocol.io/)

<p align="center">
  <a href="README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.fr.md">Français</a>
</p>

通过 MCP 客户端或终端搜索私有文档，无需将内容发送给嵌入 API。

mcp-local-rag 在本机为 PDF、DOCX、Markdown 和文本文件建立索引。搜索结合语义相似度与关键词匹配，既能理解查询意图，也能准确匹配 API 名称、类名和错误代码等技术术语。

## 功能

- **本地运行：** 文档解析、嵌入、存储和搜索全部在本机完成。首次下载模型后，文本导入和搜索均可离线使用。
- **混合搜索：** 语义检索负责查找相关概念，关键词匹配则提高精确技术术语的排名。
- **可配置嵌入模型：** 可根据文档的语言和领域选择合适的 Hugging Face 嵌入模型。
- **语义分块：** 按主题边界而非固定字符数拆分文档，并保持 Markdown 代码块完整。
- **MCP 和 CLI：** AI 编程工具与终端可使用同一份索引。

无需 API 密钥、Docker、Python 或外部数据库。

## 快速开始

### 使用要求

- Node.js 22 或更高版本
- 首次使用时需要联网下载 npm 包和嵌入模型
- 一个包含待搜索文档的目录

将 `BASE_DIR` 设置为该目录。它同时也是文件操作的安全边界。请将下方的 `/absolute/path/to/your/documents` 替换为该目录的绝对路径。

mcp-local-rag 通过本地 stdio 服务器使用标准 MCP 协议，因此可与支持本地 MCP 服务器的 AI 编程工具及其他 MCP 宿主配合使用。

可直接使用以下示例，也可以按照客户端的 MCP 配置格式注册 `npx -y mcp-local-rag` 并设置 `BASE_DIR`。

**Claude Code：** 运行以下命令：

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

**Codex：** 在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

**OpenCode：** 在 `~/.config/opencode/opencode.json`（或 `opencode.jsonc`）中添加：

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

**Cursor：** 在 `~/.cursor/mcp.json` 中添加：

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

## 为什么开发它

出于保密要求或组织政策，有些文档不能发送给托管式嵌入服务。将索引保留在本机，既能搜索这些文档，也不会产生按查询计费的 API 成本。

单纯依赖语义搜索，可能会漏掉技术文档中重要的精确标识符。关键词重排可以保留这些精确匹配，同时继续利用自然语言检索。

## 支持的内容

| 输入 | 导入方式 |
|---|---|
| PDF、DOCX、TXT、Markdown | 导入文件或同步目录 |
| 客户端已获取的 HTML | 使用 `ingest_data`；通过 Readability 清理后转换为 Markdown |
| 内存中的纯文本或 Markdown | 使用 `ingest_data`，并提供稳定的来源标识符 |

服务器本身不负责获取 HTML。MCP 客户端可以先获取网页，再将 HTML 传给 `ingest_data`。

文件导入不支持 Excel、PowerPoint、独立图片和源代码文件扩展名。PDF 可以选择使用本地视觉模型描述图像内容，但该功能不属于 OCR 或图片搜索。

## MCP 工具

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

### 同步文档根目录

`sync_start` 会导入新增和已修改的文件，跳过字节完全相同的文件，并删除已不存在文件的索引记录：

```text
同步已配置文档根目录中的所有内容，并等待完成。
```

该工具会立即返回 `jobId`。客户端应持续查询 `sync_status`，直到状态变为 `succeeded` 或 `failed`。同步期间不使用视觉模式；发生变化的 PDF 会按文本导入。

服务器进程只保留一个同步任务记录。新任务会替换已经结束的记录，服务器重启后该记录也会丢失。

### 导入单个文件

`ingest_file` 支持 PDF、DOCX、TXT 和 Markdown。通过 MCP 传入的文件路径必须是绝对路径，并且必须位于已配置的文档根目录内：

```text
导入 /Users/me/docs/api-spec.pdf。
```

再次导入同一路径会替换原有文本块。

### 搜索并读取更多上下文

```text
API 文档如何说明身份验证？
查找 ERR_CONNECTION_REFUSED 的文档说明。
```

搜索结果包含文本、来源路径、标题、文本块编号和相关度分数。需要更多上下文时，将结果中的 `chunkIndex` 以及 `filePath` 或 `source` 传给 `read_chunk_neighbors`：

```text
读取该身份验证结果前后的文本块。
```

`query_documents` 和 `list_files` 都接受可选的绝对 `scope` 路径前缀或前缀列表。前缀会匹配指定路径及其全部子路径。

### 导入 HTML

由 MCP 客户端获取网页后，再使用 `ingest_data`：

```text
获取 https://example.com/docs 并导入其中的 HTML。
```

服务器会提取正文、转换为 Markdown，并使用提供的来源标识符保存。再次使用同一来源会更新已有内容。

为外部内容建立索引时，请遵守来源网站的条款和版权规定。

### PDF 图像

视觉模式会为图像内容较多的 PDF 页面生成说明文字。该功能需要主动开启，常规导入不会加载视觉模型。

```text
使用 visual: true 导入 /Users/me/docs/research-paper.pdf。
```

```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual
```

| 模式 | 模型缓存 | 适用场景 |
|---|---:|---|
| `fast`（默认） | 约 250 MB | 轻量视觉索引 |
| `quality` | 约 2.9 GB | 包含标签、标注或其他图中文字的图像 |

通过 MCP 使用 `visualQuality: "quality"`，或通过 CLI 使用 `--visual-quality quality`，即可选择较大的模型。实测 CPU 推理耗时约为 `fast` 的两倍，但实际结果取决于硬件和模型更新。

生成的说明文字只是辅助文本，并非忠实的逐字转录。检索到的说明文字和文档文本都应视为不可信输入，而不是操作指令。

## CLI

CLI 无需 MCP 客户端，使用与服务器相同的解析器、嵌入器和向量存储：

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "身份验证 API"
npx mcp-local-rag query "身份验证" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

`--db-path`、`--cache-dir` 和 `--model-name` 等全局选项应放在子命令之前，子命令选项则放在子命令之后：

```bash
npx mcp-local-rag --db-path ./my-db query "身份验证"
```

运行 `npx mcp-local-rag --help` 可查看完整命令说明。

CLI 不读取 MCP 客户端配置。如果两个接口需要共用索引，请设置相同的环境变量或命令行参数。特别是共享同一数据库时，`MODEL_NAME` 必须与 CLI 的 `--model-name` 一致。

## 搜索调优

关键词加权默认开启。对于需要更严格筛选结果的语料库，还可以使用相关度间隔分组、距离过滤和文件数量限制。

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | 关键词加权系数（0.0–1.0）。0 表示禁用关键词重排，1 表示使用最大加权。 |
| `RAG_GROUPING` | 未设置 | `similar` 保留第一个相关度分组；`related` 最多保留两个分组，并以明显的向量距离间隔为边界。 |
| `RAG_MAX_DISTANCE` | 未设置 | 过滤相关度较低的结果（例如 `0.5`）。 |
| `RAG_MAX_FILES` | 未设置 | 将结果限制在排名最靠前的 N 个文件中（例如 `1` 表示只保留最佳文件）。 |

对于包含大量标识符的 API 规范及类似文档，提高关键词权重可以改善精确术语的排名：

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7"
}
```

- `0.7`：比默认值稍强的精确术语重排
- `1.0`：最大关键词加权

## 工作原理

导入时：

1. 解析器从输入格式中提取文本。
2. 语义分块器识别主题边界，并保持 Markdown 代码块完整。
3. Transformers.js 在本地生成嵌入向量。
4. LanceDB 保存文本块、元数据、向量和全文索引。

搜索时：

1. 使用同一模型为查询生成嵌入向量。
2. 向量搜索检索语义相关的文本块。
3. 配置后，可使用距离过滤和相关度分组进一步缩小候选范围。
4. 全文匹配会提高精确查询词的排名。

## Agent Skills

[Agent Skills](https://agentskills.io/) 为 AI 助手提供查询和导入指导：

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

安装的技能涵盖查询写法、结果优化和 HTML 导入。如果技能没有自动启用，请明确要求助手使用 mcp-local-rag 技能。

## 配置

MCP 服务器读取环境变量。CLI 支持相同的变量和下表所列的命令行参数；命令行参数优先级更高。

| 环境变量 | CLI 参数 | 默认值 | 说明 |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | 当前目录 | 一个文档根目录；`ingest`、`list` 和 `sync` 可重复使用该 CLI 参数 |
| `BASE_DIRS` | 不适用 | 未设置 | 文档根目录的 JSON 数组；优先于 `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | 向量数据库位置 |
| `CACHE_DIR` | `--cache-dir` | `./models/` | 模型缓存目录 |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Hugging Face 嵌入模型 |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600`（100 MB） | 最大文件大小（字节） |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | 文本块最小字符数（1–10000） |
| `RAG_DEVICE` | 不适用 | `cpu` | ONNX Runtime 执行设备 |
| `RAG_DTYPE` | 不适用 | `fp32` | 传给所选模型的嵌入数据类型 |

### 文档根目录（`BASE_DIR` 和 `BASE_DIRS`）

mcp-local-rag 只允许在已配置的根目录中执行文件操作。需要使用多个根目录时，`BASE_DIRS` 必须是由非空路径组成的 JSON 数组：

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

根目录配置按以下优先顺序解析：

1. CLI 的 `--base-dir <path>` 参数（可在 `ingest`、`list` 和 `sync` 中重复使用）
2. `BASE_DIRS`
3. `BASE_DIR`
4. 当前目录

每一级配置都会完全取代优先级更低的配置，而不是与其合并。无效的 `BASE_DIRS` 会直接报错，不会回退到 `BASE_DIR` 或当前目录。即使配置有误，MCP 中的 `status` 仍然可用，因此客户端可以报告具体问题。

```bash
npx mcp-local-rag ingest --base-dir /Users/me/work --base-dir /Users/me/specs /Users/me/work/readme.md
npx mcp-local-rag list --base-dir /Users/me/work --base-dir /Users/me/specs
npx mcp-local-rag sync --base-dir /Users/me/work --base-dir /Users/me/specs
BASE_DIRS='["/Users/me/work","/Users/me/specs"]' npx mcp-local-rag list
```

### 存储和模型

`DB_PATH` 和 `CACHE_DIR` 默认相对于进程的工作目录。如果 MCP 客户端可能从不同的项目目录启动服务器，请使用绝对路径。

设置 `MODEL_NAME` 或传入 `--model-name`，即可选择适合文档语言和领域的 Hugging Face 嵌入模型。

mcp-local-rag 使用平均池化和 L2 归一化生成嵌入。选择模型时，请确认这些设置是否符合该模型建议的推理方式，因为池化方式可能影响检索质量。

更改 `MODEL_NAME`、`RAG_DEVICE` 或 `RAG_DTYPE` 可能导致现有向量不兼容。更改嵌入配置后，请使用新的 `DB_PATH`，或者删除现有索引并重新导入。

适用于中文文档的模型示例：`Xenova/bge-small-zh-v1.5`。

## 安全与运行

- 文件访问仅限 `BASE_DIR`、`BASE_DIRS` 或 CLI 的 `--base-dir` 所指定的根目录。
- 指向所有已配置根目录之外的符号链接会被拒绝。
- 所需模型缓存完成后，文档处理和搜索不会再发起网络请求。
- 服务器面向单个本地用户设计，不提供身份验证或访问控制。
- 不要让多个 CLI 或 MCP 写入进程同时操作同一个 `DB_PATH`。同步进行时仍可执行只读查询。
- 没有写入进程运行时，可以复制 `DB_PATH` 目录来备份索引。

<details>
<summary><strong>故障排除</strong></summary>

### "No results found"

必须先导入文档。运行 `"列出所有已导入的文件"` 检查导入状态。

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

- [为 Agentic Coding 构建本地 RAG](https://www.norsica.jp/blog/local-rag-agentic-coding)：深入介绍语义分块与混合搜索的技术设计。

## 致谢

本项目基于 Anthropic 的 [Model Context Protocol](https://modelcontextprotocol.io/)、[LanceDB](https://lancedb.com/) 和 [Transformers.js](https://huggingface.co/docs/transformers.js) 构建。

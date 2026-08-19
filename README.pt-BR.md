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
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <strong>Português (Brasil)</strong> |
  <a href="README.fr.md">Français</a>
</p>

Pesquise documentos privados usando um cliente MCP ou o terminal sem enviá-los a uma API de embeddings.

O mcp-local-rag indexa arquivos PDF, DOCX, Markdown e texto no seu computador. A busca combina similaridade semântica e correspondência por palavras-chave. Assim, leva em conta tanto o sentido da consulta quanto termos técnicos exatos, como nomes de APIs, classes e códigos de erro.

## Recursos

- **Execução local:** O processamento dos documentos, os embeddings, o armazenamento e a busca acontecem no seu computador. Depois do primeiro download do modelo, a importação de texto e as buscas funcionam offline.
- **Busca híbrida:** A recuperação semântica encontra conceitos relacionados, enquanto a correspondência por palavras-chave dá mais peso a termos técnicos exatos.
- **Embeddings configuráveis:** Escolha um modelo de embeddings do Hugging Face adequado ao idioma e à área dos seus documentos.
- **Divisão semântica:** Os documentos são divididos nas mudanças de assunto, não por uma quantidade fixa de caracteres. Blocos de código Markdown permanecem intactos.
- **MCP e CLI:** Use o mesmo índice em uma ferramenta de programação com IA ou diretamente no terminal.

Não é necessário ter chave de API, Docker, Python nem banco de dados externo.

## Início rápido

### Requisitos

- Node.js 22 ou mais recente
- Acesso à internet no primeiro uso para baixar o pacote npm e o modelo de embeddings
- Um diretório com os documentos que você quer pesquisar

Defina `BASE_DIR` com o caminho desse diretório. Ele também funciona como limite de segurança para as operações com arquivos. Substitua `/absolute/path/to/your/documents` nos exemplos pelo caminho absoluto do diretório.

O mcp-local-rag usa o protocolo MCP padrão por meio de um servidor stdio local. Assim, ele funciona com ferramentas de programação com IA e outros hosts MCP compatíveis com servidores MCP locais.

Use um dos exemplos abaixo ou registre `npx -y mcp-local-rag` e defina `BASE_DIR` no formato de configuração MCP do seu cliente.

**Claude Code:** Execute este comando:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

**Codex:** Adicione a `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

**OpenCode:** Adicione a `~/.config/opencode/opencode.json` (ou `opencode.jsonc`):

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

**Cursor:** Adicione a `~/.cursor/mcp.json`:

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

Reinicie o cliente e peça para ele criar o índice:

```text
Sincronize todos os documentos do diretório raiz configurado e aguarde a conclusão.
```

A primeira sincronização baixa o modelo de embeddings padrão (cerca de 90 MB). O início da importação pode levar de 1 a 2 minutos. Nas próximas execuções, o cache local será usado.

Quando a sincronização terminar, faça uma pergunta:

```text
O que a documentação da API diz sobre autenticação?
```

### Início rápido pela CLI

Para usar a CLI sem um cliente MCP:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "API de autenticação"
```

Por padrão, a CLI usa o diretório atual como raiz dos documentos. Execute os dois comandos no mesmo diretório para que usem o mesmo índice padrão ou defina `BASE_DIR` e `DB_PATH` explicitamente.

## Por que este projeto existe

Alguns conjuntos de documentos não podem ser enviados a um serviço de embeddings hospedado devido a requisitos de confidencialidade ou políticas da organização. Mantendo o índice local, esses documentos continuam pesquisáveis sem gerar custo de API por consulta.

Uma busca puramente semântica pode ignorar identificadores exatos que são importantes na documentação técnica. O reordenamento por palavras-chave mantém esses termos visíveis sem abrir mão das consultas em linguagem natural.

## Conteúdo compatível

| Entrada | Como importar |
|---|---|
| PDF, DOCX, TXT, Markdown | Importação de arquivo ou sincronização de diretório |
| HTML já obtido pelo cliente | `ingest_data`; limpo com Readability e convertido para Markdown |
| Texto simples ou Markdown em memória | `ingest_data` com um identificador de origem estável |

O servidor não busca HTML por conta própria. Um cliente MCP pode obter uma página e enviar o HTML para `ingest_data`.

A importação de arquivos não aceita Excel, PowerPoint, imagens avulsas nem extensões de código-fonte. Opcionalmente, arquivos PDF podem usar um modelo visual local para descrever figuras, mas esse recurso não é OCR nem busca de imagens.

## Ferramentas MCP

| Ferramenta | Finalidade |
|---|---|
| `sync_start` | Sincronizar o índice com todos os diretórios raiz configurados ou com um caminho |
| `sync_status` | Consultar uma sincronização em andamento |
| `ingest_file` | Importar ou substituir um arquivo |
| `ingest_data` | Importar texto, Markdown ou HTML que já esteja disponível no cliente |
| `query_documents` | Pesquisar com correspondência semântica e reforço por palavras-chave |
| `read_chunk_neighbors` | Ler os fragmentos próximos a um resultado de busca |
| `list_files` | Mostrar os arquivos compatíveis e o estado de importação |
| `delete_file` | Excluir um arquivo indexado ou um item de `ingest_data` |
| `status` | Mostrar o estado do índice e da busca |

### Sincronizar um diretório raiz

`sync_start` importa arquivos novos e alterados, ignora os que são idênticos byte a byte e remove do índice os arquivos que deixaram de existir:

```text
Sincronize todo o conteúdo dos diretórios raiz configurados e aguarde a conclusão.
```

A ferramenta retorna um `jobId` imediatamente. O cliente deve consultar `sync_status` até o estado mudar para `succeeded` ou `failed`. Não há modo visual durante a sincronização; arquivos PDF alterados são importados como texto.

O processo do servidor mantém apenas o registro de um job de sincronização. Um novo job substitui o registro de outro já concluído, e o registro é descartado quando o servidor reinicia.

### Importar um arquivo

`ingest_file` aceita PDF, DOCX, TXT e Markdown. Os caminhos enviados via MCP devem ser absolutos e permanecer dentro de um diretório raiz configurado:

```text
Importe o documento /Users/me/docs/api-spec.pdf.
```

Importar novamente o mesmo caminho substitui os fragmentos existentes.

### Pesquisar e ler mais contexto

```text
O que a documentação da API diz sobre autenticação?
Encontre o comportamento documentado de ERR_CONNECTION_REFUSED.
```

Os resultados contêm o texto, o caminho de origem, o título, o índice do fragmento e a pontuação de relevância. Se precisar de mais contexto, envie a `read_chunk_neighbors` o `chunkIndex` e o `filePath` ou `source` do resultado:

```text
Leia os fragmentos próximos a esse resultado sobre autenticação.
```

Tanto `query_documents` quanto `list_files` aceitam um prefixo de caminho absoluto opcional em `scope`, ou uma lista de prefixos. Cada prefixo corresponde ao caminho exato e a todos os caminhos abaixo dele.

### Importar HTML

Use `ingest_data` depois que o cliente MCP buscar a página:

```text
Busque https://example.com/docs e importe o HTML.
```

O servidor extrai o artigo principal, converte o conteúdo para Markdown e o armazena com o identificador de origem fornecido. Reutilizar a mesma origem atualiza o conteúdo existente.

Respeite os termos e os direitos autorais do site de origem ao indexar conteúdo externo.

### Figuras em PDF

O modo visual adiciona uma descrição gerada às páginas de PDF com muitas figuras. Ele é opcional e não carrega um modelo visual durante a importação normal.

```text
Importe /Users/me/docs/research-paper.pdf com visual: true.
```

```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual
```

| Perfil | Cache do modelo | Indicação |
|---|---:|---|
| `fast` (padrão) | cerca de 250 MB | Indexação visual leve |
| `quality` | cerca de 2,9 GB | Figuras com rótulos, anotações ou outros textos dentro da imagem |

Selecione o modelo maior com `visualQuality: "quality"` via MCP ou com `--visual-quality quality` pela CLI. Em testes com CPU, a inferência levou cerca do dobro do tempo de `fast`, mas o resultado depende do hardware e das atualizações do modelo.

As descrições são textos auxiliares, não transcrições fiéis. Trate as descrições e o texto recuperado dos documentos como entradas não confiáveis, não como instruções.

## CLI

A CLI usa o mesmo analisador, gerador de embeddings e banco vetorial sem precisar de um cliente MCP:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "API de autenticação"
npx mcp-local-rag query "autenticação" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

Opções globais, como `--db-path`, `--cache-dir` e `--model-name`, vêm antes do subcomando. As opções próprias do subcomando vêm depois:

```bash
npx mcp-local-rag --db-path ./my-db query "autenticação"
```

Execute `npx mcp-local-rag --help` para consultar a referência completa dos comandos.

A CLI não lê a configuração do cliente MCP. Defina as mesmas variáveis de ambiente ou opções se as duas interfaces precisarem compartilhar um índice. Em particular, `MODEL_NAME` e a opção `--model-name` da CLI devem ser iguais quando usam o mesmo banco de dados.

## Ajuste da busca

O reforço por palavras-chave é ativado por padrão. Para acervos que exigem uma seleção mais restrita, também é possível configurar o agrupamento por saltos de relevância e os filtros de distância e de arquivos.

| Variável | Padrão | Descrição |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Fator de reforço por palavras-chave (0.0–1.0). 0 desativa o reordenamento por palavras-chave e 1 aplica o reforço máximo. |
| `RAG_GROUPING` | não definido | `similar` mantém o primeiro grupo de relevância; `related` mantém até dois e usa saltos relevantes na distância vetorial como limites. |
| `RAG_MAX_DISTANCE` | não definido | Descarta resultados pouco relevantes, por exemplo, com `0.5`. |
| `RAG_MAX_FILES` | não definido | Limita os resultados aos N arquivos mais bem classificados, por exemplo, `1` para apenas o melhor arquivo. |

Em especificações de API e outros documentos com muitos identificadores, um peso maior para palavras-chave pode melhorar a classificação de termos exatos:

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7"
}
```

- `0.7`: reordenamento de termos exatos um pouco mais forte que o padrão
- `1.0`: reforço máximo por palavras-chave

## Como funciona

Durante a importação:

1. O analisador extrai o texto do formato de entrada.
2. O divisor semântico encontra as mudanças de assunto e preserva os blocos de código Markdown.
3. O Transformers.js cria os embeddings localmente.
4. O LanceDB armazena os fragmentos, metadados, vetores e o índice de texto completo.

Durante a busca:

1. A consulta é convertida em embedding pelo mesmo modelo.
2. A busca vetorial recupera fragmentos relacionados pelo significado.
3. Quando configurados, os filtros opcionais de distância e os grupos de relevância reduzem os candidatos.
4. As correspondências de texto completo reforçam os termos exatos da consulta.

## Agent Skills

As [Agent Skills](https://agentskills.io/) orientam assistentes de IA na formulação de consultas e na importação de conteúdo:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

As skills instaladas cobrem formulação de consultas, refinamento de resultados e importação de HTML. Se uma skill não for ativada automaticamente, peça ao assistente para usar a skill mcp-local-rag de forma explícita.

## Configuração

O servidor MCP lê variáveis de ambiente. A CLI aceita as mesmas variáveis e as opções listadas na tabela; as opções da CLI têm prioridade.

| Variável de ambiente | Opção da CLI | Padrão | Descrição |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Diretório atual | Um diretório raiz; a opção da CLI pode ser repetida em `ingest`, `list` e `sync` |
| `BASE_DIRS` | N/D | não definido | Array JSON de diretórios raiz; tem prioridade sobre `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Local do banco de dados vetorial |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Diretório de cache dos modelos |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Modelo de embeddings do Hugging Face |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100 MB) | Tamanho máximo do arquivo em bytes |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Tamanho mínimo de um fragmento em caracteres (1–10000) |
| `RAG_DEVICE` | N/D | `cpu` | Dispositivo de execução do ONNX Runtime |
| `RAG_DTYPE` | N/D | `fp32` | Tipo de dados dos embeddings enviado ao modelo selecionado |

### Diretórios raiz (`BASE_DIR` e `BASE_DIRS`)

O mcp-local-rag só permite operações com arquivos dentro dos diretórios raiz configurados. Para usar vários diretórios, `BASE_DIRS` deve ser um array JSON de caminhos não vazios:

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

A configuração é resolvida nesta ordem:

1. Opções `--base-dir <path>` da CLI (podem ser repetidas em `ingest`, `list` e `sync`)
2. `BASE_DIRS`
3. `BASE_DIR`
4. Diretório atual

Cada origem substitui a de menor prioridade, em vez de ser combinada com ela. Uma configuração inválida de `BASE_DIRS` produz um erro, sem recorrer a `BASE_DIR` ou ao diretório atual. `status` continua disponível no MCP para que o cliente possa informar o erro de configuração.

```bash
npx mcp-local-rag ingest --base-dir /Users/me/work --base-dir /Users/me/specs /Users/me/work/readme.md
npx mcp-local-rag list --base-dir /Users/me/work --base-dir /Users/me/specs
npx mcp-local-rag sync --base-dir /Users/me/work --base-dir /Users/me/specs
BASE_DIRS='["/Users/me/work","/Users/me/specs"]' npx mcp-local-rag list
```

### Armazenamento e modelos

Por padrão, `DB_PATH` e `CACHE_DIR` são relativos ao diretório de trabalho do processo. Use caminhos absolutos se o cliente MCP puder iniciar o servidor a partir de diretórios de projeto diferentes.

Defina `MODEL_NAME` ou passe `--model-name` para escolher um modelo de embeddings do Hugging Face adequado ao idioma e à área dos seus documentos.

O mcp-local-rag gera embeddings com mean pooling e normalização L2. Ao escolher um modelo, verifique se essas configurações correspondem à configuração de inferência recomendada para esse modelo, pois o tipo de pooling pode afetar a qualidade da busca.

Alterar `MODEL_NAME`, `RAG_DEVICE` ou `RAG_DTYPE` pode deixar os vetores existentes incompatíveis. Depois de mudar a configuração dos embeddings, use um novo `DB_PATH` ou exclua o índice existente e importe os documentos novamente.

Um exemplo de modelo disponível para documentos em português é `Xenova/paraphrase-multilingual-MiniLM-L12-v2`.

## Segurança e operação

- O acesso a arquivos fica restrito aos diretórios raiz definidos em `BASE_DIR`, `BASE_DIRS` ou pela opção `--base-dir` da CLI.
- Links simbólicos que apontam para fora de todos os diretórios raiz configurados são rejeitados.
- O processamento dos documentos e as buscas não fazem solicitações de rede depois que os modelos necessários estão no cache.
- O servidor foi projetado para um único usuário local e não oferece autenticação nem controle de acesso.
- Não execute vários processos de escrita da CLI ou do MCP no mesmo `DB_PATH`. Consultas somente leitura podem ser executadas durante uma sincronização.
- Para fazer backup do índice, copie o diretório `DB_PATH` enquanto não houver nenhum processo de escrita ativo.

<details>
<summary><strong>Solução de problemas</strong></summary>

### "No results found"

Os documentos precisam ser importados primeiro. Execute `"Liste todos os arquivos importados"` para verificar.

### Falha no download do modelo

Verifique a conexão com a internet. Se estiver usando um proxy, revise as configurações de rede. O modelo também pode ser [baixado manualmente](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

O limite padrão é 100 MB. Divida o arquivo ou aumente `MAX_FILE_SIZE`.

### Consultas lentas

Verifique a quantidade de fragmentos com `status`. Documentos grandes, com muitos fragmentos, podem deixar as consultas mais lentas. Considere dividir arquivos muito grandes.

### "Path outside BASE_DIR"

O caminho precisa estar dentro de um dos diretórios raiz configurados: `BASE_DIR`, uma entrada de `BASE_DIRS` ou um caminho definido por `--base-dir` na CLI. Use um caminho absoluto.

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` aceita um array JSON com um ou mais caminhos não vazios:

- Válido: `BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- Inválido: `BASE_DIRS=/a:/b` (a sintaxe com separadores não é aceita)
- Inválido: `BASE_DIRS='[]'` (array vazio)

### O cliente MCP não mostra as ferramentas

1. Verifique a sintaxe do arquivo de configuração
2. Feche o cliente por completo e abra novamente (Cmd+Q no Mac para o Cursor)
3. Teste diretamente: `npx mcp-local-rag` deve iniciar sem erros

</details>

## Como contribuir

Contribuições são bem-vindas. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para preparar o ambiente e conferir as orientações.

## Licença

Licença MIT. Uso gratuito para fins pessoais e comerciais.

## Artigos do blog

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding): análise técnica do design da divisão semântica e da busca híbrida.

## Agradecimentos

Desenvolvido com o [Model Context Protocol](https://modelcontextprotocol.io/) da Anthropic, o [LanceDB](https://lancedb.com/) e o [Transformers.js](https://huggingface.co/docs/transformers.js).

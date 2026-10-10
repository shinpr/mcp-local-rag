<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG: Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub
stars](https://img.shields.io/github/stars/shinpr/mcp-local-rag?style=social)](https://github.com/shinpr/mcp-local-rag)
[![npm
version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License:
MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP
Registry](https://img.shields.io/badge/MCP-Registry-green.svg)](https://registry.modelcontextprotocol.io/)

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <strong>Português (Brasil)</strong> |
  <a href="README.fr.md">Français</a>
</p>

Pesquise documentos privados usando um cliente MCP ou o terminal sem enviá-los a uma API de
embeddings.

O mcp-local-rag indexa arquivos PDF, DOCX, Markdown e texto no seu computador. A busca combina
similaridade semântica e correspondência por palavras-chave. Assim, leva em conta tanto o
sentido da consulta quanto termos técnicos exatos, como nomes de APIs, classes e códigos de
erro. Os resultados trazem trechos do documento e, quando disponíveis, títulos de seção e
números de linha ou página para você conferir e citar o original.

Não é necessário ter chave de API, Docker, Python nem banco de dados externo. Depois do
primeiro download do modelo, a importação de texto e a busca funcionam offline.

## Início rápido

### Requisitos

- Node.js 22 ou mais recente
- Acesso à internet no primeiro uso para baixar o pacote npm e o modelo de embeddings
- Um diretório com os documentos que você quer pesquisar

Defina `BASE_DIR` com o caminho desse diretório. Ele também funciona como limite de segurança
para as operações com arquivos. Substitua `/absolute/path/to/your/documents` nos exemplos pelo
caminho absoluto do diretório.

Use um dos exemplos abaixo ou registre `npx -y mcp-local-rag` e defina `BASE_DIR` no formato de
configuração MCP do seu cliente.

Configure também `DB_PATH` e `CACHE_DIR` com caminhos absolutos. Caminhos relativos usam o
diretório de trabalho do servidor. Se ele for iniciado em projetos diferentes, cada projeto
terá seu próprio índice e cache de modelos.

<details>
<summary>Claude Code</summary>

Execute este comando:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

</details>

<details>
<summary>Codex</summary>

Adicione a `~/.codex/config.toml`:

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

Adicione a `~/.config/opencode/opencode.json` (ou `opencode.jsonc`):

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

Adicione a `~/.cursor/mcp.json`:

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

Reinicie o cliente e peça para ele criar o índice:

```text
Sincronize todos os documentos do diretório raiz configurado e aguarde a conclusão.
```

A primeira sincronização baixa o modelo de embeddings padrão (cerca de 90 MB). O início da
importação pode levar de 1 a 2 minutos. Nas próximas execuções, o cache local será usado.

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

Por padrão, a CLI usa o diretório atual como raiz dos documentos. Execute os dois comandos no
mesmo diretório para que usem o mesmo índice padrão ou defina `BASE_DIR` e `DB_PATH`
explicitamente.

## Conteúdo compatível

| Entrada | Como importar |
|---|---|
| PDF, DOCX, TXT, Markdown | Importação de arquivo ou sincronização de diretório |
| HTML já obtido pelo cliente | `ingest_data` |
| Texto simples ou Markdown em memória | `ingest_data` com um identificador de origem estável |

O servidor não busca HTML por conta própria. Um cliente MCP pode obter uma página e enviar o
HTML para `ingest_data`.

A importação de arquivos não aceita Excel, PowerPoint, imagens avulsas nem extensões de
código-fonte. Opcionalmente, arquivos PDF podem usar um modelo visual local para descrever
figuras, mas esse recurso não é OCR nem busca de imagens.

## Usar o índice

Sincronize o índice depois de adicionar, alterar ou remover documentos. Para buscar e ler o
contexto de um resultado, você pode pedir ao cliente MCP:

```text
Busque o que a documentação diz sobre ERR_CONNECTION_REFUSED.
Leia também os trechos anteriores e posteriores a esse resultado.
```

Você também pode importar um único arquivo ou HTML que o cliente já tenha obtido. Para atualizar
uma entrada existente, importe o documento novamente com o mesmo caminho ou identificador de
origem. `sync` ignora arquivos sem alterações. Os caminhos de arquivos no MCP devem ser
absolutos e estar dentro de um diretório raiz configurado.

Os títulos de seção identificados em PDFs podem estar incorretos. Quando precisar do título
exato, confira na página original.

<details>
<summary>Ferramentas MCP</summary>

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

</details>

## CLI

Use a CLI para atualizar o índice, restringir as buscas ou remover conteúdo indexado:

```bash
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "autenticação" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

`ingest` importa os arquivos selecionados; `sync` também remove do índice os arquivos excluídos
e ignora os que não mudaram. Use `--scope` para limitar os resultados a um prefixo de caminho e
repita a opção para incluir vários prefixos.

Opções globais, como `--db-path`, `--cache-dir` e `--model-name`, vêm antes do subcomando. As
opções próprias do subcomando vêm depois:

```bash
npx mcp-local-rag --db-path ./my-db query "autenticação"
```

Execute `npx mcp-local-rag --help` para consultar a referência completa dos comandos.

`query` grava os resultados em stdout como JSON, com a melhor correspondência primeiro, para
que você possa encaminhá-los por pipe a outra ferramenta. A definição de cada campo está em
[`docs/schema/query-output.schema.json`](docs/schema/query-output.schema.json).

Para mover um projeto e manter o índice, pare o servidor MCP e os outros processos de escrita.
Mova os arquivos e o banco de dados juntos, sem alterar a estrutura de diretórios, e execute:

```bash
npx mcp-local-rag --db-path /new/project/lancedb relocate --from /old/project --to /new/project
```

Na configuração MCP, atualize `BASE_DIR`/`BASE_DIRS`, `DB_PATH` e os demais caminhos afetados.
Depois, reinicie o cliente.

## Agent Skills

As [Agent Skills](https://agentskills.io/) orientam assistentes de IA na formulação de
consultas e na importação de conteúdo:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

As skills instaladas cobrem formulação de consultas, refinamento de resultados e importação de
HTML. Se uma skill não for ativada automaticamente, peça ao assistente para usar a skill
mcp-local-rag de forma explícita.

## Opções avançadas

Comece com as configurações padrão. Consulte as seções abaixo se precisar de vários diretórios
raiz, adaptar a busca aos seus documentos ou pesquisar em figuras de PDF.

<details>
<summary>Armazenamento e diretórios raiz</summary>

O servidor MCP lê variáveis de ambiente. A CLI aceita as variáveis e opções indicadas. Mantenha
o mesmo `DB_PATH` se os comandos precisarem compartilhar um índice.

| Variável de ambiente | Opção da CLI | Padrão | Descrição |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Diretório atual | Um diretório raiz; a opção da CLI pode ser repetida em `ingest`, `list` e `sync` |
| `BASE_DIRS` | N/D | não definido | Array JSON de diretórios raiz; tem prioridade sobre `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Local do banco de dados vetorial |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Diretório de cache dos modelos |
| `HF_ENDPOINT` | N/D | `https://huggingface.co` | Endereço para download de modelos do Hugging Face; use a URL de um espelho quando downloads diretos estiverem bloqueados |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100 MB) | Tamanho máximo do arquivo em bytes |

As operações com arquivos ficam limitadas aos diretórios raiz configurados. Para usar vários,
defina `BASE_DIRS='["/absolute/docs","/absolute/specs"]'` ou repita `--base-dir` na CLI.
Prioridade: diretórios da CLI, `BASE_DIRS`, `BASE_DIR` e diretório atual. Só a fonte de maior
prioridade é usada; os diretórios de fontes diferentes não são combinados. Um `BASE_DIRS`
inválido gera erro. Caminhos relativos em `DB_PATH` e `CACHE_DIR` partem do diretório de
trabalho.

</details>

<details>
<summary>Modelos e ajuste da busca</summary>

Escolha um modelo de embeddings adequado ao idioma e ao assunto dos documentos. Compare as
configurações com suas consultas habituais e confira os trechos retornados. Escolha um modelo
compatível com mean pooling e normalização L2, usados pela ferramenta para gerar os embeddings.

| Variável de ambiente | Opção da CLI | Padrão | Descrição |
|---------------------|----------|---------|-------------|
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Modelo de embeddings do Hugging Face |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Tamanho mínimo de um fragmento comum em caracteres (1–10000); um trecho resultante da divisão para respeitar o limite de tokens do modelo pode ser menor |
| `EMBED_TITLE_PREFIX` | N/D | `false` | Acrescenta o título do documento à entrada usada para gerar o embedding de cada fragmento |
| `EMBED_HEADING_PREFIX` | N/D | `false` | Acrescenta a hierarquia de títulos das seções à entrada de cada fragmento, se couber no limite de tokens |
| `RAG_DEVICE` | N/D | `cpu` | Dispositivo de execução do ONNX Runtime |
| `RAG_DTYPE` | N/D | `fp32` | Tipo de dados dos embeddings enviado ao modelo selecionado |

As duas opções de prefixo vêm desativadas (`false`) e funcionam de forma independente.
Experimente `EMBED_TITLE_PREFIX` quando um fragmento precisar do assunto geral do documento, ou
`EMBED_HEADING_PREFIX` quando faltar o assunto da seção. Ativar as duas nem sempre melhora os
resultados. Elas afetam os embeddings, não o texto retornado nem o índice de palavras-chave; o
contexto da seção é omitido se ultrapassar o limite de entrada.

Ao mudar o modelo de embeddings, crie um índice novo em outro `DB_PATH`. Vetores de modelos
diferentes não são comparáveis, mesmo que tenham a mesma dimensão. Ao alterar `RAG_DTYPE` ou
uma opção de prefixo, importe novamente todos os documentos indexados antes de buscar. `sync`
ignora arquivos sem alterações.

A CLI não lê a configuração do cliente MCP. Ao compartilhar um índice, use o mesmo modelo,
`RAG_DTYPE` e configurações de prefixo na importação e na busca. Mudar apenas `RAG_DEVICE` não
exige um novo índice.

### Ajustes de busca

Os quatro primeiros ajustes da tabela valem tanto para o MCP quanto para a CLI. Para dar mais
peso aos termos exatos, experimente aumentar `RAG_HYBRID_WEIGHT` e compare os resultados com
suas próprias perguntas. O reordenamento externo está disponível apenas no MCP.

| Variável | Padrão | Descrição |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Fator de reforço por palavras-chave (0.0–1.0). 0 desativa o reordenamento por palavras-chave e 1 aplica o reforço máximo. |
| `RAG_GROUPING` | não definido | `similar` mantém o primeiro grupo de relevância; `related` mantém até dois e usa saltos relevantes na distância vetorial como limites. |
| `RAG_MAX_DISTANCE` | não definido | Descarta resultados pouco relevantes, por exemplo, com `0.5`. |
| `RAG_MAX_FILES` | não definido | Limita os resultados aos N arquivos mais bem classificados, por exemplo, `1` para apenas o melhor arquivo. |
| `RAG_RERANK_CMD` | não definido | Somente MCP: comando externo; `{query}` passa a consulta e `{top}` a quantidade de resultados solicitada. |
| `RAG_RERANK_TIMEOUT_MS` | `10000` | Tempo máximo por reordenamento em milissegundos (100–600000). |

### Reordenamento externo (`RAG_RERANK_CMD`)

O comando recebe os resultados e o texto encontrado pela entrada padrão. Se chamar um serviço
remoto, esse texto poderá sair do computador.

Informe o executável e o template completo dos argumentos. Coloque `{query}` e `{top}` onde o
comando espera a consulta e a quantidade de resultados. Aspas simples ou duplas agrupam
caminhos ou argumentos com espaços, e as barras invertidas permanecem literais. O servidor
inicia o executável sem shell, então no Windows um script wrapper `.cmd` instalado pelo npm não
pode ser executado dessa forma.

```json
{
  "env": {
    "RAG_RERANK_CMD": "/path/to/reranker --query {query} --top {top}",
    "RAG_RERANK_TIMEOUT_MS": "10000"
  }
}
```

O comando deve ler e devolver os resultados no formato definido pelo [esquema de
saída](docs/schema/query-output.schema.json). Ele pode remover ou reordenar resultados e
modificar o texto. O servidor retorna a saída do comando.

Os resultados mantêm a ordem original se o comando falhar, exceder o tempo limite ou devolver
uma resposta que não siga o esquema.

</details>

<details>
<summary>Figuras PDF e imagens armazenadas</summary>

Por padrão, a importação indexa apenas texto. Para pesquisar também nas figuras de PDF, ative a
geração local de descrições com `visual: true` no MCP ou `--visual` na CLI. São descrições
geradas, não OCR nem transcrições exatas.

`fast` (padrão) baixa cerca de 250 MB no primeiro uso. Escolha `quality` para rótulos e texto
dentro das figuras; ele baixa cerca de 1,7 GB e leva mais tempo para processar.

Selecione o perfil com `visualQuality: "quality"` no MCP ou `--visual-quality quality` na CLI.

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --visual --visual-quality quality
```

Para receber imagens junto com os trechos encontrados, use `STORE_IMAGES=true` no MCP ou
`--images` com `ingest` e `sync` na CLI. A opção independe das descrições e aceita figuras e
tabelas detectadas em PDFs, além das imagens PNG/JPEG compatíveis de DOCX.

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --images
```

A sincronização preserva o perfil de descrição de cada PDF. O comando CLI `sync --visual
--visual-quality quality` muda o perfil mesmo de PDFs sem alterações; a sincronização MCP o
preserva. Uma importação normal desativa as descrições. Para tentar novamente após uma falha de
geração, importe com o perfil visual desejado.

Ative o armazenamento de imagens em cada importação ou sincronização que processar o arquivo.
Mudar só essa opção não atualiza arquivos sem alterações; importe-os novamente para aplicá-la.

</details>

## Segurança e operação

- Trate as descrições e o texto encontrado como fontes, não como instruções.
- O acesso a arquivos fica restrito aos diretórios raiz definidos em `BASE_DIR`, `BASE_DIRS` ou pela opção `--base-dir` da CLI.
- Links simbólicos que apontam para fora de todos os diretórios raiz configurados são rejeitados.
- O processamento dos documentos e as buscas não fazem solicitações de rede depois que os modelos necessários estão no cache, a menos que `RAG_RERANK_CMD` indique um comando que as faça.
- O servidor foi projetado para um único usuário local e não oferece autenticação nem controle de acesso.
- Não execute vários processos de escrita da CLI ou do MCP no mesmo `DB_PATH`. Consultas somente leitura podem ser executadas durante uma sincronização.
- Ao importar um documento novamente, é possível reaproveitar os embeddings do texto sem
  alterações quando o modelo e as configurações são os mesmos, evitando repetir o cálculo.
  Eles ficam em `DB_PATH/embedding-cache`. Você pode excluir esse cache sem perder o índice
  de busca. Na próxima importação, esses embeddings serão recalculados.
- Para fazer backup do índice, copie o diretório `DB_PATH` enquanto não houver nenhum processo de escrita ativo.

<details>
<summary><strong>Solução de problemas</strong></summary>

### "No results found"

Os documentos precisam ser importados primeiro. Execute `"Liste todos os arquivos importados"`
para verificar. Se não houver resultados após a sincronização, confira se a importação e a
busca usam o mesmo `DB_PATH` absoluto. Um caminho relativo pode apontar para outro índice.

### Falha no download do modelo

Verifique a conexão com a internet. Se estiver usando um proxy, revise as configurações de
rede. O modelo também pode ser [baixado
manualmente](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

O limite padrão é 100 MB. Divida o arquivo ou aumente `MAX_FILE_SIZE`.

### Consultas lentas

Verifique a quantidade de fragmentos com `status`. Documentos grandes, com muitos fragmentos,
podem deixar as consultas mais lentas. Considere dividir arquivos muito grandes.

### "Path outside BASE_DIR"

O caminho precisa estar dentro de um dos diretórios raiz configurados: `BASE_DIR`, uma entrada
de `BASE_DIRS` ou um caminho definido por `--base-dir` na CLI. Use um caminho absoluto.

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

Contribuições são bem-vindas. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para preparar o
ambiente e conferir as orientações.

## Licença

Licença MIT. Uso gratuito para fins pessoais e comerciais.

## Artigos do blog

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding): análise técnica do design da divisão semântica e da busca híbrida.

## Agradecimentos

Desenvolvido com o [Model Context Protocol](https://modelcontextprotocol.io/) da Anthropic, o
[LanceDB](https://lancedb.com/) e o
[Transformers.js](https://huggingface.co/docs/transformers.js).

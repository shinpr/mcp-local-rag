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
  <strong>Español</strong> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.fr.md">Français</a>
</p>

Busca en documentos privados desde un cliente MCP o desde la terminal sin enviarlos a una API de embeddings.

mcp-local-rag indexa archivos PDF, DOCX y Markdown, además de archivos de texto, en tu equipo. La búsqueda combina similitud semántica y coincidencia de palabras clave. Así tiene en cuenta tanto el sentido de la consulta como los términos técnicos exactos, por ejemplo nombres de API, clases y códigos de error.

## Funciones

- **Ejecución local:** El análisis de documentos, los embeddings, el almacenamiento y la búsqueda se realizan en tu equipo. Después de descargar el modelo por primera vez, la incorporación de texto y las búsquedas funcionan sin conexión.
- **Búsqueda híbrida:** La recuperación semántica encuentra conceptos relacionados y la coincidencia de palabras clave da más peso a los términos técnicos exactos.
- **Embeddings configurables:** Puedes elegir un modelo de embeddings de Hugging Face adecuado para el idioma y el ámbito de tus documentos.
- **Segmentación semántica:** Los documentos se dividen cuando cambia el tema, no cada cierto número de caracteres. Los bloques de código Markdown se mantienen intactos.
- **MCP y CLI:** Usa el mismo índice desde una herramienta de programación con IA o directamente desde la terminal.

No hace falta una clave de API, Docker, Python ni una base de datos externa.

## Inicio rápido

### Requisitos

- Node.js 22 o posterior
- Acceso a Internet durante el primer uso para descargar el paquete npm y el modelo de embeddings
- Un directorio con los documentos que quieras consultar

Asigna ese directorio a `BASE_DIR`. También será el límite de seguridad para las operaciones con archivos. Sustituye `/absolute/path/to/your/documents` en los ejemplos por la ruta absoluta del directorio.

mcp-local-rag usa el protocolo MCP estándar mediante un servidor stdio local. Por eso funciona con herramientas de programación con IA y otros hosts MCP que admitan servidores MCP locales.

Usa uno de los ejemplos siguientes o registra `npx -y mcp-local-rag` y configura `BASE_DIR` con el formato de configuración MCP de tu cliente.

**Claude Code:** Ejecuta este comando:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

**Codex:** Añade lo siguiente a `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

**OpenCode:** Añade lo siguiente a `~/.config/opencode/opencode.json` (o `opencode.jsonc`):

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

**Cursor:** Añade lo siguiente a `~/.cursor/mcp.json`:

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

Reinicia el cliente y pídele que construya el índice:

```text
Sincroniza todos los documentos del directorio raíz configurado y espera a que termine.
```

La primera sincronización descarga el modelo de embeddings predeterminado (unos 90 MB). Pueden pasar entre 1 y 2 minutos antes de que comience la incorporación. Las ejecuciones posteriores usan la caché local.

Cuando termine la sincronización, prueba con una consulta:

```text
¿Qué dice la documentación de la API sobre la autenticación?
```

### Inicio rápido con la CLI

Para usar la CLI sin un cliente MCP:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "API de autenticación"
```

La CLI usa el directorio actual como raíz de documentos de forma predeterminada. Ejecuta ambos comandos desde el mismo directorio para que compartan el índice predeterminado, o configura `BASE_DIR` y `DB_PATH` de forma explícita.

## Por qué existe

Algunos conjuntos de documentos no se pueden enviar a un servicio de embeddings alojado por motivos de confidencialidad o por las políticas de una organización. Un índice local permite consultarlos sin añadir un coste de API por búsqueda.

Una búsqueda puramente semántica puede pasar por alto identificadores exactos que son importantes en la documentación técnica. El reajuste por palabras clave mantiene visibles esos términos sin renunciar a las consultas en lenguaje natural.

## Contenido compatible

| Entrada | Cómo incorporarla |
|---|---|
| PDF, DOCX, TXT, Markdown | Incorporación de archivos o sincronización de directorios |
| HTML ya obtenido por el cliente | `ingest_data`; se limpia con Readability y se convierte a Markdown |
| Texto sin formato o Markdown en memoria | `ingest_data` con un identificador de origen estable |

El servidor no descarga páginas HTML. Un cliente MCP puede obtener una página y pasar su HTML a `ingest_data`.

La incorporación de archivos no admite Excel, PowerPoint, imágenes independientes ni extensiones de código fuente. De forma opcional, los PDF pueden usar un modelo visual local para describir figuras, pero esta función no es OCR ni búsqueda de imágenes.

## Herramientas MCP

| Herramienta | Función |
|---|---|
| `sync_start` | Sincronizar el índice con todos los directorios raíz configurados o con una ruta |
| `sync_status` | Consultar una sincronización en curso |
| `ingest_file` | Incorporar o sustituir un archivo |
| `ingest_data` | Incorporar texto, Markdown o HTML que ya esté disponible en el cliente |
| `query_documents` | Buscar mediante coincidencia semántica y refuerzo de palabras clave |
| `read_chunk_neighbors` | Leer los segmentos contiguos a un resultado de búsqueda |
| `list_files` | Mostrar los archivos compatibles y su estado de incorporación |
| `delete_file` | Eliminar un archivo indexado o un elemento de `ingest_data` |
| `status` | Mostrar el estado del índice y de la búsqueda |

### Sincronizar un directorio raíz

`sync_start` incorpora archivos nuevos o modificados, omite los que son idénticos byte a byte y elimina del índice los archivos que ya no existen:

```text
Sincroniza todo el contenido de los directorios raíz configurados y espera a que termine.
```

La herramienta devuelve un `jobId` de inmediato. El cliente debe consultar `sync_status` hasta que el estado sea `succeeded` o `failed`. Durante la sincronización no hay modo visual; los PDF modificados se incorporan como texto.

El proceso del servidor solo conserva un trabajo de sincronización. Un trabajo nuevo sustituye el registro de uno ya terminado y el registro se pierde al reiniciar el servidor.

### Incorporar un archivo

`ingest_file` admite PDF, DOCX, TXT y Markdown. Las rutas de archivo enviadas mediante MCP deben ser absolutas y estar dentro de un directorio raíz configurado:

```text
Incorpora el documento /Users/me/docs/api-spec.pdf.
```

Si se vuelve a incorporar la misma ruta, sus segmentos anteriores se sustituyen.

### Buscar y leer más contexto

```text
¿Qué dice la documentación de la API sobre la autenticación?
Busca el comportamiento documentado de ERR_CONNECTION_REFUSED.
```

Los resultados contienen el texto, la ruta de origen, el título, el índice del segmento y la puntuación de relevancia. Si necesitas más contexto, pasa a `read_chunk_neighbors` el `chunkIndex` y el `filePath` o `source` del resultado:

```text
Lee los segmentos contiguos a ese resultado sobre autenticación.
```

Tanto `query_documents` como `list_files` aceptan un prefijo de ruta absoluto opcional en `scope`, o una lista de prefijos. Cada prefijo coincide con la ruta exacta y con todo lo que contiene.

### Incorporar HTML

Usa `ingest_data` después de que el cliente MCP haya obtenido la página:

```text
Obtén https://example.com/docs e incorpora el HTML.
```

El servidor extrae el artículo principal, lo convierte a Markdown y lo guarda con el identificador de origen indicado. Si se reutiliza el mismo origen, se actualiza el contenido existente.

Respeta las condiciones y los derechos de autor del sitio de origen al indexar contenido externo.

### Figuras de PDF

El modo visual añade una descripción generada a las páginas de un PDF que contienen muchas figuras. Es opcional y no carga ningún modelo visual durante una incorporación normal.

```text
Incorpora /Users/me/docs/research-paper.pdf con visual: true.
```

```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual
```

| Perfil | Caché del modelo | Uso |
|---|---:|---|
| `fast` (predeterminado) | unos 250 MB | Indexación visual ligera |
| `quality` | unos 2,9 GB | Figuras con etiquetas, anotaciones u otro texto dentro de la imagen |

Selecciona el modelo más grande con `visualQuality: "quality"` en MCP o con `--visual-quality quality` en la CLI. En pruebas con CPU, la inferencia tardó aproximadamente el doble que con `fast`, aunque el resultado depende del hardware y de las actualizaciones del modelo.

Las descripciones son texto auxiliar, no transcripciones fieles. Trata las descripciones y el texto recuperado de los documentos como entradas no fiables, no como instrucciones.

## CLI

La CLI usa el mismo analizador, generador de embeddings y almacén vectorial sin necesidad de un cliente MCP:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "API de autenticación"
npx mcp-local-rag query "autenticación" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

Las opciones globales, como `--db-path`, `--cache-dir` y `--model-name`, van antes del subcomando. Las opciones propias del subcomando van después:

```bash
npx mcp-local-rag --db-path ./my-db query "autenticación"
```

Ejecuta `npx mcp-local-rag --help` para ver la referencia completa de comandos.

La CLI no lee la configuración del cliente MCP. Configura las mismas variables de entorno u opciones si ambas interfaces deben compartir un índice. En particular, `MODEL_NAME` y la opción `--model-name` de la CLI deben coincidir cuando usan la misma base de datos.

## Ajuste de la búsqueda

El refuerzo de palabras clave está activado de forma predeterminada. Para corpus que necesiten una selección más estricta, también se pueden configurar la agrupación por saltos de relevancia y los filtros de distancia y de archivos.

| Variable | Valor predeterminado | Descripción |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Factor de refuerzo de palabras clave (0.0–1.0). 0 desactiva el reajuste por palabras clave y 1 aplica el refuerzo máximo. |
| `RAG_GROUPING` | sin configurar | `similar` conserva el primer grupo de relevancia; `related` conserva hasta dos y usa saltos importantes de distancia vectorial como límites. |
| `RAG_MAX_DISTANCE` | sin configurar | Descarta resultados poco relevantes (por ejemplo, `0.5`). |
| `RAG_MAX_FILES` | sin configurar | Limita los resultados a los N archivos mejor clasificados (por ejemplo, `1` deja solo el mejor archivo). |

En especificaciones de API y otros documentos con muchos identificadores, un peso mayor de palabras clave puede mejorar la clasificación de términos exactos:

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7"
}
```

- `0.7`: reajuste de términos exactos algo más fuerte que el valor predeterminado
- `1.0`: refuerzo máximo de palabras clave

## Cómo funciona

Durante la incorporación:

1. El analizador extrae el texto del formato de entrada.
2. El segmentador semántico localiza cambios de tema y conserva los bloques de código Markdown.
3. Transformers.js crea los embeddings de forma local.
4. LanceDB almacena los segmentos, los metadatos, los vectores y el índice de texto completo.

Durante la búsqueda:

1. La consulta se convierte en un embedding con el mismo modelo.
2. La búsqueda vectorial recupera segmentos relacionados por su significado.
3. Los filtros opcionales de distancia y los grupos de relevancia reducen los candidatos cuando están configurados.
4. Las coincidencias de texto completo refuerzan los términos exactos de la consulta.

## Agent Skills

Las [Agent Skills](https://agentskills.io/) ofrecen a los asistentes de IA instrucciones para formular consultas e incorporar contenido:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

Las habilidades instaladas cubren la formulación de consultas, el refinamiento de resultados y la incorporación de HTML. Si alguna no se activa de forma automática, pide al asistente que use de manera explícita la habilidad mcp-local-rag.

## Configuración

El servidor MCP lee variables de entorno. La CLI acepta las mismas variables y las opciones de la tabla; las opciones de la CLI tienen prioridad.

| Variable de entorno | Opción de la CLI | Valor predeterminado | Descripción |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Directorio actual | Un directorio raíz; la opción de la CLI puede repetirse en `ingest`, `list` y `sync` |
| `BASE_DIRS` | No disponible | sin configurar | Matriz JSON de directorios raíz; tiene prioridad sobre `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Ubicación de la base de datos vectorial |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Directorio de caché de modelos |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Modelo de embeddings de Hugging Face |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100 MB) | Tamaño máximo del archivo en bytes |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Longitud mínima de un segmento en caracteres (1–10000) |
| `RAG_DEVICE` | No disponible | `cpu` | Dispositivo de ejecución de ONNX Runtime |
| `RAG_DTYPE` | No disponible | `fp32` | Tipo de datos de los embeddings que recibe el modelo seleccionado |

### Directorios raíz (`BASE_DIR` y `BASE_DIRS`)

mcp-local-rag solo permite operaciones con archivos dentro de los directorios raíz configurados. Para usar varios, `BASE_DIRS` debe ser una matriz JSON de rutas no vacías:

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

La configuración se resuelve en este orden:

1. Opciones `--base-dir <path>` de la CLI (se pueden repetir en `ingest`, `list` y `sync`)
2. `BASE_DIRS`
3. `BASE_DIR`
4. Directorio actual

Cada origen sustituye al de menor prioridad, no se combina con él. Una configuración de `BASE_DIRS` no válida produce un error en lugar de recurrir a `BASE_DIR` o al directorio actual. `status` sigue disponible en MCP para que el cliente pueda informar del error de configuración.

```bash
npx mcp-local-rag ingest --base-dir /Users/me/work --base-dir /Users/me/specs /Users/me/work/readme.md
npx mcp-local-rag list --base-dir /Users/me/work --base-dir /Users/me/specs
npx mcp-local-rag sync --base-dir /Users/me/work --base-dir /Users/me/specs
BASE_DIRS='["/Users/me/work","/Users/me/specs"]' npx mcp-local-rag list
```

### Almacenamiento y modelos

`DB_PATH` y `CACHE_DIR` son relativos al directorio de trabajo del proceso de forma predeterminada. Usa rutas absolutas si el cliente MCP puede iniciar el servidor desde distintos directorios de proyecto.

Configura `MODEL_NAME` o pasa `--model-name` para elegir un modelo de embeddings de Hugging Face que se ajuste al idioma y al ámbito de tus documentos.

mcp-local-rag genera embeddings mediante mean pooling y normalización L2. Al elegir un modelo, comprueba si estos ajustes coinciden con su configuración de inferencia recomendada, ya que el método de pooling puede influir en la calidad de la búsqueda.

Cambiar `MODEL_NAME`, `RAG_DEVICE` o `RAG_DTYPE` puede hacer que los vectores existentes sean incompatibles. Usa un `DB_PATH` nuevo o elimina el índice existente y vuelve a incorporar los documentos después de cambiar la configuración de embeddings.

Un ejemplo de modelo disponible para documentos en español es `jinaai/jina-embeddings-v2-base-es`.

## Seguridad y funcionamiento

- El acceso a archivos está limitado a los directorios raíz configurados con `BASE_DIR`, `BASE_DIRS` o `--base-dir` en la CLI.
- Se rechazan los enlaces simbólicos cuyo destino esté fuera de todos los directorios raíz configurados.
- El procesamiento de documentos y las búsquedas no realizan solicitudes de red una vez que los modelos necesarios están en caché.
- El servidor está diseñado para un único usuario local y no ofrece autenticación ni control de acceso.
- No ejecutes varios procesos de escritura de la CLI o MCP sobre el mismo `DB_PATH`. Las consultas de solo lectura pueden ejecutarse mientras hay una sincronización en curso.
- Para crear una copia de seguridad del índice, copia el directorio `DB_PATH` cuando no haya ningún proceso de escritura activo.

<details>
<summary><strong>Solución de problemas</strong></summary>

### "No results found"

Primero hay que incorporar los documentos. Ejecuta `"Enumera todos los archivos incorporados"` para comprobarlo.

### Error al descargar el modelo

Comprueba la conexión a Internet. Si usas un proxy, revisa la configuración de red. También puedes [descargar el modelo manualmente](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

El límite predeterminado es de 100 MB. Divide el archivo o aumenta `MAX_FILE_SIZE`.

### Consultas lentas

Comprueba el número de segmentos con `status`. Los documentos grandes con muchos segmentos pueden ralentizar las consultas. Considera dividir los archivos muy grandes.

### "Path outside BASE_DIR"

La ruta debe estar dentro de uno de los directorios raíz configurados: `BASE_DIR`, una entrada de `BASE_DIRS` o una ruta indicada mediante `--base-dir` en la CLI. Usa una ruta absoluta.

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` acepta una matriz JSON con una o más rutas no vacías:

- Válido: `BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- No válido: `BASE_DIRS=/a:/b` (no se admite la sintaxis con separadores)
- No válido: `BASE_DIRS='[]'` (matriz vacía)

### El cliente MCP no muestra las herramientas

1. Comprueba la sintaxis del archivo de configuración
2. Cierra el cliente por completo y vuelve a abrirlo (Cmd+Q en Mac para Cursor)
3. Haz una prueba directa: `npx mcp-local-rag` debería iniciarse sin errores

</details>

## Colaboración

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para preparar el entorno y revisar las pautas.

## Licencia

Licencia MIT. Uso gratuito para fines personales y comerciales.

## Artículos del blog

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding): análisis técnico del diseño de la segmentación semántica y la búsqueda híbrida.

## Agradecimientos

Creado con el [Model Context Protocol](https://modelcontextprotocol.io/) de Anthropic, [LanceDB](https://lancedb.com/) y [Transformers.js](https://huggingface.co/docs/transformers.js).

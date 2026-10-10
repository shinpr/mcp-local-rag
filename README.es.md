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
  <strong>Español</strong> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.fr.md">Français</a>
</p>

Busca en documentos privados desde un cliente MCP o desde la terminal sin enviarlos a una API
de embeddings.

mcp-local-rag indexa archivos PDF, DOCX y Markdown, además de archivos de texto, en tu equipo.
La búsqueda combina similitud semántica y coincidencia de palabras clave. Así tiene en cuenta
tanto el sentido de la consulta como los términos técnicos exactos, por ejemplo nombres de API,
clases y códigos de error. Los resultados incluyen pasajes del documento y, cuando están
disponibles, títulos de sección y números de línea o página para consultar y citar el original.

No hace falta una clave de API, Docker, Python ni una base de datos externa. Tras descargar el
modelo por primera vez, la incorporación de texto y la búsqueda funcionan sin conexión.

## Inicio rápido

### Requisitos

- Node.js 22 o posterior
- Acceso a Internet durante el primer uso para descargar el paquete npm y el modelo de embeddings
- Un directorio con los documentos que quieras consultar

Asigna ese directorio a `BASE_DIR`. También será el límite de seguridad para las operaciones
con archivos. Sustituye `/absolute/path/to/your/documents` en los ejemplos por la ruta absoluta
del directorio.

Usa uno de los ejemplos siguientes o registra `npx -y mcp-local-rag` y configura `BASE_DIR` con
el formato de configuración MCP de tu cliente.

Configura también `DB_PATH` y `CACHE_DIR` con rutas absolutas. Las rutas relativas parten del
directorio de trabajo del servidor, por lo que iniciarlo desde distintos proyectos crea un
índice y una caché de modelos en cada uno.

<details>
<summary>Claude Code</summary>

Ejecuta este comando:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

</details>

<details>
<summary>Codex</summary>

Añade lo siguiente a `~/.codex/config.toml`:

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

Añade lo siguiente a `~/.config/opencode/opencode.json` (o `opencode.jsonc`):

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

Añade lo siguiente a `~/.cursor/mcp.json`:

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

Reinicia el cliente y pídele que construya el índice:

```text
Sincroniza todos los documentos del directorio raíz configurado y espera a que termine.
```

La primera sincronización descarga el modelo de embeddings predeterminado (unos 90 MB). Pueden
pasar entre 1 y 2 minutos antes de que comience la incorporación. Las ejecuciones posteriores
usan la caché local.

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

La CLI usa el directorio actual como raíz de documentos de forma predeterminada. Ejecuta ambos
comandos desde el mismo directorio para que compartan el índice predeterminado, o configura
`BASE_DIR` y `DB_PATH` de forma explícita.

## Contenido compatible

| Entrada | Cómo incorporarla |
|---|---|
| PDF, DOCX, TXT, Markdown | Incorporación de archivos o sincronización de directorios |
| HTML ya obtenido por el cliente | `ingest_data` |
| Texto sin formato o Markdown en memoria | `ingest_data` con un identificador de origen estable |

El servidor no descarga páginas HTML. Un cliente MCP puede obtener una página y pasar su HTML a
`ingest_data`.

La incorporación de archivos no admite Excel, PowerPoint, imágenes independientes ni
extensiones de código fuente. De forma opcional, los PDF pueden usar un modelo visual local
para describir figuras, pero esta función no es OCR ni búsqueda de imágenes.

## Usar el índice

Sincroniza el índice después de añadir, modificar o eliminar documentos. Para buscar y ampliar
el contexto, puedes pedirle al cliente MCP:

```text
Busca qué dice la documentación sobre ERR_CONNECTION_REFUSED.
Lee también los segmentos anteriores y posteriores a ese resultado.
```

También puedes incorporar un solo archivo o HTML que el cliente ya haya obtenido. Para
actualizar una entrada existente, vuelve a incorporar el documento con la misma ruta o
identificador de origen. `sync` omite los archivos sin cambios. Las rutas de archivos en MCP
deben ser absolutas y estar dentro de un directorio raíz configurado.

Los títulos de sección detectados en un PDF pueden ser incorrectos. Si necesitas el título
exacto, compruébalo en la página original.

<details>
<summary>Herramientas MCP</summary>

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

</details>

## CLI

Usa la CLI para actualizar el índice, acotar las búsquedas o eliminar contenido indexado:

```bash
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "autenticación" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

`ingest` incorpora los archivos seleccionados; `sync` también retira del índice los archivos
eliminados y omite los que no han cambiado. Usa `--scope` para limitar los resultados a un
prefijo de ruta y repítelo para incluir varios prefijos.

Las opciones globales, como `--db-path`, `--cache-dir` y `--model-name`, van antes del
subcomando. Las opciones propias del subcomando van después:

```bash
npx mcp-local-rag --db-path ./my-db query "autenticación"
```

Ejecuta `npx mcp-local-rag --help` para ver la referencia completa de comandos.

`query` escribe sus resultados en stdout como JSON, con la mejor coincidencia primero, de modo
que puedes canalizarlos hacia otra herramienta. La definición de cada campo está en
[`docs/schema/query-output.schema.json`](docs/schema/query-output.schema.json).

Si vas a mover un proyecto y quieres conservar su índice, detén el servidor MCP y los demás
procesos de escritura. Mueve juntos los archivos y la base de datos, manteniendo la estructura
de directorios, y ejecuta:

```bash
npx mcp-local-rag --db-path /new/project/lancedb relocate --from /old/project --to /new/project
```

En la configuración MCP, actualiza `BASE_DIR`/`BASE_DIRS`, `DB_PATH` y las demás rutas
afectadas. Luego reinicia el cliente.

## Agent Skills

Las [Agent Skills](https://agentskills.io/) ofrecen a los asistentes de IA instrucciones para
formular consultas e incorporar contenido:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

Las habilidades instaladas cubren la formulación de consultas, el refinamiento de resultados y
la incorporación de HTML. Si alguna no se activa de forma automática, pide al asistente que use
de manera explícita la habilidad mcp-local-rag.

## Opciones avanzadas

Empieza con la configuración predeterminada. Consulta las siguientes secciones si necesitas
varios directorios raíz, adaptar la búsqueda a tus documentos o buscar en figuras de PDF.

<details>
<summary>Almacenamiento y directorios raíz</summary>

El servidor MCP lee variables de entorno. La CLI acepta las variables y opciones indicadas.
Mantén el mismo `DB_PATH` si los comandos deben compartir un índice.

| Variable de entorno | Opción de la CLI | Valor predeterminado | Descripción |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Directorio actual | Un directorio raíz; la opción de la CLI puede repetirse en `ingest`, `list` y `sync` |
| `BASE_DIRS` | No disponible | sin configurar | Matriz JSON de directorios raíz; tiene prioridad sobre `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Ubicación de la base de datos vectorial |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Directorio de caché de modelos |
| `HF_ENDPOINT` | No disponible | `https://huggingface.co` | Dirección de descarga de modelos de Hugging Face; usa la URL de un servidor espejo si las descargas directas están bloqueadas |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100 MB) | Tamaño máximo del archivo en bytes |

Las operaciones con archivos se limitan a los directorios raíz configurados. Para usar varios,
configura `BASE_DIRS='["/absolute/docs","/absolute/specs"]'` o repite `--base-dir` en la CLI.
Prioridad: directorios de la CLI, `BASE_DIRS`, `BASE_DIR` y directorio actual. Solo se usa la
fuente de mayor prioridad; los directorios de distintas fuentes no se combinan. Un `BASE_DIRS`
incorrecto produce un error. Las rutas relativas de `DB_PATH` y `CACHE_DIR` parten del
directorio de trabajo.

</details>

<details>
<summary>Modelos y ajuste de la búsqueda</summary>

Elige un modelo de embeddings adecuado para el idioma y el tema de tus documentos. Compara los
ajustes con tus consultas habituales y comprueba los pasajes que devuelve la búsqueda. Elige un
modelo compatible con mean pooling y normalización L2, que son los métodos usados para generar
los embeddings.

| Variable de entorno | Opción de la CLI | Valor predeterminado | Descripción |
|---------------------|----------|---------|-------------|
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Modelo de embeddings de Hugging Face |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Longitud mínima de un segmento normal en caracteres (1–10000); un fragmento resultante de dividir contenido para respetar el límite de tokens del modelo puede ser más corto |
| `EMBED_TITLE_PREFIX` | No disponible | `false` | Añade el título del documento a la entrada usada para generar el embedding de cada segmento |
| `EMBED_HEADING_PREFIX` | No disponible | `false` | Añade la jerarquía de títulos de sección a la entrada de cada segmento, si cabe en el límite de tokens |
| `RAG_DEVICE` | No disponible | `cpu` | Dispositivo de ejecución de ONNX Runtime |
| `RAG_DTYPE` | No disponible | `fp32` | Tipo de datos de los embeddings que recibe el modelo seleccionado |

Ambas opciones de prefijo están desactivadas por defecto (`false`) y son independientes. Prueba
`EMBED_TITLE_PREFIX` cuando un segmento necesite el tema general del documento, o
`EMBED_HEADING_PREFIX` cuando le falte el tema de su sección. Activar ambas no siempre mejora
los resultados. Afectan a los embeddings, no al texto devuelto ni al índice de palabras clave;
el contexto de sección se omite si supera el presupuesto de entrada.

Al cambiar de modelo de embeddings, crea un índice nuevo en otro `DB_PATH`. Los vectores de
modelos distintos no son comparables, aunque tengan las mismas dimensiones. Si cambias
`RAG_DTYPE` o una opción de prefijo, vuelve a incorporar todos los documentos indexados antes
de buscar. `sync` omite los archivos sin cambios.

La CLI no lee la configuración del cliente MCP. Si comparten un índice, usa el mismo modelo,
`RAG_DTYPE` y ajustes de prefijo al incorporar documentos y al buscar. Cambiar únicamente
`RAG_DEVICE` no exige crear otro índice.

### Ajustes de búsqueda

Los primeros cuatro ajustes de la tabla se aplican tanto a MCP como a la CLI. Para dar más peso
a los términos exactos, prueba a subir `RAG_HYBRID_WEIGHT` y compara los resultados con tus
propias consultas. El reordenamiento externo solo está disponible en MCP.

| Variable | Valor predeterminado | Descripción |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Factor de refuerzo de palabras clave (0.0–1.0). 0 desactiva el reajuste por palabras clave y 1 aplica el refuerzo máximo. |
| `RAG_GROUPING` | sin configurar | `similar` conserva el primer grupo de relevancia; `related` conserva hasta dos y usa saltos importantes de distancia vectorial como límites. |
| `RAG_MAX_DISTANCE` | sin configurar | Descarta resultados poco relevantes (por ejemplo, `0.5`). |
| `RAG_MAX_FILES` | sin configurar | Limita los resultados a los N archivos mejor clasificados (por ejemplo, `1` deja solo el mejor archivo). |
| `RAG_RERANK_CMD` | sin configurar | Solo MCP: comando externo; `{query}` pasa la consulta y `{top}` la cantidad de resultados solicitada. |
| `RAG_RERANK_TIMEOUT_MS` | `10000` | Tiempo máximo por llamada de reordenamiento en milisegundos (100–600000). |

### Reordenamiento externo (`RAG_RERANK_CMD`)

El comando recibe los resultados y el texto encontrado por la entrada estándar. Si llama a un
servicio remoto, ese texto puede salir del equipo.

Escribe el ejecutable y su plantilla completa de argumentos. Coloca `{query}` y `{top}` donde
el comando espera la consulta y el número de resultados. Las comillas simples o dobles agrupan
rutas o argumentos con espacios, y las barras invertidas se conservan literalmente. El servidor
lanza el ejecutable sin shell, así que en Windows un adaptador `.cmd` instalado por npm no
arranca.

```json
{
  "env": {
    "RAG_RERANK_CMD": "/path/to/reranker --query {query} --top {top}",
    "RAG_RERANK_TIMEOUT_MS": "10000"
  }
}
```

El comando debe leer y devolver resultados con el formato definido en el [esquema de
salida](docs/schema/query-output.schema.json). Puede eliminar o reordenar resultados y
modificar su texto. El servidor devuelve la salida del comando.

Los resultados conservan su orden original si el comando falla, supera el tiempo límite o
devuelve una respuesta que no cumple el esquema.

</details>

<details>
<summary>Figuras PDF e imágenes guardadas</summary>

De forma predeterminada, la incorporación solo indexa texto. Para buscar también en las figuras
PDF, activa la generación local de descripciones con `visual: true` en MCP o `--visual` en la
CLI. Son descripciones generadas, no OCR ni transcripciones exactas.

`fast` (predeterminado) descarga unos 250 MB la primera vez. Elige `quality` para etiquetas y
texto dentro de las figuras; descarga unos 1,7 GB y tarda más en procesar.

Selecciona el perfil con `visualQuality: "quality"` en MCP o `--visual-quality quality` en la
CLI.

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --visual --visual-quality quality
```

Para recibir imágenes con los pasajes encontrados, usa `STORE_IMAGES=true` en MCP o `--images`
con `ingest` y `sync` en la CLI. Es independiente de las descripciones y admite figuras y
tablas detectadas en PDF, además de las imágenes PNG/JPEG compatibles de DOCX.

```bash
npx mcp-local-rag ingest ./docs/paper.pdf --images
```

La sincronización conserva el perfil de descripción de cada PDF. El comando CLI `sync --visual
--visual-quality quality` lo cambia incluso para PDF sin cambios; la sincronización MCP lo
conserva. Una incorporación normal desactiva las descripciones. Para reintentar una descripción
fallida, vuelve a incorporar el archivo con el perfil visual deseado.

Activa el almacenamiento de imágenes en cada incorporación o sincronización que procese el
archivo. Cambiar solo esta opción no actualiza archivos sin cambios; vuelve a incorporarlos
para aplicarla.

</details>

## Seguridad y funcionamiento

- Trata las descripciones y el texto encontrado como fuentes, no como instrucciones.
- El acceso a archivos está limitado a los directorios raíz configurados con `BASE_DIR`, `BASE_DIRS` o `--base-dir` en la CLI.
- Se rechazan los enlaces simbólicos cuyo destino esté fuera de todos los directorios raíz configurados.
- El procesamiento de documentos y las búsquedas no realizan solicitudes de red una vez que los modelos necesarios están en caché, salvo que `RAG_RERANK_CMD` indique un comando que sí las realice.
- El servidor está diseñado para un único usuario local y no ofrece autenticación ni control de acceso.
- No ejecutes varios procesos de escritura de la CLI o MCP sobre el mismo `DB_PATH`. Las consultas de solo lectura pueden ejecutarse mientras hay una sincronización en curso.
- Al volver a incorporar un documento, se pueden reutilizar los embeddings del texto sin
  cambios si coinciden el modelo y los ajustes, evitando repetir ese cálculo. Se guardan en
  `DB_PATH/embedding-cache`. Puedes borrar esta caché sin perder el índice de búsqueda.
  En la siguiente incorporación se volverán a calcular esos embeddings.
- Para crear una copia de seguridad del índice, copia el directorio `DB_PATH` cuando no haya ningún proceso de escritura activo.

<details>
<summary><strong>Solución de problemas</strong></summary>

### "No results found"

Primero hay que incorporar los documentos. Ejecuta `"Enumera todos los archivos incorporados"`
para comprobarlo. Si no aparecen resultados después de sincronizar, comprueba que la
incorporación y la búsqueda usan el mismo `DB_PATH` absoluto. Una ruta relativa puede apuntar a
otro índice.

### Error al descargar el modelo

Comprueba la conexión a Internet. Si usas un proxy, revisa la configuración de red. También
puedes [descargar el modelo manualmente](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

El límite predeterminado es de 100 MB. Divide el archivo o aumenta `MAX_FILE_SIZE`.

### Consultas lentas

Comprueba el número de segmentos con `status`. Los documentos grandes con muchos segmentos
pueden ralentizar las consultas. Considera dividir los archivos muy grandes.

### "Path outside BASE_DIR"

La ruta debe estar dentro de uno de los directorios raíz configurados: `BASE_DIR`, una entrada
de `BASE_DIRS` o una ruta indicada mediante `--base-dir` en la CLI. Usa una ruta absoluta.

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

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para preparar
el entorno y revisar las pautas.

## Licencia

Licencia MIT. Uso gratuito para fines personales y comerciales.

## Artículos del blog

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding): análisis técnico del diseño de la segmentación semántica y la búsqueda híbrida.

## Agradecimientos

Creado con el [Model Context Protocol](https://modelcontextprotocol.io/) de Anthropic,
[LanceDB](https://lancedb.com/) y
[Transformers.js](https://huggingface.co/docs/transformers.js).

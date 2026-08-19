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
  <strong>Deutsch</strong> |
  <a href="README.es.md">Español</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.fr.md">Français</a>
</p>

Durchsuche vertrauliche Dokumente über einen MCP-Client oder das Terminal, ohne sie an eine Embedding-API zu senden.

mcp-local-rag indexiert PDF-, DOCX-, Markdown- und Textdateien direkt auf deinem Rechner. Die Suche verbindet semantische Ähnlichkeit mit Stichwortsuche. Dadurch findet sie sowohl sinngleiche Inhalte als auch exakte technische Begriffe wie API-Namen, Klassennamen und Fehlercodes.

## Funktionen

- **Läuft lokal:** Dokument-Parsing, Embeddings, Speicherung und Suche finden auf deinem Rechner statt. Nach dem ersten Modelldownload funktionieren Textimport und Suche offline.
- **Hybride Suche:** Die semantische Suche findet verwandte Konzepte, während die Stichwortsuche exakte Fachbegriffe höher gewichtet.
- **Konfigurierbare Embeddings:** Wähle ein Hugging-Face-Embedding-Modell, das zur Sprache und zum Fachgebiet deiner Dokumente passt.
- **Semantische Aufteilung:** Dokumente werden an Themenwechseln statt nach einer festen Zeichenzahl geteilt. Markdown-Codeblöcke bleiben erhalten.
- **MCP und CLI:** KI-Programmierwerkzeuge und Terminal greifen auf denselben Index zu.

Es werden weder API-Schlüssel noch Docker, Python oder eine externe Datenbank benötigt.

## Schnellstart

### Voraussetzungen

- Node.js 22 oder neuer
- Internetzugang beim ersten Start, um das npm-Paket und das Embedding-Modell herunterzuladen
- Ein Verzeichnis mit den zu durchsuchenden Dokumenten

Setze `BASE_DIR` auf dieses Verzeichnis. Es bildet zugleich die Sicherheitsgrenze für Dateizugriffe. Ersetze `/absolute/path/to/your/documents` in den folgenden Beispielen durch den absoluten Pfad zu deinen Dokumenten.

mcp-local-rag verwendet das Standard-MCP-Protokoll über einen lokalen stdio-Server. Damit funktioniert es mit KI-Programmierwerkzeugen und anderen MCP-Hosts, die lokale MCP-Server unterstützen.

Nutze eines der folgenden Beispiele oder registriere `npx -y mcp-local-rag` im Konfigurationsformat deines Clients und setze dort `BASE_DIR`.

**Claude Code:** Führe diesen Befehl aus:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

**Codex:** Ergänze `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

**OpenCode:** Ergänze `~/.config/opencode/opencode.json` (oder `opencode.jsonc`):

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

**Cursor:** Ergänze `~/.cursor/mcp.json`:

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

Starte den Client neu und lass ihn anschließend den Index aufbauen:

```text
Synchronisiere alle Dokumente im konfigurierten Stammverzeichnis und warte, bis der Vorgang abgeschlossen ist.
```

Bei der ersten Synchronisierung wird das Standard-Embedding-Modell heruntergeladen (etwa 90 MB). Bis der Import beginnt, können 1–2 Minuten vergehen. Spätere Durchläufe verwenden den lokalen Cache.

Nach Abschluss der Synchronisierung kannst du zum Beispiel fragen:

```text
Was steht in der API-Dokumentation zur Authentifizierung?
```

### CLI-Schnellstart

So verwendest du die CLI ohne MCP-Client:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "Authentifizierungs-API"
```

Die CLI verwendet standardmäßig das aktuelle Verzeichnis als Dokumentenstamm. Führe beide Befehle im selben Verzeichnis aus, damit sie denselben Standardindex verwenden, oder setze `BASE_DIR` und `DB_PATH` ausdrücklich.

## Hintergrund

Manche Dokumentensammlungen dürfen aus Vertraulichkeitsgründen oder aufgrund interner Richtlinien nicht an gehostete Embedding-Dienste gesendet werden. Mit einem lokalen Index bleiben sie durchsuchbar, ohne dass pro Anfrage API-Kosten entstehen.

Eine rein semantische Suche kann exakte Bezeichner übersehen, die in technischer Dokumentation wichtig sind. Die Stichwortgewichtung hält diese Treffer sichtbar, ohne auf natürlichsprachliche Suche zu verzichten.

## Unterstützte Inhalte

| Eingabe | Import |
|---|---|
| PDF, DOCX, TXT, Markdown | Einzelne Datei importieren oder Verzeichnis synchronisieren |
| Bereits vom Client abgerufenes HTML | Mit `ingest_data`; wird durch Readability bereinigt und in Markdown umgewandelt |
| Im Speicher vorliegender Klartext oder Markdown | Mit `ingest_data` und einer stabilen Quellkennung |

Der Server ruft HTML nicht selbst ab. Ein MCP-Client kann eine Seite laden und ihr HTML an `ingest_data` übergeben.

Excel, PowerPoint, einzelne Bilddateien und Quellcodedateien werden beim Dateiimport nicht unterstützt. Für Abbildungen in PDFs kann optional ein lokales Vision-Modell verwendet werden. Das ist weder OCR noch Bildsuche.

## MCP-Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `sync_start` | Alle konfigurierten Stammverzeichnisse oder einen Pfad mit dem Index abgleichen |
| `sync_status` | Status einer laufenden Synchronisierung abrufen |
| `ingest_file` | Eine Datei importieren oder ersetzen |
| `ingest_data` | Bereits im Client vorliegenden Text, Markdown oder HTML importieren |
| `query_documents` | Mit semantischem Abgleich und Stichwortgewichtung suchen |
| `read_chunk_neighbors` | Benachbarte Abschnitte eines Suchtreffers lesen |
| `list_files` | Unterstützte Dateien und ihren Importstatus anzeigen |
| `delete_file` | Eine indexierte Datei oder einen `ingest_data`-Eintrag löschen |
| `status` | Status von Index und Suche anzeigen |

### Dokumentenstamm synchronisieren

`sync_start` importiert neue und geänderte Dateien, überspringt bytegleiche Dateien und entfernt Indexeinträge für Dateien, die nicht mehr vorhanden sind:

```text
Synchronisiere alle Inhalte in den konfigurierten Dokumentenstämmen und warte auf den Abschluss.
```

Das Werkzeug gibt sofort eine `jobId` zurück. Clients sollten `sync_status` abfragen, bis der Status `succeeded` oder `failed` lautet. Während der Synchronisierung gibt es keinen visuellen Modus; geänderte PDFs werden als Text importiert.

Der Serverprozess speichert nur einen Synchronisierungsauftrag. Ein neuer Auftrag ersetzt den Eintrag eines abgeschlossenen Auftrags. Beim Neustart des Servers geht der Eintrag verloren.

### Einzelne Datei importieren

`ingest_file` unterstützt PDF, DOCX, TXT und Markdown. MCP-Dateipfade müssen absolut sein und innerhalb eines konfigurierten Dokumentenstamms liegen:

```text
Importiere das Dokument /Users/me/docs/api-spec.pdf.
```

Ein erneuter Import desselben Pfads ersetzt die vorhandenen Abschnitte.

### Suchen und weiteren Kontext lesen

```text
Was steht in der API-Dokumentation zur Authentifizierung?
Finde das dokumentierte Verhalten von ERR_CONNECTION_REFUSED.
```

Ergebnisse enthalten Text, Quellpfad, Titel, Abschnittsnummer und Relevanzwert. Wenn mehr Kontext nötig ist, übergib `chunkIndex` und entweder `filePath` oder `source` aus dem Treffer an `read_chunk_neighbors`:

```text
Lies die benachbarten Abschnitte dieses Treffers zur Authentifizierung.
```

`query_documents` und `list_files` akzeptieren optional ein absolutes `scope`-Pfadpräfix oder eine Liste von Präfixen. Ein Präfix entspricht dem angegebenen Pfad und allen darunterliegenden Pfaden.

### HTML importieren

Rufe die Seite zuerst mit dem MCP-Client ab und verwende anschließend `ingest_data`:

```text
Rufe https://example.com/docs ab und importiere das HTML.
```

Der Server extrahiert den Hauptinhalt, wandelt ihn in Markdown um und speichert ihn unter der angegebenen Quellkennung. Wird dieselbe Quelle erneut verwendet, wird der vorhandene Inhalt aktualisiert.

Beachte beim Indexieren externer Inhalte die Nutzungsbedingungen und das Urheberrecht der Quelle.

### Abbildungen in PDFs

Der visuelle Modus erzeugt Bildbeschreibungen für PDF-Seiten mit vielen Abbildungen. Er muss ausdrücklich aktiviert werden und lädt bei einem normalen Import kein Vision-Modell.

```text
Importiere /Users/me/docs/research-paper.pdf mit visual: true.
```

```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual
```

| Profil | Modellcache | Geeignet für |
|---|---:|---|
| `fast` (Standard) | etwa 250 MB | Leichtgewichtige visuelle Indexierung |
| `quality` | etwa 2,9 GB | Abbildungen mit Beschriftungen, Anmerkungen oder anderem Text im Bild |

Wähle das größere Modell über MCP mit `visualQuality: "quality"` oder über die CLI mit `--visual-quality quality`. In CPU-Messungen dauerte die Inferenz etwa doppelt so lange wie mit `fast`; die tatsächliche Geschwindigkeit hängt von Hardware und Modellversion ab.

Die erzeugten Bildbeschreibungen sind Hilfstexte, keine wortgetreuen Transkriptionen. Behandle gefundene Bildbeschreibungen und Dokumenttexte als nicht vertrauenswürdige Eingaben, nicht als Anweisungen.

## CLI

Die CLI verwendet ohne MCP-Client denselben Parser, Embedder und Vektorspeicher:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "Authentifizierungs-API"
npx mcp-local-rag query "Authentifizierung" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

Globale Optionen wie `--db-path`, `--cache-dir` und `--model-name` stehen vor dem Unterbefehl. Optionen des Unterbefehls stehen dahinter:

```bash
npx mcp-local-rag --db-path ./my-db query "Authentifizierung"
```

`npx mcp-local-rag --help` zeigt die vollständige Befehlsreferenz.

Die CLI liest keine MCP-Client-Konfiguration. Wenn beide Schnittstellen denselben Index verwenden sollen, müssen dieselben Umgebungsvariablen oder Optionen gesetzt sein. Insbesondere müssen `MODEL_NAME` und die CLI-Option `--model-name` für eine gemeinsam verwendete Datenbank übereinstimmen.

## Suchparameter anpassen

Die Stichwortgewichtung ist standardmäßig aktiv. Für Korpora, die eine strengere Auswahl erfordern, stehen außerdem die Gruppierung anhand von Relevanzsprüngen sowie Distanz- und Dateifilter zur Verfügung.

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Gewicht der Stichworttreffer (0.0–1.0). 0 deaktiviert die Stichwortgewichtung, 1 verwendet das höchste Gewicht. |
| `RAG_GROUPING` | nicht gesetzt | `similar` behält die erste Relevanzgruppe; `related` behält bis zu zwei Gruppen und trennt sie an deutlichen Sprüngen der Vektordistanz. |
| `RAG_MAX_DISTANCE` | nicht gesetzt | Filtert wenig relevante Treffer heraus, zum Beispiel mit `0.5`. |
| `RAG_MAX_FILES` | nicht gesetzt | Beschränkt die Treffer auf die besten N Dateien, zum Beispiel mit `1` auf die beste Datei. |

Bei API-Spezifikationen und anderen Dokumenten mit vielen Bezeichnern kann ein höheres Stichwortgewicht die Rangfolge exakter Treffer verbessern:

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7"
}
```

- `0.7`: etwas stärkere Gewichtung exakter Begriffe als in der Standardeinstellung
- `1.0`: höchste Stichwortgewichtung

## Funktionsweise

Beim Import:

1. Der Parser extrahiert den Text aus dem Eingabeformat.
2. Der semantische Chunker erkennt Themenwechsel und behält Markdown-Codeblöcke intakt.
3. Transformers.js erzeugt die Embeddings lokal.
4. LanceDB speichert Abschnitte, Metadaten, Vektoren und den Volltextindex.

Bei der Suche:

1. Die Abfrage wird mit demselben Modell eingebettet.
2. Die Vektorsuche findet semantisch verwandte Abschnitte.
3. Optionale Distanzfilter und Relevanzgruppen schränken die Kandidaten weiter ein.
4. Volltexttreffer erhöhen das Gewicht exakter Suchbegriffe.

## Agent Skills

[Agent Skills](https://agentskills.io/) geben KI-Assistenten Hinweise für Abfragen und Importe:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

Die installierten Skills behandeln Abfrageformulierung, Trefferverfeinerung und HTML-Import. Falls ein Skill nicht automatisch aktiviert wird, bitte den Assistenten ausdrücklich darum, den mcp-local-rag-Skill zu verwenden.

## Konfiguration

Der MCP-Server liest Umgebungsvariablen. Die CLI unterstützt dieselben Variablen sowie die aufgeführten Optionen; CLI-Optionen haben Vorrang.

| Umgebungsvariable | CLI-Option | Standard | Beschreibung |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Aktuelles Verzeichnis | Ein Dokumentenstamm; die CLI-Option kann bei `ingest`, `list` und `sync` mehrfach verwendet werden |
| `BASE_DIRS` | – | nicht gesetzt | JSON-Array mit Dokumentenstämmen; hat Vorrang vor `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Pfad zur Vektordatenbank |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Verzeichnis für den Modellcache |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Hugging-Face-Embedding-Modell |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100 MB) | Maximale Dateigröße in Byte |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Mindestlänge eines Abschnitts in Zeichen (1–10000) |
| `RAG_DEVICE` | – | `cpu` | ONNX-Runtime-Ausführungsgerät |
| `RAG_DTYPE` | – | `fp32` | An das ausgewählte Modell übergebener Embedding-Datentyp |

### Dokumentenstämme (`BASE_DIR` und `BASE_DIRS`)

mcp-local-rag erlaubt Dateizugriffe nur innerhalb der konfigurierten Stammverzeichnisse. Für mehrere Stammverzeichnisse muss `BASE_DIRS` ein JSON-Array mit nicht leeren Pfaden sein:

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

Die Stammverzeichnisse werden in dieser Reihenfolge ermittelt:

1. CLI-Optionen `--base-dir <path>` (mehrfach bei `ingest`, `list` und `sync` möglich)
2. `BASE_DIRS`
3. `BASE_DIR`
4. Aktuelles Verzeichnis

Jede Quelle ersetzt die nachrangige Quelle vollständig, statt mit ihr zusammengeführt zu werden. Eine ungültige `BASE_DIRS`-Konfiguration führt zu einem Fehler; es wird nicht auf `BASE_DIR` oder das aktuelle Verzeichnis zurückgegriffen. `status` bleibt in MCP verfügbar, damit der Client den Konfigurationsfehler melden kann.

```bash
npx mcp-local-rag ingest --base-dir /Users/me/work --base-dir /Users/me/specs /Users/me/work/readme.md
npx mcp-local-rag list --base-dir /Users/me/work --base-dir /Users/me/specs
npx mcp-local-rag sync --base-dir /Users/me/work --base-dir /Users/me/specs
BASE_DIRS='["/Users/me/work","/Users/me/specs"]' npx mcp-local-rag list
```

### Speicher und Modelle

`DB_PATH` und `CACHE_DIR` beziehen sich standardmäßig auf das Arbeitsverzeichnis des Prozesses. Verwende absolute Pfade, wenn der MCP-Client den Server aus unterschiedlichen Projektverzeichnissen starten kann.

Setze `MODEL_NAME` oder übergib `--model-name`, um ein Hugging-Face-Embedding-Modell auszuwählen, das zur Sprache und zum Fachgebiet deiner Dokumente passt.

mcp-local-rag erzeugt Embeddings mit Mean Pooling und L2-Normalisierung. Prüfe bei der Modellauswahl, ob diese Einstellungen dem empfohlenen Inferenzverfahren des Modells entsprechen, da die Pooling-Methode die Suchqualität beeinflussen kann.

Eine Änderung von `MODEL_NAME`, `RAG_DEVICE` oder `RAG_DTYPE` kann vorhandene Vektoren inkompatibel machen. Verwende nach einer Änderung der Embedding-Konfiguration einen neuen `DB_PATH` oder lösche den vorhandenen Index und importiere die Dokumente erneut.

Ein Beispiel für deutschsprachige Dokumente ist das Modell `jinaai/jina-embeddings-v2-base-de`.

## Sicherheit und Betrieb

- Dateizugriffe sind auf die mit `BASE_DIR`, `BASE_DIRS` oder der CLI-Option `--base-dir` festgelegten Stammverzeichnisse beschränkt.
- Symbolische Links, deren Ziel außerhalb aller konfigurierten Stammverzeichnisse liegt, werden abgelehnt.
- Sobald die benötigten Modelle im Cache liegen, greifen Dokumentverarbeitung und Suche nicht mehr auf das Netzwerk zu.
- Der Server ist für einen einzelnen lokalen Benutzer ausgelegt und bietet keine Authentifizierung oder Zugriffskontrolle.
- Mehrere CLI- oder MCP-Schreibprozesse dürfen nicht gleichzeitig denselben `DB_PATH` verwenden. Reine Leseabfragen sind während einer Synchronisierung möglich.
- Sichere den Index, indem du das `DB_PATH`-Verzeichnis kopierst, während kein Schreibprozess läuft.

<details>
<summary><strong>Fehlerbehebung</strong></summary>

### "No results found"

Dokumente müssen zuerst importiert werden. Prüfe den Importstatus mit `"Liste alle importierten Dateien auf"`.

### Modelldownload fehlgeschlagen

Prüfe die Internetverbindung. Wenn du einen Proxy verwendest, kontrolliere die Netzwerkeinstellungen. Das Modell kann auch [manuell heruntergeladen](https://huggingface.co/Xenova/all-MiniLM-L6-v2) werden.

### "File too large"

Die Standardgrenze beträgt 100 MB. Teile die Datei auf oder erhöhe `MAX_FILE_SIZE`.

### Langsame Abfragen

Prüfe die Anzahl der Abschnitte mit `status`. Große Dokumente mit vielen Abschnitten können Abfragen verlangsamen. Sehr große Dateien sollten gegebenenfalls geteilt werden.

### "Path outside BASE_DIR"

Der Dateipfad muss innerhalb eines konfigurierten Stammverzeichnisses liegen: `BASE_DIR`, ein Eintrag aus `BASE_DIRS` oder ein über `--base-dir` gesetzter Pfad. Verwende einen absoluten Pfad.

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` akzeptiert ein JSON-Array mit einem oder mehreren nicht leeren Pfaden:

- Gültig: `BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- Ungültig: `BASE_DIRS=/a:/b` (Trennzeichensyntax wird nicht unterstützt)
- Ungültig: `BASE_DIRS='[]'` (leeres Array)

### MCP-Client zeigt keine Werkzeuge an

1. Syntax der Konfigurationsdatei prüfen
2. Client vollständig beenden und neu starten (bei Cursor auf dem Mac mit Cmd+Q)
3. Direkt testen: `npx mcp-local-rag` sollte ohne Fehler starten

</details>

## Mitwirken

Beiträge sind willkommen. Hinweise zur Einrichtung und zu den Richtlinien stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT-Lizenz. Kostenlose Nutzung für private und kommerzielle Zwecke.

## Blogbeiträge

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding): Technischer Einblick in semantische Aufteilung und hybride Suche.

## Danksagung

Erstellt mit dem [Model Context Protocol](https://modelcontextprotocol.io/) von Anthropic, [LanceDB](https://lancedb.com/) und [Transformers.js](https://huggingface.co/docs/transformers.js).

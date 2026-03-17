# Claude Slack Bot

Bot de Slack que integra Claude Code para interactuar con repositorios, Jira, Supabase y NotebookLM directamente desde Slack.

## Features

- **Chat con Claude Code** via DM o @mention en canales
- **Auto-deteccion de repo** — si hay un solo repo, lo usa automaticamente. Si hay varios, Claude elige basandose en el contexto
- **Sesiones persistentes** — mantiene el contexto de la conversacion por thread/DM
- **Streaming** — muestra respuestas progresivamente con indicador de procesamiento
- **Archivos adjuntos** — sube imagenes, PDFs o cualquier archivo y Claude los analiza
- **Transcripcion de audio** — envia notas de voz y se transcriben automaticamente via Groq (Whisper)
- **Formato nativo de Slack** — convierte markdown a mrkdwn, tablas a Slack table blocks
- **Notificacion al completar** — envia "Done" como mensaje nuevo para que recibas notificacion
- **Skills del proyecto** — carga CLAUDE.md y skills de `.claude/` del repo
- **MCP Servers integrados**:
  - Atlassian (Jira/Confluence) via plugin
  - Supabase via HTTP MCP
  - NotebookLM via stdio MCP

## Stack

- **Runtime**: Node.js 20 + TypeScript
- **SDK**: `@anthropic-ai/claude-agent-sdk`
- **Slack**: `@slack/bolt` (Socket Mode)
- **Audio**: Groq API (Whisper large-v3)
- **Formato**: `slackify-markdown`

## Estructura

```
src/
  index.ts          — Entry point, Slack event handlers, file processing
  claude.ts         — SDK query wrapper, session management, MCP config
  directories.ts    — Working directory management por conversacion
  format.ts         — Markdown → Slack mrkdwn, table blocks
```

## Setup

### Requisitos

- Node.js 20+
- Claude Code CLI instalado con OAuth token
- Slack App con Socket Mode habilitado
- (Opcional) Groq API key para transcripcion de audio

### Variables de entorno

```bash
cp .env.example .env
```

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/home/user/repos
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
GROQ_API_KEY=gsk_...        # Opcional, para transcripcion de audio
```

### Instalar y correr

```bash
npm install
npm run build
npm start
```

### Desarrollo

```bash
npm run dev
```

### Systemd (produccion)

```ini
[Unit]
Description=Claude Code Slack Bot
After=network.target

[Service]
Type=simple
User=<usuario>
WorkingDirectory=/home/<usuario>/claude-slack-bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/home/<usuario>/claude-slack-bot/.env
Environment=PATH=/home/<usuario>/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/<usuario>

[Install]
WantedBy=multi-user.target
```

## Uso en Slack

### Comandos

| Comando | Descripcion |
|---|---|
| `cwd` | Ver directorio de trabajo actual |
| `cwd <repo>` | Cambiar a un repo (relativo a BASE_DIRECTORY) |
| `cwd /ruta/absoluta` | Cambiar a ruta absoluta |

### Interaccion

- **DM**: Escribe directamente al bot
- **Canales**: Menciona `@Claude Code` en un mensaje o hilo
- **Archivos**: Arrastra un archivo al chat junto con tu mensaje
- **Audio**: Envia una nota de voz y se transcribe automaticamente

### Plugins y MCP

Los plugins de Claude Code se cargan desde `~/.claude/plugins/`. Los MCP servers HTTP se autentican usando las credenciales de `~/.claude/.credentials.json`.

Para agregar un nuevo MCP server, edita `src/claude.ts` y agrega la config en `mcpServers`.

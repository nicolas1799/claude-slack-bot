# Claude Slack Bot

Bot de Slack que conecta Claude Code con Slack via el Agent SDK. Corre en una VM GCP (e2-medium, Ubuntu 24.04) como servicio systemd.

## Arquitectura

4 archivos en `src/`:
- `index.ts` — Bolt app (Socket Mode), event handlers para DMs y @mentions, descarga de archivos, transcripcion de audio via Groq
- `claude.ts` — Wrapper del SDK `query()`, manejo de sesiones por conversacion, carga de MCP credentials desde `~/.claude/.credentials.json`, configuracion de plugins y MCP servers
- `directories.ts` — Manejo de `cwd` por conversacion. DMs comparten directorio, threads en canales pueden tener cwd independiente con fallback al canal
- `format.ts` — Conversion de markdown a Slack mrkdwn usando `slackify-markdown`, tablas markdown a Slack table blocks nativos, splitting de mensajes largos en chunks de <2900 chars

## Convenciones

- TypeScript estricto, ESM (`"type": "module"` en package.json)
- Imports con extension `.js` (requerido por ESM con tsc)
- No usar clases — funciones y Maps
- `as const` para literales de tipo en configs del SDK
- Logging con prefijos: `[mcp]`, `[session]`, `[sdk]`, `[whisper]`, `[files]`

## SDK

Usa `@anthropic-ai/claude-agent-sdk` (v0.2.x). La funcion principal es `query()` que retorna un `AsyncGenerator<SDKMessage>`.

Tipos de mensajes relevantes:
- `system` (subtype `init`) — contiene `session_id` y lista de tools
- `system` (subtype `task_progress`) — progreso de subagentes
- `system` (subtype `task_notification`) — subagente completado
- `assistant` — respuesta de Claude, contiene `message.content` con bloques `text` y `tool_use`
- `result` — fin de la query, contiene `result` (texto final) o `error`

## MCP Servers

- **Atlassian**: via plugin local (`~/.claude/plugins/cache/atlassian/`)
- **Supabase**: via HTTP MCP con Bearer token desde credentials
- **NotebookLM**: via stdio MCP (`notebooklm-mcp` instalado con `uv`)
- **Notion**: credentials cargadas pero no configurado como server aun

Las credenciales OAuth se leen de `~/.claude/.credentials.json` al inicio. Si un token expira, hay que re-autenticar desde la maquina local y copiar el archivo con `gcloud compute scp`.

## Slack

- Socket Mode (no necesita URL publica)
- Mensajes con archivos: subtype `file_share` — no filtrar
- Limite de section blocks: 2900 chars
- Limite de blocks por mensaje: 50
- Tablas: usar `type: "table"` con `rows` de `raw_text` y `column_settings`
- `chat.update` no genera notificacion — enviar mensaje nuevo "Done." al final

## Deploy

```bash
# Desde local
git push
# En la VM
cd ~/claude-slack-bot && git pull && npx tsc && sudo systemctl restart claude-slack-bot
```

Logs: `sudo journalctl -u claude-slack-bot -f`

## Cosas a tener en cuenta

- Sesiones y directorios se pierden con cada restart (estan en memoria)
- Los symlinks en `.claude/skills/` deben ser relativos, no absolutos
- `bypassPermissions` requiere `allowDangerouslySkipPermissions: true`
- `settingSources: ["user", "project", "local"]` necesario para cargar CLAUDE.md y skills del repo
- La VM tiene 4GB RAM + 2GB swap — queries concurrentes pueden saturarla

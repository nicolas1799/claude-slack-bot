# Claude Slack Bot

Bot de Slack que conecta Claude Code con Slack via el Agent SDK. Corre en una VM GCP (e2-medium, Ubuntu 24.04) como servicio systemd.

## Arquitectura

5 archivos en `src/`:
- `index.ts` — Bolt app (Socket Mode), event handlers para DMs y @mentions, descarga de archivos, transcripcion de audio via Groq, manejo de stream_event partials
- `claude.ts` — Wrapper del SDK `query()`, manejo de sesiones por conversacion, carga de MCP credentials desde `~/.claude/.credentials.json`, configuracion de plugins y MCP servers, hook PreToolUse, modelo Opus 5 fijo, denylist
- `directories.ts` — Manejo de `cwd` por conversacion. DMs comparten directorio, threads en canales pueden tener cwd independiente con fallback al canal. Restringe paths a `BASE_DIRECTORY`
- `firestore.ts` — Persistencia de sesiones y cwd via `@google-cloud/firestore` (ADC). Hidratacion al boot, write-through cache
- `format.ts` — Conversion de markdown a Slack mrkdwn usando `slackify-markdown`, tablas markdown a Slack table blocks nativos, splitting de mensajes largos en chunks de <2900 chars

## Convenciones

- TypeScript estricto, ESM (`"type": "module"` en package.json)
- Imports con extension `.js` (requerido por ESM con tsc)
- No usar clases — funciones y Maps
- `as const` para literales de tipo en configs del SDK
- Logging con prefijos: `[mcp]`, `[session]`, `[sdk]`, `[whisper]`, `[files]`

## SDK

Usa `@anthropic-ai/claude-agent-sdk` (v0.3.x). La funcion principal es `query()` que retorna un `AsyncGenerator<SDKMessage>`.

Desde 0.3.x el CLI ya no viene como `cli.js` dentro del paquete: es un binario por plataforma en un `optionalDependency` (`@anthropic-ai/claude-agent-sdk-linux-x64`, ~275 MB). Dos consecuencias:
- El disco de la VM tiene que tener espacio antes de un `npm install`, o npm saltea el optional y las queries mueren con `exited with code 1`.
- Actualizar el SDK **requiere reiniciar el servicio**. El proceso viejo mantiene el `sdk.mjs` anterior en memoria pero los archivos en disco ya cambiaron, y spawnea un CLI en una ruta que ya no existe.

Catalogo de features del SDK (lo que usamos y lo que no): `docs/agent-sdk/features.md`. Mantenelo actualizado cuando adoptes un feature nuevo.

Tipos de mensajes relevantes:
- `system` (subtype `init`) — contiene `session_id` y lista de tools
- `system` (subtype `task_progress`) — progreso de subagentes
- `system` (subtype `task_notification`) — subagente completado
- `assistant` — respuesta de Claude, contiene `message.content` con bloques `text` y `tool_use`
- `result` — fin de la query, contiene `result` (texto final) o `error`

## MCP Servers

- **Jira/Confluence**: via CLI `acli` (no MCP). Binario oficial de Atlassian en `~/.local/bin/acli`, auth headless con API token (`acli jira auth login --token`, persistente en disco). El bot lo usa por Bash (`acli jira workitem search/view/create/transition/comment`, agregar `--json` para parsear). Decisión: el plugin OAuth se vaciaba sin auto-refresh y dejaba al bot sin Jira; el API token no expira como el OAuth y la auth es headless (sin browser). Credenciales de re-login en `.env` (`ATLASSIAN_*`). Procedimiento en `docs/atlassian-auth.md`
- **Supabase**: via HTTP MCP con Bearer token desde credentials
- **NotebookLM**: via stdio MCP (`notebooklm-mcp` instalado con `uv`). Auth = cookies de sesión de Google en `~/.notebooklm-mcp-cli/profiles/default/`. `nlm login` necesita navegador, así que no se puede autenticar headless en la VM: se renueva en local y se copian los archivos con `gcloud compute scp`. Procedimiento en `docs/notebooklm-auth.md`
- **Notion**: via CLI `ntn` (no MCP). Binario en `~/.local/bin/ntn`, auth headless con `NOTION_API_TOKEN` (internal integration token) en `.env`. El bot lo usa por Bash (`ntn api ...`, `ntn pages create`). Decisión: evita el overhead de schemas del MCP en cada query y el OAuth-refresh. La integración solo accede a páginas compartidas explícitamente con ella en Notion

Las credenciales OAuth de los MCP se leen de `~/.claude/.credentials.json` al inicio. Si un token expira, hay que re-autenticar desde la maquina local y copiar el archivo con `gcloud compute scp`.

## Auth de Claude Code (la del bot, no la de los MCP)

La VM usa un token de larga duracion en `.env` (`CLAUDE_CODE_OAUTH_TOKEN`, scope `user:inference`, dura 1 año). El SDK lo hereda por `process.env` al spawnear el CLI.

Decisión: antes se copiaba `~/.claude/.credentials.json` desde local, pero eso hacia que la VM y la maquina local compartieran la misma sesion OAuth. Cuando una refrescaba, el refresh token rotaba y la otra quedaba con uno viejo; el refresh fallaba y Claude Code **blanqueaba** `claudeAiOauth` (accessToken y refreshToken en `""`, `expiresAt` en 0). Sintoma: toda query muere al instante con `Claude Code process exited with code 1`, sin mas detalle en los logs del bot.

Para ver el error real, correr una query aislada desde `~/claude-slack-bot` (la resolucion ESM necesita que el script viva dentro del proyecto):

```
[result] success "Failed to authenticate: OAuth session expired and could not be refreshed"
```

Renovacion (`claude setup-token` necesita browser, asi que es headless-con-asistencia):
1. En la VM, lanzar `claude setup-token` bajo un pty con stdin desde un FIFO, para poder leer la URL e inyectar el codigo despues.
2. Abrir la URL en un browser, autorizar, copiar el codigo.
3. Escribir el codigo en el FIFO y despues un `\r` aparte — la TUI no toma `\n` como Enter.
4. Guardar el token en `.env` y reiniciar el servicio.

Al extraer el token del output del pty, ojo con el regex: despues de limpiar ANSI el texto queda pegado (`...b1EzogAAStorethistokensecurely`) y un `sk-ant-oat01-[A-Za-z0-9_-]+` se come la frase siguiente. El token son 108 chars.

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

- Sesiones y directorios persisten en Firestore (`bot_sessions` + `bot_directories`) — sobreviven restarts. Cache write-through en memoria
- Los symlinks en `.claude/skills/` deben ser relativos, no absolutos
- `bypassPermissions` requiere `allowDangerouslySkipPermissions: true`. `disallowedTools` tiene precedencia sobre el bypass
- `settingSources: ["user", "project", "local"]` necesario para cargar CLAUDE.md y skills del repo
- La VM tiene 4GB RAM + 2GB swap — queries concurrentes pueden saturarla
- `cwd` esta restringido a paths bajo `BASE_DIRECTORY` por seguridad
- Para operar `systemctl` el usuario `nicolas` necesita NOPASSWD en sudoers (ver README)

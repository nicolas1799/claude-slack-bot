# Agent SDK — Catálogo de features

Base de conocimiento viva del Claude Agent SDK aplicado a este bot.
Markers: ✅ en uso · 🟡 planeado · ⬜ no usado · ⚠️ preview/inestable

Última revisión: 2026-05-03 · SDK `@anthropic-ai/claude-agent-sdk` ^0.2.76

---

## Lo que ya usamos

| Feature | Archivo |
|---|---|
| ✅ `query()` one-shot por turno | `src/claude.ts` |
| ✅ `resume: sessionId` capturado de `system.init` | `src/claude.ts` |
| ✅ `model: "claude-opus-4-7"` fijo | `src/claude.ts` |
| ✅ `includePartialMessages: true` + manejo de `stream_event` | `src/claude.ts`, `src/index.ts` |
| ✅ `hooks.PreToolUse` (logger `[tool]`) | `src/claude.ts` |
| ✅ `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions` | `src/claude.ts` |
| ✅ `allowedTools` / `disallowedTools` | `src/claude.ts` |
| ✅ `settingSources: ["user","project","local"]` | `src/claude.ts` |
| ✅ `plugins` (local atlassian) | `src/claude.ts` |
| ✅ `mcpServers` stdio + http (creds desde `~/.claude/.credentials.json`) | `src/claude.ts` |
| ✅ `AbortController` para cancelar | `src/claude.ts` |
| ✅ `maxTurns: 25` | `src/claude.ts` |
| ⬜ `maxBudgetUsd` — removido (no necesario por ahora; tracking de costo via `mcp__bot__cost_stats` + Firestore `bot_costs`) | — |
| ✅ `additionalDirectories` (env `ADDITIONAL_DIRECTORIES`, csv) | `src/claude.ts` |
| ✅ `systemPrompt` preset+append | `src/claude.ts` |
| ✅ Custom tools `mcp__bot__*` (bot_status, vm_metrics, service_status, cost_stats) | `src/sdk-tools.ts` |
| ✅ Hook `PostToolUse` → audit log Firestore | `src/claude.ts`, `src/firestore.ts` |
| ✅ Hook `PostToolUseFailure` → log + audit | `src/claude.ts` |
| ✅ Hook `UserPromptSubmit` → inyecta date+branch+dirty | `src/claude.ts` |
| ✅ Hook `SessionStart` / `SessionEnd` | `src/claude.ts` |
| ✅ Hook `SubagentStart` / `SubagentStop` | `src/claude.ts` |
| ✅ Hook `Notification` | `src/claude.ts` |
| ✅ Hook `PreCompact` | `src/claude.ts` |
| ✅ `modelUsage` + `total_cost_usd` log on result | `src/index.ts` |
| ✅ `rate_limit_event` handling | `src/index.ts` |
| ✅ `task_notification` / `task_progress` log | `src/index.ts` |

---

## HIGH IMPACT — vale la pena agendar

### ✅ Custom tools vía `createSdkMcpServer()` + `tool()`
Exponer funciones del bot como tools nativas. Ejemplos: `slack_post_message`, `slack_get_thread_context`, `slack_react_with_emoji`, `git_deploy_self`, `gcloud_describe_vm`.
- **Por qué nos sirve:** hoy Claude tiene que pedir Bash + curl + token para postear a Slack. Con un tool propio es 1 call atómica, tipada, auditada.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/custom-tools
- **Esfuerzo:** M (3-5 tools en ~150 LOC).

### ⬜ `canUseTool` callback con confirmación interactiva en Slack
Cuando Claude quiere correr `gcloud * delete`, `npm publish`, `git push --force`, el bot postea Block Kit con botones Approve/Deny y bloquea hasta respuesta.
- **Por qué nos sirve:** hoy la denylist es binaria. Esto deja decidir caso por caso al humano sin re-arrancar la query.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/permissions
- **Esfuerzo:** M. Requiere mantener un `Map<toolUseId, resolver>` y handler de `block_actions`.

### ⬜ `forkSession`
Bifurcar conversaciones para probar caminos alternativos sin perder el original.
- **Caso:** "el deploy v1.3 está fallando — fork para probar rollback a v1.2 sin tirar el debug actual".
- **Doc:** https://code.claude.com/docs/en/agent-sdk/sessions
- **Esfuerzo:** S. `options.forkSession: true` + persistir el nuevo sessionId con tag.

### ✅ Hook `Notification`
El SDK emite notificaciones (idle, permission requests, auth) — forwardear a Slack.
- **Por qué:** los logs en journald son invisibles desde Slack. Esto los trae al canal.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/hooks
- **Esfuerzo:** S.

### ⬜ Hook `PreToolUse` con `updatedInput` (sandbox / rewrite)
Reescribir paths o comandos antes de ejecutar (ej. forzar `--dry-run` en gcloud destructivos en vez de bloquearlos).
- **Esfuerzo:** S.

---

## MEDIUM IMPACT

### ✅ `hooks.PostToolUse` — audit log a Firestore
Cada Bash/Edit/MCP call → fila en `bot_tool_audit` con `{conversationKey, tool, summary, ok, durationMs, ts}`.
- **Por qué:** debug y compliance. Hoy solo va a stdout.
- **Esfuerzo:** S.

### ✅ `hooks.UserPromptSubmit` — inyectar contexto fresco por turno
Antes de cada prompt: branch git actual, diff pendiente, fecha, status del servicio. Mantiene el system prompt corto y el contexto vivo.
- **Esfuerzo:** S.

### ⬜ Subagents declarativos (`options.agents`)
Definir `code-reviewer` (Sonnet, read-only), `test-runner` (Bash), `deployer` (gcloud + sudoers). Main agent delega.
- **Por qué:** ahorro (Sonnet < Opus) + paralelismo.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/subagents
- **Esfuerzo:** M.

### ✅ Hooks `SubagentStart` / `SubagentStop`
Cuando un subagent termina, postear progress a Slack en thread.
- **Esfuerzo:** S.

### ⬜ `maxBudgetUsd`
Cap de gasto por query. Devuelve subtype `error_max_budget_usd`.
- **Estado:** removido. Hoy trackeamos costo acumulado por conversación en Firestore (`bot_costs`) y exponemos `mcp__bot__cost_stats` para que el bot se consulte. Reactivar si aparece riesgo de loops infinitos.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/cost-tracking
- **Esfuerzo:** S.

### ✅ `modelUsage` per-modelo en `result`
Si adoptamos subagents, esto da breakdown Opus/Sonnet por turno → Slack o Firestore.
- **Esfuerzo:** S.

### ⬜ `systemPrompt: { type:"preset", preset:"claude_code", append:"...", excludeDynamicSections:true }`
- **Por qué:** mejora cache hits entre conversaciones (más barato y rápido). Permite agregar instrucciones globales del bot ("respondé en español", "siempre confirmá deploys") sin tocar CLAUDE.md.
- **Doc:** https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- **Esfuerzo:** S.

### ✅ Hooks `SessionStart` / `SessionEnd`
Telemetría: contar sesiones activas, flush de logs al cerrar, marcar inicio en Firestore.
- **Esfuerzo:** S.

### ✅ Hook `PreCompact` — archivar transcripts antes de compactar
Cuando una sesión se compacta, subir transcript completo a Firestore/GCS.
- **Esfuerzo:** M.

### ✅ `PostToolUseFailure`
Tool falla → retry o notificar. Útil para flakes de gcloud / red.
- **Esfuerzo:** M.

---

## LOW IMPACT / niche / preview

### ✅ `additionalDirectories: [...]`
Operar sobre múltiples repos en una query. Configurado vía env `ADDITIONAL_DIRECTORIES` (csv).
- **Esfuerzo:** S config, M diseño.

### ⬜ `thinking: { type: "adaptive" }`
Default en Opus 4.7 ya. Podemos forzar enabled con budget para tareas pesadas (security review).
- **Esfuerzo:** S.

### ⬜ Slash commands del SDK como prompts (`/compact`, `/context`)
Mapear comandos de Slack ("compactar", "estado") → prompt slash del SDK.
- **Esfuerzo:** S.

### ⬜ `hooks.PermissionRequest`
Custom UI para permisos (modal de Slack). Solapa con `canUseTool` — elegir uno.
- **Esfuerzo:** M-L.

### ✅ `SDKRateLimitEvent` handling
Backoff adaptativo cuando se llega al rate limit del API.
- **Esfuerzo:** S.

### ⚠️ `StreamInput()` en Query (V2 preview)
Mandar follow-ups dentro de la misma query sin terminarla. Hoy nuestro patrón es 1 query por mensaje de Slack — esto permitiría conversación bidireccional viva.
- **Estado:** preview, V2 del SDK. Esperar GA.

### ⬜ `getSessionInfo()` / `listSessions()` / `tagSession()`
Etiquetar sesiones (`deploy-2026-05-03`, `incidente-supabase`) para retomarlas por nombre desde Slack.
- **Esfuerzo:** M.

### ⬜ Tools nativas `ListMcpResources` / `SubscribeMcpResource` / `EnterWorktree`
Exponerlas en `allowedTools` si las necesitamos.
- **Esfuerzo:** S incluirlas; el agent decide cuándo usarlas.

---

## Mensajes del SDK que aún no manejamos

Hoy en `index.ts` solo procesamos `assistant`, `result` y (nuevo) `stream_event`. Otros tipos en `SDKMessage` que podríamos surfacear:

| Tipo | Para qué | Acción sugerida |
|---|---|---|
| `SDKStatusMessage` | Estado interno del agent | Logear en debug |
| `SDKHookProgressMessage` | Progress de hooks largos | Mostrar en context block |
| `SDKToolProgressMessage` | Progress granular de tools (ej. Bash output streaming) | Update Slack en tiempo real |
| `SDKTaskNotificationMessage` | Subagent terminó | Postear a thread |
| `SDKTaskProgressMessage` | Subagent progress | Update inline |
| `SDKRateLimitEvent` | Rate limit hit | Backoff + avisar |
| `SDKPromptSuggestionMessage` | Sugerencias de follow-up | Botones en Slack |
| `SDKCompactBoundaryMessage` | Frontera de compactación | Persistir a Firestore (ver hook PreCompact) |

---

## Cómo mantener este doc

- Cuando se adopte un feature, mover de ⬜/🟡 a ✅ y agregar archivo donde vive.
- Cuando aparezca un feature nuevo en una nueva versión del SDK, agregarlo con ⬜ + doc URL.
- Sub-agentes de exploración: `Agent({subagent_type:"claude-code-guide", ...})` con prompt apuntando a `docs.anthropic.com` o `code.claude.com`.

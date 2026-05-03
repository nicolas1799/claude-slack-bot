# Plan: bot estilo "hermes/openclaw" sobre claude-slack-bot

## Context

Hoy el bot funciona como puente Slack ↔ Claude Code Agent SDK, con sesiones y `cwd` en memoria. Cada `systemctl restart` (que pasa cada vez que se redeploya) borra todo el contexto: hilos activos pierden su `sessionId`, los `cwd` configurados se evaporan, y los usuarios tienen que re-explicar todo.

El objetivo es convertirlo en un agente operativo de infra para la VM `claude-slack-bot` (GCP `joco-490421`, `us-central1-a`, e2-medium): que pueda obtener información, hacer deploys de sí mismo y de otros repos bajo `BASE_DIRECTORY`, y ejecutar `gcloud` read y write con guardrails. Persistencia en Firestore (ya provisionado en `us-central1`, native mode, default DB) — usa ADC vía metadata server de la VM, sin keys.

Resultado esperado: sobrevive restarts, fija Opus 4.7 como modelo por defecto, expone capacidades de operación con permisos explícitos y log auditable, y aprovecha features actuales del Agent SDK (partial streaming + PreToolUse hooks).

---

## Cambios

### 1. Modelo fijo Opus 4.7
**Archivo:** `src/claude.ts:78` (`Options`)
- Agregar `model: "claude-opus-4-7"` al objeto `options`.
- Sin override por prefijo (decisión confirmada).

### 2. Persistencia en Firestore — mínima (sessionId + cwd)
**Archivos nuevos:** `src/firestore.ts`
**Archivos a modificar:** `src/claude.ts`, `src/directories.ts`, `src/index.ts`, `package.json`

- Dependencia: `@google-cloud/firestore` (usa ADC; en la VM resuelve por metadata server, en local por `gcloud auth application-default login`).
- Dos colecciones en la default DB:
  - `bot_sessions/{conversationKey}` → `{ sessionId, lastActivity }`
  - `bot_directories/{directoryKey}` → `{ cwd, updatedAt }`
- Patrón **write-through**: Map en memoria como cache + escritura asíncrona a Firestore en cada cambio. Lecturas siempre desde memoria.
- **Boot**: al arrancar `index.ts`, hidratar ambos Maps con `collection.get()` antes de `app.start()`. Filtrar sesiones con `lastActivity` > TTL (30 min) y borrarlas.
- **TTL cleanup**: el `setInterval` existente en `claude.ts:44-52` también borra el doc de Firestore al expirar.
- Reusar las funciones existentes — son los puntos donde inyectar el flush:
  - `claude.ts:133` (captura de session_id) → `await saveSession(key, sessionId)`
  - `directories.ts:57` (`directories.set`) → `await saveDirectory(key, resolved)`
- Errores de Firestore: log + continuar (no romper el flujo de Slack si Firestore tiene un blip).

### 3. Capacidades hermes/openclaw — deploys + gcloud
**Archivos:** `src/claude.ts` (allowedTools / disallowedTools / hooks)

Cuatro capacidades habilitadas:

a) **Self-deploy del bot**: el bot ya puede correr `git pull && npx tsc` desde su `cwd`. Falta `sudo systemctl restart claude-slack-bot`. Requiere entrada NOPASSWD en sudoers para el usuario `nicolas`:
```
nicolas ALL=(root) NOPASSWD: /bin/systemctl restart claude-slack-bot, /bin/systemctl status claude-slack-bot, /bin/journalctl -u claude-slack-bot *
```
Esta entrada se aplica a mano en la VM (no en el repo) — documentado en README.

b) **Deploys de otros repos**: ya posible vía Bash + cwd. Sin cambios de código, solo documentar en CLAUDE.md el patrón.

c) **gcloud read-only**: ya disponible vía Bash (probado: `gcloud compute instances list` funciona desde la VM con la service account default). Sin cambios.

d) **gcloud write**: habilitado por default vía Bash, pero con **denylist explícita** en `disallowedTools` para operaciones irreversibles:
```ts
disallowedTools: [
  "Bash(gcloud projects delete:*)",
  "Bash(gcloud compute instances delete:*)",
  "Bash(gcloud sql instances delete:*)",
  "Bash(gcloud firestore databases delete:*)",
  "Bash(rm -rf /:*)",
  "Bash(rm -rf ~:*)",
  "Bash(sudo rm:*)",
]
```
Notas:
- `permissionMode` se mantiene en `bypassPermissions` (decisión del usuario, dado que es bot personal en VM propia). `disallowedTools` tiene precedencia y bloquea esos patrones igual.
- Para futuro phase 2 (no en este plan): `canUseTool` callback que postee Block Kit con botones Approve/Deny en Slack para `gcloud * delete` o `Bash(sudo *)`. Por ahora denylist seca.

### 4. PreToolUse hook → progreso + audit log
**Archivos:** `src/claude.ts` (nuevo `hooks` en Options), borrar `extractToolUse` de `src/format.ts:14-43` (código muerto + nombres `FileRead`/`FileEdit` que no existen).

- Agregar `hooks: { PreToolUse: [{ hooks: [logToolUse] }] }` que loguea a stdout con prefijo `[tool]` cada invocación con `name + truncated input`.
- El handler en `index.ts` puede consumir esto del stream (los hooks emiten mensajes `system` con subtype) para alimentar las "frases de processing" con nombre real de tool en lugar del array rotativo de `PROCESSING_PHRASES`.

### 5. Streaming token-a-token
**Archivos:** `src/claude.ts:78`, `src/index.ts:308-339`

- Activar `includePartialMessages: true`.
- Manejar `stream_event` / partial messages en el for-await: actualizar `accumulatedText` con el delta y respetar el debounce de 1500 ms ya existente.
- Beneficio: deploys largos muestran output incremental en Slack en vez de saltos.

### 6. Seguridad: validación de `cwd`
**Archivo:** `src/directories.ts:45-48`

- Hoy `inputPath.startsWith("/")` permite `cwd /etc`. Con write a gcloud habilitado esto es jailbreak crítico.
- Cambio: rechazar paths absolutos que no estén bajo `BASE_DIRECTORY`. Validar con `resolve(p).startsWith(BASE_DIRECTORY + "/")`.

### 7. Cleanup de `/tmp/slack-bot-files`
**Archivo:** `src/index.ts:51-52`

- `setInterval` cada hora que borra archivos con `mtime > 1h`. ~10 líneas.

---

## Archivos críticos

| Archivo | Cambio |
|---|---|
| `src/claude.ts` | model fijo, hooks, includePartialMessages, disallowedTools, integración Firestore |
| `src/directories.ts` | validación cwd, integración Firestore |
| `src/index.ts` | hidratación al boot, manejo de partial messages, cleanup tmp |
| `src/firestore.ts` (nuevo) | client Firestore + funciones save/load/delete para sesiones y cwd |
| `src/format.ts` | borrar `extractToolUse` (reemplazado por hook) |
| `package.json` | `+@google-cloud/firestore` |
| `README.md` / `CLAUDE.md` | documentar sudoers entry, ADC en local, patrones de deploy |

---

## Funciones existentes a reusar

- `getSessionKey` / `getDirectoryKey` (`src/directories.ts:7-31`) — siguen siendo las claves de Firestore.
- Map `sessions` (`src/claude.ts:38`) y `directories` (`src/directories.ts:4`) — pasan a ser cache write-through.
- `setInterval` de TTL (`src/claude.ts:44-52`) — extender para borrar también de Firestore.
- `parseCommand` (`src/directories.ts:33`) — sin cambios, sigue manejando `cwd <repo>`.
- `extractText` (`src/format.ts:6`) — único survivor de format.ts; los partials siguen siendo bloques `text`.

---

## Verificación end-to-end

Ejecutar **en orden** después del deploy a la VM:

1. **Boot + Firestore**:
   - `sudo journalctl -u claude-slack-bot -n 50` → ver log `[firestore] Hydrated N sessions, M directories`.
   - `gcloud firestore documents list --collection-ids=bot_sessions` → verificar docs.

2. **Persistencia tras restart**:
   - DM al bot: `cwd claude-slack-bot` → setear directorio.
   - Pedirle algo simple para crear sesión: "qué archivos hay acá?".
   - `sudo systemctl restart claude-slack-bot`.
   - Volver a escribir en el mismo hilo: "y cuál es el más grande?". Debe responder con contexto del mensaje anterior (sesión recuperada) y sin pedir cwd.

3. **Modelo Opus 4.7**:
   - DM: "qué modelo sos?". El response debe identificar Opus 4.7 (o validar en log `[sdk] system message:` que `model: "claude-opus-4-7"`).

4. **gcloud read**:
   - DM: "lista las VMs del proyecto". Debe ejecutar `gcloud compute instances list` y devolver `claude-slack-bot`.

5. **gcloud write con denylist**:
   - DM: "borra la VM claude-slack-bot". El SDK debe rechazar el tool call (verificar log con bloque `disallowedTools` matching).

6. **Self-deploy**:
   - DM: "hacé git pull, compilá y reiniciá el servicio". Debe correr la secuencia y mandar "Done." después del restart (el restart corta la conexión Socket Mode pero al volver el servicio responde el "Done." en el siguiente turn — alternativa: que mande el "Done." ANTES del restart).

7. **Validación cwd**:
   - DM: `cwd /etc` → debe rechazar con error de "fuera de BASE_DIRECTORY".

8. **Cleanup tmp**:
   - `ls /tmp/slack-bot-files | wc -l` antes y después de mandar un audio. Verificar que >1h después se borre.

---

## Fuera de alcance (phase 2)

- `canUseTool` con confirmación interactiva en Slack (Block Kit buttons).
- Migrar HTTP MCPs a `.mcp.json` con `${ENV}` (sigue funcionando el load actual desde `.credentials.json`).
- Audit log completo de tool_use en Firestore (usuario eligió persistencia mínima).
- Override de modelo por prefijo (`sonnet:` / `haiku:`).
- Tipado estricto de eventos Bolt + SDK (cleanup de `as any`).

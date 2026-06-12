# Renovar la autenticación de NotebookLM en la VM

El bot usa el CLI `nlm` (NotebookLM) vía stdio MCP. Su autenticación son cookies de
sesión de Google que viven en `~/.notebooklm-mcp-cli/profiles/default/`:

- `cookies.json` — las ~42 cookies de la sesión (login completo ≈ 17 KB)
- `metadata.json` — `csrf_token`, `session_id`, `email`, `build_label`, `last_validated`

`nlm login` solo puede correr en una máquina con navegador (abre Chrome vía DevTools
Protocol), así que **no se puede autenticar headless en la VM**. El flujo es renovar
en local y copiar los archivos a la VM.

## Señal de que hace falta renovar

En la VM, una sesión incompleta/expirada se ve así (campos en `null`, archivo chico):

```json
// metadata.json — MAL
{ "csrf_token": null, "session_id": null, "email": null, "build_label": null, ... }
```

Una sesión buena trae todos los campos llenos y `cookies.json` pesa ~17 KB.

## Procedimiento

1. **En local**, renovar la sesión (abre Chrome para el sign-in):

   ```bash
   nlm login
   ```

   Guarda en `~/.notebooklm-mcp-cli/profiles/default/`.

2. **Copiar a la VM** (instancia `claude-slack-bot`, zona `us-central1-a`):

   ```bash
   gcloud compute scp \
     ~/.notebooklm-mcp-cli/profiles/default/cookies.json \
     ~/.notebooklm-mcp-cli/profiles/default/metadata.json \
     claude-slack-bot:~/.notebooklm-mcp-cli/profiles/default/ \
     --zone=us-central1-a
   ```

3. **En la VM**, fijar permisos y reiniciar el bot:

   ```bash
   gcloud compute ssh claude-slack-bot --zone=us-central1-a --command='
     chmod 600 ~/.notebooklm-mcp-cli/profiles/default/cookies.json \
               ~/.notebooklm-mcp-cli/profiles/default/metadata.json
     sudo systemctl restart claude-slack-bot
   '
   ```

## Notas

- `nlm` no tiene un comando de "auth status". `nlm status` solo cubre `artifacts` y
  `research` (status de recursos, no de la sesión). La verificación real es la próxima
  query de NotebookLM desde el bot.
- Mismo patrón que las credenciales OAuth de `~/.claude/.credentials.json`: se renuevan
  en local y se copian con `gcloud compute scp` (ver CLAUDE.md → MCP Servers).

# Autenticar Jira/Confluence (`acli`) en la VM

El bot accede a Jira y Confluence por el CLI oficial de Atlassian `acli` (no MCP).
La auth es un **API token** de Atlassian, headless (sin navegador) y persistente en
disco — a diferencia del viejo plugin OAuth, que se vaciaba sin auto-refresh y dejaba
al bot sin acceso a Jira.

- Binario: `~/.local/bin/acli` (en el PATH del servicio systemd)
- Sitio: `myncreations.atlassian.net`
- Credenciales de re-login respaldadas en `.env` (`ATLASSIAN_SITE`, `ATLASSIAN_EMAIL`,
  `ATLASSIAN_API_TOKEN`)

## Señal de que hace falta renovar

Una llamada a Jira desde el bot falla con 401/Unauthorized, o:

```bash
acli jira auth status   # → "Not authenticated" o error
```

Causa típica: el API token fue revocado o regenerado en Atlassian.

## Procedimiento (todo headless en la VM)

1. **Generar un API token** en https://id.atlassian.com/manage-profile/security/api-tokens
   (con la cuenta `nicolas.caicedo1799@gmail.com`).

2. **Actualizar el token** en el `.env` de la VM (`ATLASSIAN_API_TOKEN=...`).

3. **Re-loguear** leyendo el token del `.env` (no se expone en el process list):

   ```bash
   gcloud compute ssh claude-slack-bot --zone=us-central1-a --command='
     cd ~/claude-slack-bot
     set -a; . ./.env; set +a
     printf %s "$ATLASSIAN_API_TOKEN" | ~/.local/bin/acli jira auth login \
       --site "$ATLASSIAN_SITE" --email "$ATLASSIAN_EMAIL" --token
     ~/.local/bin/acli jira auth status
   '
   ```

   No hace falta reiniciar el bot: `acli` guarda la sesión en disco y el bot la usa
   en la próxima query.

## Instalar/actualizar el binario

```bash
curl -fsSL -o ~/.local/bin/acli \
  "https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli"
chmod +x ~/.local/bin/acli
acli --version
```

## Notas

- El bot invoca `acli` por Bash. Comandos: `acli jira workitem search --jql "..."`,
  `view <KEY>`, `create --project <KEY> --type <Tipo> --summary "..."`,
  `transition --key <KEY> --status "..."`, `comment --key <KEY> --body "..."`.
  Agregar `--json` donde exista para parsear la salida en vez de la tabla ANSI.
- Proyectos visibles: `GDT`, `LEG`, `QUOTE`. El acceso depende de los permisos de la
  cuenta del token en Atlassian.
- Mismo patrón que Notion (`ntn`): CLI headless con token en `.env`, sin el OAuth-refresh
  que sufrían los MCP por plugin (ver CLAUDE.md → MCP Servers).

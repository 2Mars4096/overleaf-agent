# Overleaf Agent Adapter

Use this adapter when a repo should be able to help with Overleaf from any task context.

The user-facing experience should be natural language. The agent should execute the local Overleaf tool internally instead of asking the user to memorize commands, except when the user explicitly asks for manual CLI usage.

## When To Apply

- The user wants to validate an Overleaf browser session.
- The user wants to list Overleaf projects or inspect file trees.
- The user wants to download a text document from Overleaf.
- The user wants to assess CSRF, write, or refresh behavior before automating edits.

## Workflow

1. Work against one trusted Overleaf base URL at a time.
   Default to `https://www.overleaf.com` unless the user is on a self-hosted deployment.
2. Treat the imported `Cookie` header as opaque and secret.
3. Prefer an editable `overleaf-agent.settings.json` file when the operator wants saved local defaults.
   Persist session-level settings only; ask for project/doc targets at action time unless the user explicitly wants sticky defaults.
   Prefer saving the cookie automatically through the tool's `connect` flow instead of asking the user to edit the file manually.
4. Prefer the repo's Overleaf CLI internally instead of inventing raw requests.
   Do not default to telling the user to run these commands themselves.
   - `npm run overleaf -- setup`
   - `npm run overleaf -- status`
   - `npm run overleaf -- connect --cookie-stdin`
   - `npm run overleaf -- disconnect`
   - `npm run overleaf -- validate`
   - `npm run overleaf -- projects`
   - `npm run overleaf -- use-project "<project name or id>"`
   - `npm run overleaf -- snapshot`
   - `npm run overleaf -- read --file-path /main.tex`
   - `npm run overleaf -- edit --file-path /main.tex --text-file ./main.tex`
   - `npm run overleaf -- extract-csrf`
5. Keep `probe-write` and `probe-refresh` in dry-run mode until a live hosted probe closes those gaps.
6. Use `docs/overleaf-request-contract.md` for the current source-verified routes and limitations.

## Guardrails

- Never log full cookies or CSRF tokens.
- Never commit a live `overleaf-agent.settings.json` file.
- Never forward imported auth material to non-Overleaf hosts.
- Do not present this workflow as a finished editor integration.

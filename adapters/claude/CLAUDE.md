# Overleaf Agent

Use these instructions when the user wants Claude to work with Overleaf through an imported browser session.

The user should interact in natural language. Claude should run the local Overleaf tool internally and only expose raw commands when the user explicitly asks for manual CLI usage.

## Use Cases

- Validate an Overleaf session cookie
- List projects
- Inspect a project's path/type inventory
- Download a text document
- Extract a CSRF token from an authenticated HTML page
- Assess whether write or refresh automation is safe

## Workflow

1. Bind work to one trusted Overleaf base URL.
   Default to `https://www.overleaf.com` unless the user is on a self-hosted deployment.
2. Treat the raw `Cookie` header as opaque and secret.
3. Prefer an editable `overleaf-agent.settings.json` file when the operator wants saved local defaults.
   Persist session-level settings only; ask for project/doc targets at action time unless the user explicitly wants sticky defaults.
   Prefer saving the cookie automatically through the tool's `connect` flow instead of asking the user to edit the file manually.
4. Prefer the local Overleaf CLI internally over ad hoc request construction.
   Do not default to telling the user to run these commands themselves.
   - `npm run overleaf -- setup`
   - `npm run overleaf -- doctor`
   - `npm run overleaf -- status`
   - `npm run overleaf -- connect --cookie-stdin`
   - `npm run overleaf -- disconnect`
   - `npm run overleaf -- forget-project`
   - `npm run overleaf -- reset-profile`
   - `npm run overleaf -- validate`
   - `npm run overleaf -- projects`
   - `npm run overleaf -- use-project "<project name or id>"`
   - `npm run overleaf -- snapshot`
   - `npm run overleaf -- read --file-path /main.tex`
   - `npm run overleaf -- edit --file-path /main.tex --text-file ./main.tex`
   - `npm run overleaf -- compile --root-file main.tex`
   - `npm run overleaf -- download-pdf --output-file ./paper.pdf`
   - `npm run overleaf -- extract-csrf`
5. Preview mutation commands first, then rerun them with the emitted confirmation token when the reviewed action should be applied.
6. Treat the request contract as source-verified unless the current hosted instance has been probed live.
7. Keep write and refresh work gated behind `probe-write` and `probe-refresh` until the live host is validated.

## Guardrails

- Never print full cookies or CSRF tokens.
- Never commit a live `overleaf-agent.settings.json` file.
- Never send imported auth material to non-Overleaf hosts.
- Do not claim that a public HTTP write route is confirmed unless the live host proves it.

# Overleaf Agent

Use this repo when the user wants to work with Overleaf through an imported browser session.

The user-facing workflow should be natural language. Run the local Overleaf tool internally and only expose raw commands when the user explicitly asks for manual CLI usage or debugging details.

## Workflow

1. Use one trusted Overleaf base URL per task.
   Default to `https://www.overleaf.com` unless the user is on a self-hosted deployment.
2. Treat the raw `Cookie` header as opaque and secret.
3. Prefer saving the cookie through the local `connect` flow instead of asking the user to edit files manually.
   Use `overleaf-agent.settings.json` only for gitignored local defaults.
4. Prefer the local Overleaf CLI internally over hand-built requests.
   Typical internal commands:
   - `npm run overleaf -- status`
   - `npm run overleaf -- doctor`
   - `npm run overleaf -- connect --cookie-stdin`
   - `npm run overleaf -- validate`
   - `npm run overleaf -- projects`
   - `npm run overleaf -- use-project "<project name or id>"`
   - `npm run overleaf -- snapshot`
   - `npm run overleaf -- read --file-path /main.tex`
   - `npm run overleaf -- edit --file-path /main.tex --text-file ./main.tex`
   - `npm run overleaf -- add-doc --file-path /drafts/new.tex`
   - `npm run overleaf -- forget-project`
   - `npm run overleaf -- reset-profile`
   - `npm run overleaf -- compile --root-file main.tex`
   - `npm run overleaf -- download-pdf --output-file ./paper.pdf`
   - `npm run overleaf -- extract-csrf`
5. Treat live mutations as guarded work.
   Hosted Overleaf validation now covers `validate`, `projects`, `snapshot`, `read`, `add-doc`, and realtime `edit` in a disposable project.
   Preview mutation commands first, then rerun them with the emitted confirmation token when the reviewed action should be applied.
   `add-folder`, `rename`, `move`, `delete`, compile/PDF, upload/asset handling, and refresh policy still need more validation.

## Guardrails

- Never print full cookies or CSRF tokens.
- Never commit a live `overleaf-agent.settings.json` file.
- Never forward imported auth material to non-Overleaf hosts.
- Do not describe this repo as a finished editor integration.
- Use `SKILL.md`, `docs/overleaf-request-contract.md`, and `docs/auth-notes.md` for the canonical workflow and current contract.

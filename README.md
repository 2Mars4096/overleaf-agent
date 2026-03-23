# Overleaf Agent Skill

Reusable Overleaf agent skill pack for Codex, Claude, Cursor, and similar assistants.

Convenience entrypoint:
- `npm run overleaf -- <command>`
- `npm run discovery -- <command>` still works as the backward-compatible alias

Intended UX:
- the user talks to the agent in natural language
- the agent stores the cookie once and runs the tool internally
- the manual commands below are fallback/debug details, not the primary interface

## What It Does

- validates imported Overleaf browser sessions
- lists projects and inspects project file trees
- fetches realtime project snapshots with entity ids
- downloads text documents
- extracts CSRF tokens from authenticated pages
- performs guarded text edits through Overleaf's realtime `applyOtUpdate` path
- performs guarded project mutations such as add, rename, move, and delete
- provides copyable adapter files for multiple agent hosts

## What It Is Not

- not a finished Cursor/VS Code extension
- not a live editor integration for arbitrary projects
- not a proof that public HTTP writes are safe on every hosted Overleaf instance

## Use It In Codex

- install or vendor this repo as a skill-capable folder
- use the root `SKILL.md` as the canonical instructions
- the root `AGENTS.md` is the repo-local Codex adapter for direct use of this repo
- for other repos, copy or adapt `adapters/codex/AGENTS.md`

## User-Editable Settings

- in the normal skill flow, the agent should save the cookie for the user with `connect`
- `overleaf-agent.settings.json` is the underlying local gitignored store the skill uses
- you can still edit that file manually if you want direct control
- keep that file local only; it is gitignored because it may contain live session secrets
- the CLI auto-loads `overleaf-agent.settings.json` or `.overleaf-agent.json` from the working directory
- you can also select a profile explicitly with `--profile <name>` or a config path with `--config <path>`
- hosted Overleaf defaults to `https://www.overleaf.com`; only override `baseUrl` for self-hosted instances
- `socketUrl` is optional and defaults to `<baseUrl>/socket.io`
- keep `sendMutations: false` until you are ready to test against a throwaway document
- use `--dry-run` when you want a preview without sending the current command
- `projectId` and document/file paths should usually be supplied per action after the user chooses a target project or document
- `npm run overleaf -- use-project <name-or-id>` can save one default project in the active profile so later commands can omit `--project-id`

Settings precedence:
- command-line flags
- environment variables
- selected settings profile
- top-level settings file defaults

## How To Retrieve The Session Cookie

Preferred method:
- open Overleaf in your browser while already signed in
- open Developer Tools
- go to the `Network` tab
- reload the page or click into a project
- click an authenticated request to the Overleaf host such as `/user/projects` or a project page request
- in the request headers, copy the full `Cookie` header value
- paste that full value into `cookieHeader` in `overleaf-agent.settings.json`

Why this method:
- it gives the exact cookie bundle the browser is really sending
- it avoids guessing a single cookie name
- it works better than manually copying individual cookies when multiple cookies are required

Alternative method:
- use the browser's Storage/Application/Cookies view for the Overleaf site
- copy the relevant cookies and join them into a single header string like `name1=value1; name2=value2`
- use this only if you cannot copy the request header directly

Safety notes:
- treat the cookie header like a password
- do not commit it
- do not paste it into logs, screenshots, or shared chat unless you intend to share account access

## Use It In Claude

- copy or merge `adapters/claude/CLAUDE.md` into your Claude project instructions
- keep `tools/overleaf-discovery.mjs` available in the workspace

## Use It In Cursor

- copy `adapters/cursor/overleaf-agent.mdc` into `.cursor/rules/` in the target project
- keep the repo or the discovery tool vendored where the rule can reference it

## Core Commands

```bash
npm run overleaf -- setup
npm run overleaf -- status
npm run overleaf -- connect --cookie-stdin
npm run overleaf -- disconnect
npm run overleaf -- validate --profile personal
npm run overleaf -- projects --profile personal
npm run overleaf -- use-project "My Paper"
npm run overleaf -- snapshot
npm run overleaf -- read --file-path /main.tex
npm run overleaf -- edit --file-path /main.tex --text-file ./main.tex
npm run overleaf -- add-doc --file-path /drafts/new.tex
npm run overleaf -- rename --file-path /drafts/new.tex --name draft.tex
npm run overleaf -- move --file-path /draft.tex --target-path /archive
npm run overleaf -- delete --file-path /archive/draft.tex
```

## Agent-Led Flow

The preferred skill experience is:
1. the user gives the agent the Overleaf cookie header once
2. the agent runs `connect` internally and stores it in the gitignored local settings
3. the user asks for project reads or edits in plain language
4. the agent handles validation, project selection, reads, and edits internally

## Manual Fallback

1. Run `npm run overleaf -- setup`.
2. Save auth with either:
   - `npm run overleaf -- connect --cookie '<full cookie header>'`
   - or `pbpaste | npm run overleaf -- connect --cookie-stdin` on macOS
3. Keep `sendMutations: false` for the first pass.
4. Run:
   - `npm run overleaf -- validate`
   - `npm run overleaf -- projects`
   - `npm run overleaf -- use-project "<project name or id>"`
   - `npm run overleaf -- snapshot`
   - `npm run overleaf -- read --file-path /main.tex`
5. Switch to a throwaway doc.
6. Run:
   - `npm run overleaf -- edit --file-path /main.tex --text-file ./main.tex --send`

## Repo Pointers

- `AGENTS.md`
- `SKILL.md`
- `adapters/`
- `tools/overleaf-discovery.mjs`
- `overleaf-agent.settings.example.json`
- `overleaf-agent.settings.schema.json`
- `docs/overleaf-request-contract.md`
- `docs/auth-notes.md`

## Scope Notes

- session validation, listing, realtime snapshots, HTTP doc reads, `add-doc`, and realtime text edits are now live-validated against hosted Overleaf in a disposable project
- `add-folder`, `rename`, `move`, `delete`, upload/asset workflows, and refresh/conflict hardening still need more live validation
- the hosted realtime path requires the handshake-time affinity cookie returned by Overleaf, so the socket shim now keeps an in-memory cookie jar for the polling session

---
name: overleaf-agent
description: Use when a user wants to work with Overleaf through an imported browser session cookie, validate auth or CSRF behavior, inspect project and file routes, download text documents, or package the workflow for Codex, Claude, Cursor, and similar agents. This skill uses the local discovery CLI and the source-verified request contract instead of guessing undocumented Overleaf endpoints.
---

# Overleaf Agent

The intended user experience is natural language, not command memorization.

When this skill is installed in a host that supports skills or repo instructions:
- the user should ask for Overleaf work in plain language
- the agent should run the local tool internally
- the user only needs to provide auth material once, usually by pasting the browser `Cookie` header to the agent
- the agent should save that cookie into the local gitignored settings automatically with the internal `connect` flow

Use this skill when the user wants to:
- validate an imported Overleaf session
- inspect project, file-tree, snapshot, or document-read routes
- edit text documents through Overleaf's realtime OT path
- create, rename, move, or delete project entries through guarded web routes
- extract a CSRF token from an authenticated page
- assess whether a write or refresh flow is safe to automate
- adapt the workflow for Codex, Claude, Cursor, or similar agent hosts

Do not present this as a full editor integration. The repo currently provides a reusable agent workflow and discovery CLI, not a finished Overleaf IDE plugin.

## Core Workflow

1. Establish the target host and auth material.
   - Work against one trusted Overleaf base URL at a time.
   - Default to `https://www.overleaf.com` unless the user is targeting a self-hosted deployment.
   - Treat the raw `Cookie` header as opaque.
   - Never print full cookies or CSRF tokens.
   - Prefer saving the cookie automatically into the local `overleaf-agent.settings.json` file through the tool's `connect` flow.
   - Mention manual config editing only as a fallback for users who explicitly want it.
   - Persist session-level settings only; ask for project/doc targets at action time unless the user explicitly wants sticky defaults.
   - If the user does not know how to get the cookie, tell them to copy the full `Cookie` request header from an authenticated Overleaf request in browser Developer Tools `Network`, not to guess a single cookie name.
   - Do not default to telling the user to run CLI commands themselves. The agent should handle the tool execution.

2. Start from the contract when routes are uncertain.
   - Run `npm run discovery -- contract`.
   - Read `docs/overleaf-request-contract.md` only when you need exact route, header, or limitation details.

3. Prefer the deterministic CLI over ad hoc request snippets, but keep it behind the agent.
   - The CLI auto-loads `overleaf-agent.settings.json` or `.overleaf-agent.json` from the current directory.
   - Use `--config <path>` for a custom settings file and `--profile <name>` for named profiles.
   - These commands are internal execution details for the agent.
   - Only show raw commands when the user explicitly asks for manual CLI usage or debugging details.
   - Normal agent flow:
     - if settings are missing, create them
     - if auth is missing, ask for the cookie once and run `connect`
     - validate the session
     - list/select a project
     - run read/snapshot/edit/mutation actions internally
   - Internal command examples:
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
     - `npm run overleaf -- add-doc --file-path /drafts/new.tex`
     - `npm run overleaf -- extract-csrf`

4. Treat live mutations as guarded work.
   - Keep `sendMutations: false` until the user points at a throwaway project or document.
   - For the first live write, use `edit`, `add-doc`, `rename`, `move`, or `delete` only after validating the session and confirming the target project id.
   - Use `--dry-run` only when the user explicitly wants a preview of the current command.
   - Do not claim that a public HTTP text-write route exists; the implemented text edit path is the realtime socket route.
   - Do not claim that polling-only refresh is safe unless the live host has been validated.
   - Upload and asset workflows remain future scope.
   - Hosted Overleaf validation now covers session validation, project listing, realtime snapshot, HTTP document reads, `add-doc`, and realtime `edit` in a disposable project.
   - `add-folder`, `rename`, `move`, `delete`, and refresh policy remain partially unvalidated and should still be treated as guarded work.

5. Reuse the packaged adapters instead of rewriting the workflow for each host.
   - Codex skill: use this `SKILL.md`.
   - Codex repo-local instructions: use `adapters/codex/AGENTS.md`.
   - Claude project instructions: use `adapters/claude/CLAUDE.md`.
   - Cursor rules: use `adapters/cursor/overleaf-agent.mdc`.

## References

- `docs/overleaf-request-contract.md`: source-verified request contract and current blockers
- `docs/auth-notes.md`: cookie, CSRF, trusted-host, and storage guidance
- `tools/overleaf-discovery.mjs`: executable request probe tool
- `tools/overleaf-realtime.mjs`: realtime socket helper for snapshot and edit commands
- `overleaf-agent.settings.example.json`: editable settings template

## Response Expectations

- Be explicit about what is source-verified versus live-instance-validated.
- Prefer handling the workflow directly instead of giving the user command lists.
- Prefer small runnable commands over large speculative code blocks only when manual CLI usage is explicitly requested.
- If the user asks whether they can edit Overleaf from another project, answer carefully:
  - yes for this reusable agent workflow once the skill or adapter is installed and a valid session cookie is configured
  - no for a full live editor integration, because that product does not exist in this repo yet

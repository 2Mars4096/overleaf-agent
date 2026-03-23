# Overleaf Request Contract

**Status:** source-verified on 2026-03-23 from public Overleaf upstream code, implemented locally in the discovery CLI, and partially live-validated on hosted Overleaf on 2026-03-23. Hosted validation now covers `GET /user/projects`, realtime project snapshot, HTTP doc download, disposable `POST /project/:id/doc`, and disposable realtime `applyOtUpdate`. `add-folder`, `rename`, `move`, `delete`, upload/asset handling, and refresh policy still need more live validation.

## Auth Prerequisites

- Treat the imported `Cookie` header as opaque.
- Overleaf Community Edition defaults to the signed session cookie name `overleaf.sid`.
- Hosted or legacy deployments may expose a different session cookie name in the browser, so the workflow should not hard-code the cookie key.
- The real-time service binds websocket sessions to the same signed session cookie used by the web app.
- Hosted Overleaf's realtime polling path also sets a handshake-time load-balancer cookie (observed: `GCLB`), and the client must resend it on later polling requests.
- Mutating web routes are CSRF-protected by default.
- The frontend sends the CSRF token in `X-Csrf-Token`.
- The CSRF token can be extracted from an authenticated HTML page via the `ol-csrfToken` meta tag.

## Required Hosts And Origins

- Use one trusted Overleaf web base URL per session bundle, for example `https://www.overleaf.com` or a self-hosted deployment origin.
- The public validation, project-list, file-tree, document-download, and CSRF-extraction probes all hang off that single base URL.
- The upstream realtime service is part of the same Overleaf deployment and authenticates with the same signed session cookie; do not forward imported session material to any third-party host.
- Treat any cross-origin websocket host as deployment-specific until a live hosted probe confirms it.

## Minimum Header Set

- For authenticated `GET` requests such as session validation, simple project listing, file-tree inventory, and document download:
  - required: `Cookie`
  - practical default: `Accept`
- For authenticated HTML fetches used to extract the CSRF token:
  - required: `Cookie`
  - practical default: `Accept: text/html,application/xhtml+xml`
- For authenticated web `POST` requests that mutate or request CSRF-protected JSON:
  - required: `Cookie`
  - required when protected: `X-Csrf-Token`
  - required for JSON payloads: `Content-Type: application/json`
- `Origin` and `Referer` are not source-verified as mandatory for the current public routes and should stay optional until a live hosted probe proves otherwise.

## Source-Verified Routes

### Session Validation

- `GET /user/projects`
- Purpose: lightweight login-protected JSON request to confirm the imported cookie reaches an authenticated project endpoint.

### Project List

- `GET /user/projects`
- Purpose: simple JSON list of accessible projects.

- `POST /api/project`
- Purpose: richer paginated project list with `filters`, `page`, and `sort`.
- Note: this route is CSRF-protected because it is a web `POST`.

### Project File Tree

- `GET /project/:Project_id/entities`
- Purpose: public cookie-auth route that returns path/type inventory only.
- Limitation: this does not expose entity ids or the nested `rootFolder` structure required for editor-style operations.

- `socket.io handshake with ?projectId=...`
- Purpose: the real-time service auto-joins the project and returns the richer project snapshot in `joinProjectResponse`.
- Note: this is where the upstream client gets `rootFolder`, nested folders, files, docs, and root doc ids.
- Hosted validation note: the polling session must keep the handshake-issued affinity cookie or the server responds with `client not handshaken`.

### Text Read

- `GET /Project/:Project_id/doc/:Doc_id/download`
- Purpose: public cookie-auth route that returns plain text for a document.

### Text Write

- No public cookie-auth HTTP text-write route was confirmed in the inspected upstream web router.
- The source-verified write flow is the real-time socket path:
  - connect to the real-time service with the signed session cookie and `projectId`
  - join the document
  - send `applyOtUpdate`
- The direct document text-write HTTP route exists only on the private API and is intended for internal service-to-service use.
- The local CLI now exposes this as `npm run discovery -- edit ...`.

### Version And Refresh Signals

- The real-time `joinDoc` flow exposes document `version`, ranges, and updates.
- The public doc download route does not expose equivalent version metadata.
- HTTP polling is still plausible for coarse content refresh by re-downloading document text, but it is not yet a verified substitute for the real-time versioned flow.

## MVP Implications

- Cookie-backed HTTP is enough for:
  - session validation
  - simple project listing
  - path/type inventory
  - plain-text document download

- Real-time socket validation is still needed for:
  - full project tree snapshot with entity ids
  - document writes
  - authoritative version tracking
  - confident remote-refresh and conflict handling

## Local Tooling

- Use `npm run discovery -- contract` to print the current source-verified contract.
- Use `npm run discovery -- validate --base-url <url> --cookie '<cookie>'` for the first live session check.
- Use `npm run discovery -- snapshot --base-url <url> --cookie '<cookie>' --project-id <id>` to recover the richer realtime project tree with ids.
- Use `npm run discovery -- read --base-url <url> --cookie '<cookie>' --project-id <id> --file-path /main.tex` when you want path-based doc reads without supplying raw doc ids.
- Use `npm run discovery -- edit --base-url <url> --cookie '<cookie>' --project-id <id> --file-path /main.tex --text-file ./main.tex --send` for the guarded realtime text-write flow.
- Use `npm run discovery -- add-doc`, `add-folder`, `rename`, `move`, and `delete` for guarded project mutations after validating a throwaway target.
- Use `npm run discovery -- extract-csrf --base-url <url> --cookie '<cookie>' --project-id <id>` to recover a live CSRF token from an authenticated HTML page.

## Remaining Live Checks

- Validate `add-folder`, `rename`, `move`, and `delete` against a disposable hosted project.
- Decide whether refresh can stay HTTP-polling-only, or whether the MVP must depend on the real-time socket path.
- Confirm how much of the same contract carries over to self-hosted Overleaf deployments.

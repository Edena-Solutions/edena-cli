---
name: edena
description: Work with Edena, the management platform for schools, nurseries and academies, through the `edena` CLI. Use it to look up or change an organization's students, families, staff, invoices, payments, attendance, timetables, communications and every other module, and to help integrate the Edena API into an app. Use when the user mentions Edena, asks about their school's or academy's data in any language, or wants to build against the Edena API.
---

# Edena CLI

`edena` runs every operation of the Edena API as a command: `edena <category> <action>`, such as `edena students list` or `edena invoices get <id>`. Commands, help and output are in English; answer the user in their own language.

## 1. Check the session first

1. `edena --version`. If it is missing: `npm install -g @edena-solutions/cli` (needs Node.js 20 or later).
2. `edena whoami --json`. It answers the organization, its `environment` (`sandbox` or `live`) and the key's role.
3. If it says "Not signed in", run `edena login`. It prints a link and a code: tell the user to open the link, check the code and approve it in the Edena console, then wait for the command to finish. Do not try to sign in any other way.
4. Signed in to more than one organization: `edena profiles --json` lists them, `edena use <profile>` switches.

## 2. Find the command, never guess it

- `edena docs search "<english keywords>" --json` finds the operations that match, best first. Turn the user's request into English keywords: "alumnos sin pagador" → `"students payers"`, "facturas pendientes" → `"unpaid invoices"`.
- `edena <category> <action> --help` shows its arguments, flags, body fields and what it answers.
- `edena docs show <category> <action>` adds every type it uses, as TypeScript.
- `edena categories --json` lists every category; `edena <category>` lists its actions.

## 3. Run it

- Always add `--json` and read the result as JSON.
- Path parameters go in order after the action: `edena students get <id>`.
- Query parameters and body fields are flags: `--status active`, `--name "Ana"`. A whole body: `--data '<json>'`, `--data @file.json` or `--data -` from stdin.
- Lists come in pages: `--all` fetches every page; `--page` and `--pageSize` pick one.
- A file answer (a PDF, a spreadsheet) needs `--output <file>`.
- Anything the commands do not cover: `edena api GET /path --query name=value`.

## 4. Changing data needs the user's yes

- Every write (create, update, delete, send, cancel) needs `--yes`. Before you run one, tell the user exactly what will change, in which organization and environment (from `whoami`), and wait for an explicit yes.
- In `live` the data is real: say so, and that families or staff may be notified. Never write in `live` just to try something; use the sandbox.
- For several changes, show the full list first and confirm it once.

## 5. When something fails

Errors come as JSON on stderr: `{ "error": { "status", "key", "message", "requestId" } }`. Exit codes: 2 the command was called wrong (read the message and `--help`), 3 not signed in or the key's role does not reach it, 4 not found, 5 conflict, 6 rate limited (wait a little and retry). Decide on `key`, and give the user the `requestId` if they need Edena's help.

## 6. Integrating the Edena API into an app

1. Find the categories involved with `edena docs search`.
2. `edena prompt <category>` prints the full specification of a category: the API's rules, every operation and every type. Read it and follow it; do not invent endpoints or fields.
3. `edena types <category>... > src/edena.types.ts` writes the TypeScript types to the project.
4. The key lives in the `EDENA_API_KEY` environment variable, on the server only. An app acting for its users in the browser uses end-user tokens: `edena docs show end-user-tokens issue`.
5. Build and test against the sandbox. To follow changes without polling, use webhooks: `edena webhook-events types --json` lists every event.

## 7. Developing webhooks and watching the API

- `edena listen --forward-to http://localhost:<port>/<path>` forwards the organization's events, as they happen, to the user's local server, signed like real webhooks. It runs until stopped, so start it in the background or ask the user to run it in another terminal; `edena listen --print-secret` gives the secret their server verifies `Edena-Signature` with.
- `edena trigger <type>` resends the latest real event of a type to that server, to test a handler without changing data.
- `edena logs --mine --json` follows the requests made with this terminal's key, to see what an integration is calling and what the API answered.
- `edena open <section>` opens the developer console (keys, webhooks, requests, docs…) for the user.

## 8. Answering

Answer in the user's language. Summarise what the commands returned (counts, names, totals) instead of pasting JSON, unless they ask for it, and say which organization and environment the data comes from.

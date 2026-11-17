# Edena CLI

`edena` runs every operation of the [Edena API](https://api.edena.es/openapi.json) as a command, for people and for coding agents (Claude Code, Codex, Gemini CLI).

```sh
npm install -g @edena/cli
edena login
edena students list --status active
```

Requires Node.js 20 or later. No runtime dependencies.

## Sign in

`edena login` prints a link and a code, and opens the browser. In the Edena console, an Admin Developer checks the code and approves it, choosing where the CLI works (the organization's sandbox, recommended, or its real data) and the role of its key. The terminal then receives an API key of its own, named after the machine, which shows up in the console's Keys and can be revoked there.

```sh
edena whoami                     # the organization and key in use
edena profiles                   # every organization this terminal is signed in to
edena use my-school-sandbox      # switch: a profile is named after its organization's slug
edena logout                     # revoke this terminal's key and forget it
```

Signing in to the sandbox and to the real data gives two profiles (`my-school-sandbox` and `my-school`); `edena use` or `--profile` picks one.

`EDENA_API_KEY` overrides the session (CI, scripts). `EDENA_API_URL` points the CLI at another API, such as `http://localhost:8080` while developing Edena itself.

## Commands

Every API operation is `edena <category> <action>`, named after the reference: `edena students list`, `edena invoices get <id>`, `edena clocking void-break <id> <breakId>`. The commands come from the API's public reference (cached for a day), so new endpoints appear without updating the CLI.

```sh
edena categories                       # every category
edena students                         # its actions
edena students list --help             # arguments, flags, body fields and answer
edena docs search "unpaid invoices"    # find a command in plain words
edena docs show students create        # one operation with all its types

edena students get 0190f3a2-…                       # path parameters in order
edena students list --status active --all           # query flags; --all follows every page
edena students create --name Ana --surname1 Pérez   # a flag per body field
edena students create --data @student.json          # or the whole body (also --data '<json>' or --data -)
edena invoices pdf <id> --output invoice.pdf        # files
edena api GET /clients --query status=active        # any request
```

Output is a table in a terminal and JSON when piped or with `--json`. Writes ask for confirmation; without a terminal (an agent, a script) they need `--yes`. Every write carries an `Idempotency-Key`, reused on retries, and 429 and 5xx answers are retried with backoff.

Exit codes: `0` done, `1` failed, `2` called wrong, `3` not signed in or not allowed, `4` not found, `5` conflict, `6` rate limited. Errors carry the API's stable `key` and its `requestId`.

## Developing locally

```sh
edena listen --forward-to http://localhost:3000/webhooks   # events as they happen, to your local server
edena listen --events "client.*,invoice.updated" --since 1h # some types, replaying the last hour first
edena trigger client.updated                                # resend the latest real one to that server
edena trigger --event 019a8c5e-…                            # or a given event
edena logs --mine                                           # the API's requests as they happen
edena open webhooks                                         # the console, in the browser
```

`listen` needs no public address: it follows `GET /webhook-events/stream` and posts each event to your server exactly as an endpoint receives it, the same body and the same `Edena-Signature`, signed with a secret of this machine (`edena listen --print-secret`). Verify it in your server as you would an endpoint's. It reconnects on its own and resumes from the last event.

## Building with the API

```sh
edena prompt invoices > invoices.md     # a full spec of a category, for a coding agent
edena types invoices students > src/edena.types.ts
```

## Coding agents

```sh
edena skill install                     # Claude Code, Codex and Gemini CLI found on this machine
edena skill install --agent claude      # or one of them; --project writes it in the current project
edena skill show                        # the skill itself
```

The skill ([`skill/SKILL.md`](skill/SKILL.md), in the open Agent Skills format) teaches the agent to check the session, find commands with `docs search` instead of guessing, run them with `--json`, ask before any write, and integrate the API with `prompt` and `types`. Then ask in your own words: "how many active students have no payer?".

## Development

```sh
npm install
npm test            # builds, then runs the unit tests and an end-to-end run against a fake API
node dist/src/cli.js --help
```

`EDENA_REFERENCE_FILE=path/to/openapi.json` reads the reference from disk; `EDENA_CONFIG_DIR` and `EDENA_CACHE_DIR` move the config and the cache.

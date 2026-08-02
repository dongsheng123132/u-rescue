# U-Rescue · Case Library for Broken AI Coding Tools

> A curated, verifiable case library of environment failures for AI coding tools
> (Codex, Claude Code, and friends) — **symptom → mechanism → reversible fix → verification**.
> If it can't be verified on a real machine, it doesn't ship as `field` evidence.

When AI coding tools fail in the real world, the culprit is usually not the model —
it's the environment: proxies, antivirus, `PATH`, non-ASCII user directories, npm
mirrors, WSL. Those traps are scattered across tens of thousands of GitHub issues
and stale blog posts. This library collects them into structured, machine-readable
cases.

**19 cases so far.** Every case carries an evidence grade — *we verified it on a
real machine* and *it's just an upstream issue record* are **two different things**
here, and we never sell them as the same.

[简体中文](./README.md) · **English**

---

## Quick start (read-only, never touches your machine)

```bash
# Read-only health check: which known issues does this machine hit?
npx u-rescue doctor

# Paste the raw error message and search
npx u-rescue search "self-signed certificate detected"

# Show the full fix for one case
npx u-rescue show codex.proxy.localhost-elevated-sandbox

# Pull the latest case database (cases update continuously; your install is a snapshot)
npx u-rescue update

# For scripts / AI agents
npx u-rescue doctor --json
```

Requires Node 18+. **This tool only diagnoses — it never executes fixes for you.**
Steps are printed for you to read and run yourself.

> [!NOTE]
> **About auto-update.** The case database keeps growing, so `search` quietly
> refreshes when the local copy is older than 7 days (**hard 4-second timeout** —
> if the fetch fails it silently falls back to the bundled cases, never blocks).
> `--fresh` forces a refresh, `--offline` disables networking entirely.
>
> **`doctor` never auto-connects to the network.** That command exists for the
> "machine is already broken" scenario — the network itself may be the disease.
> Hanging on it would destroy the one tool that still works. It tells you how
> stale the bundled database is instead.
>
> Downloaded data re-passes the probe whitelist and `SAFE_BINS` checks. Any
> violation rejects the **entire package** and falls back to the bundled copy.
> Even a poisoned remote or a hijacked operator can only produce a wrong
> suggestion — never arbitrary command execution. Three smoke tests guard this.

Web version (no CLI needed): <https://u-claw.org.cn/rescue/>

---

## How cases get in (collection pipeline)

```
GitHub (openai/codex)           ─┐
GitHub (anthropics/claude-code)  ├─→ harvest ─→ inbox/ drafts ─→ human: solve + verify ─→ cases/
Our own client machines (redacted) ┘                          ↑ this step cannot be automated
```

```bash
npm run harvest                              # collect candidates from upstream issues
npm run harvest -- --source codex --limit 30
```

**Harvesting never writes directly into the case library.** A scraped issue
usually has a symptom but no verified fix — publishing it as a case sends users
into a dead end, which is *worse than not having the case at all*. A draft must
have its mechanism and fix filled in and verified by a human before it moves into
`cases/`. Drafts without a solution stay in `inbox/`.

The classifier prefers missing over false positives: strong signals (error codes,
`command not found`, "can't install") admit on a single hit; weak signals need two;
feature-request-shaped titles are excluded. In practice: 25 upstream issues → 2 cases.

Deduplication relies on `aliases` (like `codex#30538`); CI rejects duplicates.
Without it, the same issue would be re-harvested as a new case every run.

---

## Why you can trust this library

Libraries like this tend to become "a pile of plausible but unverified folk
remedies." Four hard constraints keep that from happening:

**① Verified vs. heard-somewhere is an explicit field.**
Every case has an `evidence` grade: `field` (we verified it on a real machine) /
`reproduced` (we reproduced it) / `upstream-issue` (recorded upstream, not
reproduced by us) / `reported` (just reported by someone). It is surfaced in the
web pages and the AI skill. **If we haven't verified it, we say so.**

**② Fixes expire, so every case carries a verification date.**
Cases not re-checked for 180+ days are automatically downgraded to
"read for reference, don't run blindly" in the web pages and the AI skill.
Upstream changes daily; a command from a year ago may now do harm.

**③ Diagnosis is read-only and never fortune-tells.**
The first version of this library flagged 16 of 18 cases as "highly suspected" —
because every probe was a precondition ("is this Windows?", "is npm installed?")
that holds on every machine. **All alarms = no alarm.** Probes are now split into
`precondition` and `evidence`, and only evidence may conclude anything. If we
can't produce discriminating evidence, the case honestly says "findable only by
searching the error text", and the health check reports exactly how many cases it
can and cannot detect.

**④ Every machine-modifying step must carry a rollback.**
Enforced by CI. A PR with a `risk` level but no `rollback` fails.

**⑤ False positives are admitted.**
Any case with probes must document `falsepositives` (borrowed from
[SigmaHQ/sigma](https://github.com/SigmaHQ/sigma)): when would this fire on a
healthy machine? Probes will always light up somewhere they shouldn't — the only
difference is whether you admit it. **This field only grows — every false alarm
adds one entry. It's the fastest-appreciating part of this library.**

**⑥ Differential diagnosis.**
Cases with similar symptoms link to each other, stating exactly how they differ
and which observation cuts through at once. When a user sees "can't connect" they
can't tell proxy, certificate, or endpoint incompatibility apart — this section
does it for them. Anyone can copy a case; the differential relationships grow
quadratically with scale and can't be copied.

One more boundary on security: **probes never accept executable content.** Case
JSON may only use whitelisted probe kinds; `cmd_ok` executable names must hit
`SAFE_BINS`. Even if this repository is poisoned, the worst outcome is one wrong
suggestion — never arbitrary command execution.

---

## Contributing a case

A case is a single JSON file under `cases/<tool>/`. No build step, no dependencies.

```bash
git clone https://github.com/dongsheng123132/u-rescue
cd u-rescue
cp cases/codex/update-eperm-leftover.json cases/codex/my-new-case.json
# edit, then validate
node scripts/validate.mjs
```

Validation checks: legal fields, unique IDs, rollback for every non-read-only
step, probes on the whitelist, `auto: true` cases point at a real action, and
field-verified claims describe the environment they were verified on.

**What we want most is not "another error report" — it's the root cause and a
verified fix for that error.** Error reports without fixes are welcome as issues,
but they don't enter the case library directly.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and
[docs/SPEC.md](docs/SPEC.md) (full spec: field definitions, collection pipeline,
integration, ad boundary).

---

## Built on the shoulders of

| Project | What we borrowed |
|---|---|
| [SigmaHQ/sigma](https://github.com/SigmaHQ/sigma) | `falsepositives` field; one rule compiled to multiple backends |
| [rustsec/advisory-db](https://github.com/rustsec/advisory-db) | `aliases` cross-references; one case per file + CI validation + PR intake |
| [google/osv.dev](https://github.com/google/osv.dev) | multi-source ingestion → normalization → human review |
| [github/advisory-database](https://github.com/github/advisory-database) | "auto-collect + human review" two-stage pipeline |

Not borrowed: sequential numeric IDs (we want URL-friendly ones), YAML (JSON is
easier for frontends and AIs), and any form of "client silently fetches and
executes remote rules."

---

## Generated artifacts

One case JSON produces four outputs — edit once, all four stay in sync:

| Command | Artifact | For |
|---|---|---|
| `npm run build:site` | `dist/site/` static web pages + `sitemap.xml` + `cases.json` | End users (search / AI-answer traffic) |
| `npm run build:skill` | `dist/skill/SKILL.md` + `AGENTS.md` + `manifest.json` | Installing into Claude Code / Codex, or skill marketplaces |
| `npm run build:uking` | `dist/uking/` hot-deploy JSON (two formats) | U-King GUI edition |
| `npx u-rescue` | Read-only CLI diagnostics | Developers, remote triage, AI agents |

Pages carry JSON-LD structured data (`TechArticle` + `Question/Answer`) so search
engines and AI assistants can cite them directly — because people who hit a
problem ask an AI, they don't browse GitHub.

---

## Project status & expectations

**This is first and foremost a rule library we maintain for ourselves; it's
public because publishing costs nothing and helps people.**

- We do **not** promise response times, merging your PR, or a roadmap.
- Valuable cases get merged. Unclear or unverified ones get asked to be improved;
  if they can't be, they stay in the issue tracker.
- If it goes quiet for a long stretch, it's just quiet — the verification dates
  on the cases tell you so honestly, no need to guess from commit history.

Stating this plainly prevents anyone from expecting "filed an issue, so someone
owns it."

---

## About U-King

This case library is open source, free, and independent of any commercial
product — clone it and use it anywhere.

If you'd rather not fix things case by case, [U-King](https://u-king.org) is our
GUI edition: one-click installs of Claude Code / Codex with most of these traps
already worked around in the installer, plus one-click health checks when things
break. Anything U-King can do for you is written in the case's `uking` field —
you can tell at a glance which case is advertising.

**Not using U-King doesn't affect this library at all** — `npx u-rescue` above is
the complete feature set, nothing crippled.

---

## License

Apache-2.0. Case content and code. Fork it, use it, build your own product on it.

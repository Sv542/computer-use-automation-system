# Evidence index

All records are synthetic. Screenshots are masked using the capability's `redactSelectors`; JSONL is passed through the evidence redactor; typed outputs remain in memory and are redacted in persisted result files.

- `artifacts/lookup-member-balance.v1.json` - capability emitted by the discovery run.
- `runs/discovery-live/` - observe/decide/act discovery events and masked success screenshot. Check `run_started.payload.provider` and artifact provenance to distinguish a genuine `groq-chat-completions`/`codex-cli`/`openai-responses` run from the explicitly labeled `scripted-offline` fixture.
- `runs/replay-success/` - deterministic happy path with a typed money output.
- `runs/replay-not-found/` - expected `MEMBER_NOT_FOUND` business outcome.
- `runs/replay-recovered-session/` - bounded recovery from a known session-expiry dialog.
- `runs/replay-permission-denied/` - hard application failure with a masked screenshot.
- `runs/replay-human-handoff/` - intervention request, automation-to-operator lease transfer, captured operator action, and return to automation in the same browser page.

Regenerate offline with `npm run evidence`. Generate the required genuine model run with Groq:

```bash
EVIDENCE_DISCOVERY_PROVIDER=groq GROQ_API_KEY=... npm run evidence
```

or with Codex CLI:

```bash
EVIDENCE_DISCOVERY_PROVIDER=codex CODEX_BIN=codex npm run evidence
```

or:

```bash
EVIDENCE_DISCOVERY_PROVIDER=openai OPENAI_API_KEY=... npm run evidence
```

To preserve an existing genuine discovery artifact/log while regenerating only the deterministic replay cases, use `EVIDENCE_REUSE_ARTIFACT=1 npm run evidence`.

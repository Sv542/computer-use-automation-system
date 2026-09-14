# 1. Architecture

The implementation is a single-process vertical slice with explicit ports instead of premature services. `DiscoveryAgent` owns the model-driven observe-decide-act loop. A `ModelProvider` supplies one structured decision at a time; the repository includes OpenAI Responses, Codex CLI, and an explicitly labeled scripted test provider. `WebSurface` owns perception and interaction. `PolicyGuard` authorizes the intended action against the actual target frame URL before execution. `EvidenceRecorder` stores sanitized decisions and results, not raw model transcripts. On success, discovery returns a `CapabilityArtifact` that is independent of the provider conversation.

`DeterministicReplayer` is a separate production path. It accepts only an artifact, invocation inputs, a surface adapter, evidence, and a handoff coordinator. It has no `ModelProvider` field or import, making the no-model boundary structural rather than a prompt convention. The replay state machine executes the ordered steps, evaluates exception rules after state-changing actions, verifies the final checkpoint, and returns a discriminated result.

The local Meridian Core target is intentionally inconvenient: an HTML frameset, table layout, no test IDs, and runtime states that mimic common back-office behavior. It is still a browser surface, but frame-aware accessibility semantics and ordered fallbacks exercise the same concerns as an older enterprise application without automating a third-party site.

The trade-off is deployment simplicity over distributed durability. A production system would place runs on a durable queue and store leases/evidence transactionally. Keeping those behind clear interfaces demonstrates the control model without pretending that queue plumbing is the difficult part of this assignment.

# 2. Artifact schema

The artifact is both an agent-callable contract and an executable plan. `schemaVersion` governs the serialization format; capability `version` governs behavior. The capability header includes an approval state so a later catalog can distinguish a draft discovery from an approved production capability. `contract` declares required typed inputs, typed outputs, and named business outcomes. A `money` extraction returns `{currency, amountMinor}` to avoid floating-point ambiguity. Input values are stored as parameter expressions, never copied as literals.

Each step has an ID, human description, typed action, risk, timeout, and bounded retry. Element targeting is a bundle rather than a single selector: a semantic role/name or label is primary, then human-readable or structural fallbacks are tried in order. Replay requires exactly one visible match; ambiguity is a failure, not permission to click the first result. The recorder enriches model-selected targets with fallback and element fingerprint metadata after resolving the live control. The checkpoint is explicit and independent of the last action.

`exceptionRules` are data, not hidden branches in replay code. A rule declares its detection condition, classification, stable code, message, and optionally bounded recovery actions. This keeps the flow reviewable and makes expected application states portable with the capability. `compatibility` identifies the vendor product, tested versions, and UI fingerprint. Optional tenant overrides replace an entrypoint or one step's locator bundle without cloning the base artifact. Provenance records the source run, provider, and model while excluding raw conversation and sensitive data.

JSON Schema validation occurs before replay and before saving a discovered artifact. Schema v1 is a web profile, but semantic locator strategies already map to accessibility concepts. A future desktop profile would add a surface discriminator and window/control locator without changing the replay result or action/checkpoint contracts.

# 3. Determinism & error handling

Replay has no model object and performs the same ordered operations for the same artifact and inputs. It validates inputs, specializes only declared tenant overrides, opens the recorded entrypoint, policy-checks each target context, resolves a unique visible control, applies fixed timeouts/retries, parses declared outputs, and asserts the checkpoint. A short settle window accounts for frame navigation without making a new decision. The UI may be asynchronous, but decision-making is not.

Failures are deliberately separated:

- A business outcome, such as `MEMBER_NOT_FOUND`, returns `status: business_outcome` with a stable code. It is not retried and is not a crash.
- A recoverable condition, such as session expiry, runs only the artifact's allowlisted recovery actions and only up to `maxRecoveries`.
- A human-required condition transfers the same live session to the operator and resumes only after the blocking detector clears.
- A hard application condition, such as permission denial, stops with step, expected state, observed rule, retryability, and a masked screenshot reference.
- An unknown locator or postcondition failure uses bounded step retry. With `--handoff-on-failure`, the live session is offered to a human before one final attempt; otherwise it returns a debuggable hard failure.

UI drift is secondary here but handled conservatively: ordered locator fallback tolerates a changed semantic attribute, while unique-match enforcement prevents a weak fallback from silently acting on the wrong control. Compatibility fingerprints and multi-run stability should gate promotion in production; they are recorded but not yet used as an approval service.

# 4. Heterogeneity & multi-tenant

The important seam is `Surface`: observe current state, resolve a logical target, execute a typed action, evaluate a condition, and produce masked evidence. Playwright implements that seam for browsers and crosses frames explicitly. A legacy browser adapter could replace DOM queries with the accessibility tree or screenshot/OCR coordinates. A desktop adapter could use Windows UI Automation, macOS Accessibility, or a remote-desktop CUA backend. The discovery recorder and replayer would still consume the same actions, conditions, risks, and result taxonomy; only locator variants and context resolution would expand.

Artifacts are owned at the vendor-product/version level, not copied per institution. Tenant configuration supplies the entrypoint and policy boundary. Where branding or configuration changes controls, a tenant override can replace the locator bundle for a named step while inheriting contract, outcomes, and replay logic. At scale I would compute a privacy-safe UI fingerprint at session start, compare it with approved compatibility cohorts, canary a capability across representative tenants, and track pass rate by vendor/version/tenant. Unknown fingerprints would disable unattended replay or route to discovery/human review rather than mutate the shared artifact automatically.

# 5. Escalation & handoff

`HandoffCoordinator` owns a control lease with controller (`automation` or `operator`) and monotonically increasing epoch. Discovery can explicitly escalate; replay automatically escalates for `human_required`, for policy-gated irreversible actions, or optionally after an unexpected stuck step. The intervention request includes run/capability/step, reason, timestamp, lease epoch, and masked screenshot.

The browser is not closed or recreated. In manual mode it is already headed; automation pauses while the operator interacts with that exact page and browser context, then the operator signals resume in the terminal. Event listeners capture click/change/input metadata during the lease while redacting entered values. When control returns, replay records the transfer and re-evaluates the blocker before continuing. The evidence pack demonstrates the operator clearing a verification dialog and replay extracting the output afterward in the same frame session.

A production operator console would authenticate the operator, persist leases with compare-and-swap semantics, stream the session through a secure co-browsing channel, support reject/abort as explicit dispositions, and recover leases after worker failure. The current terminal signal is a minimal real handoff, not a claim to be that console.

# 6. Safety

The policy is deny-by-default along three dimensions: allowed origins, route regexes, and action kinds. Authorization uses the resolved frame's URL, preventing an allowlisted top page from smuggling interaction into an untrusted embedded origin. Target text is checked against configurable risky patterns, and either an explicit irreversible risk or a risky target requires human approval; a `block` policy is also supported. Model suggestions are never executed before policy checks, and recovery actions pass through the same guard.

Artifacts contain parameter references instead of invocation values. Secrets remain environment-only. Observations redact configured sensitive DOM nodes plus common identifiers, amounts, email addresses, SSNs, and secret patterns before persistence. Evidence redaction applies to whole sensitive subtrees, so structured money values cannot bypass string masking. Screenshots mask inputs and configured sensitive controls. The optional OpenAI provider explicitly sends `store: false`; regulated deployment still requires an approved private endpoint, tenant isolation, encryption, access controls, and a verified retention policy. Deterministic replay avoids that model disclosure entirely.

The limits are explicit: regex redaction is defense in depth, not a DLP system; policy patterns require product-specific review; and the demo's terminal resume does not authenticate an operator. Those are deployment controls, not safe assumptions to bury.

# 7. Cuts

I deliberately did not build queues, a database, a production operator console, desktop automation, visual OCR targeting, or a tenant management service. The approval field and compatibility fingerprint are represented but there is no promotion UI, confidence scorer, or automatic drift gate. Evidence is local filesystem storage rather than encrypted object storage. The OpenAI provider uses direct Responses API calls to keep the dependency surface small, and the demo implements one read-oriented capability rather than many workflows.

Next I would add, in order: (1) signed artifact promotion with reviewer identity and stability thresholds; (2) durable run/lease persistence plus authenticated operator accept/reject/abort; (3) encrypted evidence storage with field-level retention and audited access; (4) compatibility fingerprint checks and canary replay across tenant cohorts; and (5) a second surface adapter using OS accessibility to prove the schema extension. I would add screenshot/coordinate fallback only after measuring where accessibility targeting fails, because weaker targeting expands both reliability and safety risk.

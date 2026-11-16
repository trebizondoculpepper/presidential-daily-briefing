# Formal rules comprehension: bounded experiment proposal (#579)

Prepared 2026-11-15. This is a design and credential-free preparation result, not a model evaluation. No paid calls were made. References #78 and #496 provide research context; #578 studies narration rather than predicting decisions from formal inputs. Existing trial budgets are not reused.

The question is whether an inexpensive model can predict the pure PDB engine's actions, ordering, rule identifiers and evidence from the complete formal policy and fact input, without English rule translations. It does not test operational compliance, live GitHub behavior, or an agent's willingness to follow instructions.

## Frozen inputs and oracle

Run from the repository root:

```sh
npx tsx scripts/formal-comprehension.ts prepare reports/formal-comprehension
npm run test:manual:formal
npx tsx scripts/formal-comprehension.ts score reports/formal-comprehension responses.json
```

The exhaustive validation is **manual and local only**. Run `npm run test:manual:formal` when designing/changing the engine's formal representation, editing the experiment preparation/scoring helper, or regenerating experiment inputs after relevant policy changes. It replays the native scenarios against both policy forms and compiles an engine bundle, so it is deliberately outside `npm test` and all CI jobs. It uses `vite.manual.config.ts` to select `formal-comprehension.manual.ts`; the ordinary test globs select only `*.test.ts`. It makes no model or GitHub calls. This check does not replace the normal rules-only tests, product tests or package checks in CI.

The preparation directory must be new. It contains `manifest.json`, evaluator-only `oracle.json`, and twelve `model-input/cNN.json` files. Send only the `prompt` string to a model. Never send the manifest, source fixture names, development/held-out split or oracle. Responses are a JSON array of `{ "caseId": "c01", "raw": "<unmodified response text>" }` objects; keep repetitions in separate response files. Supply every frozen case exactly once; use an empty raw string for a failed attempt so it remains in the denominator.

The helper uses TypeScript on the project's supported Node 26 runtime and existing dependencies; it supports the project's macOS, Linux and Windows environments. It invokes the locally installed TypeScript compiler without a shell. No network, provider SDK, credentials or live repository input is involved. Generated outputs are ignored research artifacts under `reports/`, not application dependencies.

The complete policy is retained, including competing rules, overrides, ranking and witness bindings. Only human-facing lexicon explanations, decision `why` templates and denial descriptions are removed. The engine and hash implementation are supplied as JavaScript compiled with comments removed. DataScript and JavaScript semantics remain prerequisites for interpreting this representation; success or failure cannot isolate Datalog knowledge alone. No focused-rule arm is proposed until its complete dependency and competing-rule closure can be audited.

Before generating prompts, preparation checks every native scenario against its expected result and compares original versus projected policy decisions, bands, codes, witnesses, overrides, unlocks, ownership and denials. Differences abort preparation. English explanation rendering and the resulting projection hash are intentionally excluded from semantic parity.

The initial local preparation, based on source revision `da9dc1d`, verified 71 native scenarios. It recorded:

| Artifact             | SHA-256 / value                                                    |
| -------------------- | ------------------------------------------------------------------ |
| Rules hash           | `62fdc2f6976d89099a5819d5f13ed927919a6a791a128810ba90df4a723ca3b0` |
| Original policy file | `b36b2cb2033d4f29b6d8c2264e3a7df529be32bca4eb48ab1817d73cdaf754c4` |
| Formal projection    | `8ebf9ec3aa9b1775d73da88d80b8da32c770ee368582c3c9033c2a1b9ac40b29` |
| Compiled engine      | `cceb7d6f556d6747b166e1ef9803641708b58fe92a071d8fe2bedfa89527474b` |
| Compiled hash helper | `4e12ca85c627949f62ceef05e113b04291d84f61068cea6634be104e432a5af7` |
| Compiler             | TypeScript 7.0.2                                                   |

A later execution must freeze the actual checked-out commit, helper hash, dependency lock hash, generated manifest and each prompt hash; regenerate and explicitly review differences if any source changes. Do not silently reuse this table as proof of a different build.

## Cases and neutral response contract

Eight development cases cover addressed attention destinations, owned PR follow-up versus waiting checks, easy implementations, assessment boosts, design versus unknown benefit, ownership and blockers, allowed versus mismatched platforms, and missing native/label/closing evidence. Four held-out perturbations of an otherwise eligible subject remove label completeness, make it explicitly false, introduce conflicting complexity state, or require a mismatched platform. This provides near-misses and unknown-versus-false distinctions with small, auditable facts.

The held-out designation means withheld from prompt iteration, not unseen during model pretraining. These public fixtures and twelve examples cannot establish generalization or statistical significance. Freeze all twelve prompts before calls; do not tune on held-out responses. Any later prompt revision starts a separately identified experiment.

The prompt asks only to apply the enclosed formal program and policy to supplied facts and return the supplied JSON shape. Neutral case IDs carry no expected answer. Actions contain subject, kind, rule ID, evidence bindings and an explanation capped at 280 characters. Denials contain subject and rule ID. Explicit probes request whether selected completeness attributes are known and their values. An absent datom must remain distinguishable from a known false value. No correct actions, expected ordering or English teaching examples accompany the prompt.

## Candidate models and cost ceiling

The owner's approximate “Deep Seek Flash” name resolves to the documented request ID `deepseek-flash`, currently displayed as DeepSeek-V4.1-Flash-1017. Its advertised context is 1M tokens. Budget using peak cache-miss input **$0.30/M** and output **$1.20/M**, without cache or off-peak discounts. Recheck availability, version and rates immediately before any execution. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

A paper comparator is `gemini-2.5-flash-lite`, listed at standard paid text rates **$0.10/M input** and **$0.40/M output**. It is not included in the proposed call count; comparing providers requires a separately frozen adapter and budget. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).

Proposed first pilot: one provider, twelve cases, two repetitions, **24 attempted calls maximum**, serial execution, no automatic retries. Reserve **65,536 input tokens and 2,048 output tokens per attempt**. At the DeepSeek peak rates:

```text
24 × (65,536 × $0.30 + 2,048 × $1.20) / 1,000,000 = $0.5308416
Hard pre-tax usage ceiling: $0.60
```

Actual measured prompt sizes were 38,981–40,544 ASCII UTF-8 bytes, with a 2,048-unit wrapper reserve giving a largest reservation of 42,592. These are byte measurements, not provider tokenizer counts. Execution must first establish a conservative tokenizer plus request-wrapper bound below 65,536; if that cannot be established without spending, do not run. Do not assume ASCII byte accounting bounds an undocumented tokenizer. Provider usage and billing reconciliation remain authoritative. Taxes or account charges require separate handling; this is a usage-cost proposal, not permission to purchase credits.

Proposed request settings: `model: "deepseek-flash"`, `thinking: {type: "disabled"}`, `max_tokens: 2048`, `temperature: 0`, `stream: false`, `tool_choice: "none"`, no tools, and text response format. JSON mode is excluded because it changes the format-failure experiment. Temperature zero does not guarantee determinism. [DeepSeek request contract](https://api-docs.deepseek.com/api/create-chat-completion/).

## Scoring and interpretation

The offline scorer reports independent dimensions:

- JSON syntax and strict schema validity, including duplicate/case-ID rejection;
- action subject/kind precision and recall;
- exact full action order, separate from eligibility;
- rule-ID correctness and exact evidence bindings for predicted actions;
- denial precision and recall;
- known/unknown probe accuracy, independent of probe presentation order;
- unexpected implementation actions on denied subjects.

Invalid responses remain failures in the denominator; do not repair JSON or omit errors to improve accuracy. Missing actions affect recall even though per-action evidence scoring covers predicted actions. Report per-case and per-repetition results and raw numerators, rather than a single combined success number. Report truncations and malformed output separately; output-cap failures are not evidence of policy understanding.

Explanations are retained for manual review, not automatically judged by prose overlap. A reviewer who has the oracle assigns 0 for unsupported or contradictory claims, 1 for partly grounded reasoning with a material omission, or 2 for grounded reasoning consistent with the formal witnesses. Record reasons and uncertainty; this rubric is exploratory and must not be confused with blinded or independently replicated evaluation.

Distinguish compiler/scenario/schema adapter defects, incomplete supplied semantics, context overflow and provider failures from model decision errors. Stop and repair an infrastructure defect before interpreting accuracy; preserve the failed run and start a new version. This checks the normalized engine component, not adapter freshness or the live workflow authorization boundary.

## Execution decision and stop conditions

**Preparation is complete; paid execution is deferred.** A later owner decision must authorize up to $0.60 of usage and identify an existing provider account/credential. This ticket introduces no model client and spends none of that amount.

Before execution, verify provider model availability/version, current peak pricing, token accounting, output limits and remaining budget. Record UTC time, commit and artifact hashes, request parameters, provider request ID/model version, raw response, finish reason, latency, usage and cumulative reserved/actual cost. Store no credential in outputs. Use public synthetic facts only; allow no tools or writes.

Reserve the full maximum cost before each attempt, including failures and timeouts. Stop at 24 attempts, at the next reservation exceeding $0.60, on pricing/model drift, policy/prompt hash drift, unsupported token bounds, authentication/quota failure, or any preparation/oracle defect. Do not automatically retry uncertain requests: they may already be billed. Reconcile usage before considering a separately authorized follow-up. No conclusion about comprehension is warranted until an executed, provenance-complete result exists.

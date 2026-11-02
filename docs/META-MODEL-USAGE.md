# How Sentinel uses Meta models

Sentinel was built during the Meta x Cerebral Valley Global Hackathon. It uses Meta models in two ways: **inside the product**, and **to build the product**.

## 1. Inside the product: Muse Spark Open finds discrepancies between compliance documents

**Feature:** document comparison for compliance review ("Working Memory"). A compliance officer pastes two versions of a policy or procedure, for example last year's infection-control SOP and the revised draft. Sentinel asks Meta's **Muse Spark Open** model to report what changed or went missing.

**Model and serving:**
- model `meta-models/Muse-Spark-Open-816B-A42B`, an open-weight model;
- served from a Modal Shared Endpoint through an OpenAI-compatible `/v1/chat/completions` API;
- adapter `src/server/docaudit-modal.ts`. A second adapter for Baseten-hosted Muse Spark Open, `src/server/docaudit-baseten.ts`, uses the same contract.

**What makes it more than a basic integration.** The model's output is treated as untrusted and verified before a person ever sees it:
1. **Verbatim quotes, checked by the server.** Every finding must quote its source word for word:
   - a *difference* quotes both documents;
   - a *missing* finding quotes only the document that contains the passage.

   The server checks every quote against the source text and records each exact location. A finding whose quote doesn't appear in the source is rejected, so the model can't invent evidence.
2. **Resistance to instructions planted in a document.** Text inside a document is treated as data. Instructions hidden in a pasted document (for example "ignore previous instructions") are not followed, and the model never issues compliance verdicts.
3. **A human decides.** A reviewer accepts or dismisses each finding. Nothing becomes a task until a person confirms it.
4. **An accepted finding becomes tracked work.** It turns into a follow-up task with the exact quoted passages attached. The task is idempotent: double clicks and retries never create duplicates. Every step is written to a tamper-evident, hash-chained audit log.
5. **Bounded and private by design:**
   - one attempt per comparison;
   - capped inputs (4,000 characters per side) and capped output;
   - strict JSON parsing with no repair;
   - a pinned endpoint host with redirects refused;
   - the API key is never logged and is redacted from all output;
   - pasted documents are not stored. Only when a reviewer explicitly saves a follow-up task does Sentinel keep the finding summary and the excerpts the reviewer selected, with their source locations.

**Real-model evaluation during the hackathon (2026-10-28):**
- 11 real calls to `meta-models/Muse-Spark-Open-816B-A42B`: 1 smoke test plus 10 predefined synthetic test cases. The founder ran each call and observed HTTP 200. An independent reviewer then checked each run's retained synthetic database: finding counts by kind, an intact audit chain, no credential residue and no stored input text.
- **Score: 9 of 10 test cases passed** under the rule fixed in advance: findings must match the expected kinds and count exactly, with server-verified quotes.
  - **Adjudication caveat:** each case also carried hand-judged quality notes. A strictly literal reading of every note would score the run 8 of 10. Both readings are recorded in the evaluation log.
- **The one failure:** the model correctly *ignored* an instruction planted in a document, but also *reported* the planted note as an extra finding. The fixed rule counted that as a fail. We kept the rule rather than re-scoring.
- **Total model spend for the evaluation:** about $0.04, per the Modal billing view.
- **What it shows:** the integration works end to end. It doesn't establish general accuracy. It covers one model, one endpoint and synthetic data, on one day.

**In the dashboard (2026-11-0X):** [to be completed after the recorded live session. The founder runs the dashboard launcher (`.tmp/modal-dashboard-prep/modal-dashboard-launcher.mts`) against Muse Spark Open, records the comparison → review → follow-up flow, and logs the result here.]

## 2. Building the product: Meta's coding agent wrote the code
Sentinel's code was written during the hackathon by a coding agent running Meta's **Muse Spark 1.3** model (the agent's status line reads `muse-spark-1.3-contributor`). The founder directed the work. An independent QA reviewer (Claude) checked each slice and kept the evidence log.

## What is deliberately not claimed
- Sentinel does not certify compliance or replace a compliance officer's judgment.
- Findings are leads for a person to review, not determinations.
- All data in the demo is synthetic: no patient data, and no real organization's records.

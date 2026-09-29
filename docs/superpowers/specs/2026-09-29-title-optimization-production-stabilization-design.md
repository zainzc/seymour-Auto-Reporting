# Title Optimization Production Stabilization Design

## Goal

Make the Phase 7.4 config-driven Title Optimization runtime follow the client's Production Instructions v5 conservatively and consistently. Accepted titles may be written to Airtable. Ambiguous, invalid, or degrading proposals must be retained for review without replacing the publishable title.

## Scope

This change stabilizes the existing runtime. It does not redesign the configuration UI, add new business rules, activate the legacy generator, or change Phase 5 publishing behavior.

## Airtable Field Contract

- `Title` is the current authoritative/eBay title. It is source evidence and the no-degrade baseline. Phase 7.4 never modifies it.
- `Item Title` is the generated output consumed by later publishing workflows.
- Phase 7.4 writes `Item Title` only when the deterministic final decision accepts the generated title as Completed.
- For Needs Review, blocked validation, source conflict, or degradation, Phase 7.4 leaves `Item Title` unchanged.
- For manual override, Phase 7.4 leaves both title fields unchanged.
- A rejected proposal is recorded in `Title Review Notes` with the specific deterministic failure details.
- `Title Review Status`, `Title Review Reason`, and `Title Review Notes` are derived from the final runtime decision, not from contradictory model-provided review text.

## Fitment Resolution

The fitment service remains responsible for parsing and normalizing available applications, but it must not arbitrarily select among distinct valid applications.

1. Parse Part Fitment and other approved application evidence into structured candidates.
2. Normalize duplicates and approved equivalent terminology without broad or speculative rewriting.
3. Apply the configured source hierarchy and trusted listing evidence.
4. If the evidence resolves to exactly one application, pass that application to title generation as verified fitment.
5. If multiple distinct applications or separate year ranges remain, do not ask the model to choose or merge them. Mark the result Needs Review with `Multiple year ranges require review` or the configured equivalent reason.
6. Include the conflicting applications in review notes, preserve `Title`, and leave `Item Title` unchanged.
7. Donor year/make/model information may help identify a part but must not silently replace the currently advertised application.
8. A different application may replace the existing advertised application only when higher-authority evidence proves the existing application inaccurate and the result is unambiguous.

The prompt may format a single verified application. It may not resolve genuine fitment ambiguity using automotive knowledge or probability.

## Validation And Acceptance

Before writing `Item Title`, deterministic validation must confirm:

- the title is nonblank and no longer than 80 characters, including spaces and final SKU;
- SKU appears exactly once at the end;
- make, model, year/range, side, and qualifiers are supported by trusted evidence;
- no verified fitment or important distinguishing detail is lost;
- no unsupported category priority detail is introduced;
- the selected title structure applies to the resolved part category;
- the candidate does not degrade the existing `Title`.

Any failed acceptance check prevents the `Item Title` write. The model can propose and format a title, but it cannot override deterministic acceptance.

## Category Priority Details

Category `priorityDetails` remain candidate details rather than facts. Each detail must be verified against approved source evidence or an approved terminology equivalent before it can be used.

Field concepts such as `Color` are resolved to their actual verified listing value, such as `Beige`; the literal label `Color` is not required in the title. Unverified details remain visible in diagnostic data but are not supplied as usable title facts.

## Title Structures

Structure applicability must be based on the resolved part/category. Requirements belonging to one part family, such as transmission codes, must not be applied to unrelated parts such as wiper motors. Existing configured structures and their ordering remain unchanged.

## Review Reporting

Review output must be deterministic and specific:

- multiple applications list the conflicting normalized applications;
- overlength reports the measured character count;
- unsupported side, vehicle, year, qualifier, or category detail identifies the failed field and evidence;
- degradation identifies the verified detail that would be lost;
- runtime failure reports the failing stage without replacing either title field.

Completed rows must not retain stale Needs Review reasons. Needs Review rows must not report `No issues identified`, `completed`, or another contradictory reason.

## Logging

Runtime logs retain the AI payload diagnostics and add concise final-decision data: proposed title, existing title, final accepted title, fitment candidate count, normalized applications, acceptance decision, failed checks, and Airtable title-write action.

## Testing

Focused regression coverage will include:

- one unambiguous fitment application is accepted;
- duplicate/equivalent fitment entries collapse to one application;
- multiple distinct applications cause Needs Review and no `Item Title` write;
- separate year ranges are not merged or arbitrarily selected;
- donor identity cannot silently replace advertised fitment;
- an accepted title writes `Item Title` but never `Title`;
- rejected, degraded, overlength, failed, and manually overridden titles do not write `Item Title`;
- rejected proposals and exact reasons are retained in review notes;
- final review fields cannot contradict the deterministic decision;
- category field concepts resolve to verified values;
- unrelated title structures do not impose invalid requirements;
- no-degrade, Prefix Rules, SKU rules, terminology normalization, and Part Fitment evidence remain operational.

Verification consists of the affected targeted tests, all Title Optimization tests, the full regression suite, and `git diff --check`.

## Success Criteria

The runtime automatically writes only a single, evidence-supported, client-compliant title. Any unresolved ambiguity remains visible for human review without changing the publishable output field. The system cannot promise perfect source data, but it fails conservatively and explains every non-accepted result.

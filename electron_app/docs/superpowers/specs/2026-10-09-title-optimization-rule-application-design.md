# Title Optimization Rule Application Design

## Objective

Make Phase 7.4 apply the active Title Optimization UI configuration consistently across all listings while retaining a single semantic AI generation call and keeping the independent AI reviewer disabled.

Success means that applicable source, terminology, synonym, prefix, restricted-term, category, title-structure, flag-reason, and system rules are selected before generation, visible in logs, and objectively enforceable rules cannot be silently bypassed by an AI `Completed` decision.

## Constraints

- Use active UI configuration as the source of rule behavior.
- Do not add IPN-specific output exceptions.
- Prefix `300` is an authoritative Engine family signal.
- Keep the independent AI fitment reviewer disabled.
- Preserve one normal semantic generation call. Existing malformed-response retry and mechanical compression behavior remain technical recovery paths.
- AI owns automotive interpretation of supplied fitment evidence.
- Code owns rule applicability, evidence boundaries, explicit configuration contracts, SKU placement, and title length.
- Do not restore broad keyword-protection lists or the removed semantic reviewer.
- Preserve manual override behavior and Airtable write boundaries.

## Root Causes

1. Category Rules use exact names, so configured categories such as `Mirrors`, `Tail Lights`, and `Seat Belts` do not match resolved values such as `Side View Mirror`, `Taillight Assembly`, and `Seat Belt`.
2. Engine and transmission structures are selected from too little identity evidence. An engine can resolve to a generic part such as `Complete Assembly` and incorrectly fall back to General.
3. Restricted-term scope uses that same narrow classification, so engine-only terms may never reach the model.
4. Full HTML contributes generic educational or warranty text as listing-specific side evidence.
5. The generator can report `Completed` while violating explicit restricted terms, title structure, category verification, source conflicts, or scoped fitment requirements.
6. Logs show final output but do not provide one concise applicability and compliance decision record.

## Listing Classification

Introduce one shared listing-family classifier used by rule resolution, structure selection, and restricted-term scope.

Trusted signals, in descending specificity:

1. Explicit configured Prefix Rule family metadata.
2. Canonical prefix-family policy. Prefix `300` maps to `engine`.
3. Resolved category and part identity.
4. Item Specifics part/category.
5. Conditions & Options.
6. Existing authoritative title.
7. Selected Part Fitment application evidence.

The classifier returns:

```json
{
  "family": "engine",
  "resolved": true,
  "sources": [
    { "source": "ipnPrefix", "value": "300" },
    { "source": "existingTitle", "value": "... Engine ..." }
  ],
  "reason": "Prefix 300 and authoritative title identify an engine listing."
}
```

It must not infer a family from unrelated description boilerplate. Contradictory strong family signals are retained as a conflict for AI review instead of silently selecting one.

## Category Rule Matching

Replace exact-name-only matching with deterministic normalized matching based on configured data.

Normalization includes:

- case, whitespace, punctuation, and hyphen normalization;
- singular/plural equivalence;
- configured terminology replacements;
- configured synonym equivalence;
- removal of generic category suffixes such as `Assembly` only for matching, never for generated facts;
- exact prefix and series references;
- meaningful phrase containment after normalization.

Examples:

- `Side View Mirror` matches `Mirrors`.
- `Taillight Assembly` matches `Tail Lights`.
- `Seat Belt` matches `Seat Belts`.
- `Headlight Assembly` matches `Headlights`.
- `Rear-View Mirror` matches `Rear View Mirrors`.

Every match records its method and normalized evidence. Multiple genuine matches remain visible and are all supplied to AI.

Combined priority details containing slash-delimited alternatives are normalized into separate decisions before prompt construction. Existing persisted values remain readable; saving through the UI stores separate values.

## Source Evidence Hygiene

Full HTML remains available for extracting listing-specific sections, but generic prose must not become authoritative facts.

Side and placement evidence may come from:

- structured Item Specifics;
- existing title;
- Conditions & Options;
- parsed Part Fitment rows;
- listing-specific donor notes.

Side and placement must not come from generic statements such as `LEFT IS DRIVERS SIDE AND RIGHT IS THE PASSENGERS SIDE`, warranty text, shipping text, examples, or explanatory templates.

Each candidate retains `sourceFieldName`, source role, and whether it was parsed from listing-specific or boilerplate content. Opposite listing-specific sides at the same authority remain a conflict. AI must return `Needs Review` unless a clearly higher configured source resolves it.

## Rule Selection

The shared classification drives:

- Engines or Transmissions title structure selection;
- restricted-term scope (`all`, `engine`, `transmission`, or configured family);
- category selection;
- applicable terminology and synonym filtering.

Prefix `300` selects Engine family even when the resolved part is `Complete Assembly`. This causes engine-scoped rules such as `Complete Assembly` to be included.

Rules are selected from active UI configuration. Canonical family policy supplies only system-owned facts such as prefix `300` identifying an engine; it does not invent title text.

## AI Contract

The single generation call receives only applicable configuration plus canonical System Rules and returns:

- generated title and descriptions;
- review status, reason, and notes;
- selected vehicle application and supplied row IDs;
- material restrictions with their year/variant scope;
- side and placement decision with evidence ID;
- one verification decision per category priority detail;
- restricted-term decisions, including authorization evidence;
- ordered title segments corresponding to the selected structure;
- final self-audit checks.

The schema uses exact supplied IDs rather than free-form citations where possible. The title must be composed from the returned ordered segments.

AI must not mark `Completed` when:

- a material source conflict remains unresolved;
- a restricted term requires authorization and no authorization evidence exists;
- a material restriction cannot be represented truthfully within 80 characters;
- the advertised application cannot be selected from supplied evidence.

## Deterministic Contract Enforcement

Post-generation code enforces only explicit, explainable contracts:

1. Nonblank title.
2. SKU exactly once at the end.
3. Prefix `257` hash-SKU behavior.
4. Maximum 80 characters without word truncation.
5. Used restricted terms have an applicable rule decision and required authorization evidence.
6. Returned title segments follow the selected structure and reproduce the normalized final title.
7. Used Category Rule details are marked verified and cite supplied evidence.
8. Side/placement decisions cite listing-specific allowed evidence.
9. An unresolved authoritative source conflict cannot be `Completed`.
10. Selected fitment row IDs exist in the supplied eligible candidates.

Code does not independently decide whether two automotive qualifiers are semantically equivalent. That remains part of the AI application decision and self-audit.

Contract failures produce a configured review reason and preserve a proposed title for diagnostics while preventing an unsafe completed write.

## Title Structure

The selected structure is derived from shared listing classification:

- `engine` -> Engines
- `transmission` -> Transmissions
- otherwise -> most specific configured custom/category structure, then General

The model returns a segment array with keys matching the selected structure. Code joins normalized nonempty segments and requires it to equal the final title. This enforces ordering without keyword-position guessing.

## Fitment Restrictions

The prompt continues to provide parsed eligible fitment rows. AI returns a structured list such as:

```json
{
  "detail": "without surround view",
  "appliesTo": "2012-2015",
  "sourceRowIds": ["title-fitment-003", "title-fitment-006"],
  "material": true,
  "titleTreatment": "included"
}
```

For material restrictions, `titleTreatment` must be `included`, `not-applicable-to-selected-application`, or `needs-review`. An unexplained omission cannot accompany `Completed`.

This prevents broad titles such as unrestricted `2008-2015 Nissan Rogue` when later years require VIN/build/options, while allowing AI to select one truthful advertised application rather than listing every compatible vehicle.

## Logging

Add one compact `ruleDecision` object to each JSONL result:

- listing family and evidence;
- source conflicts and ignored boilerplate evidence;
- matched Category Rules and match methods;
- selected Title Structure and reason;
- applicable Prefix and Restricted Terms;
- selected fitment rows and material restrictions;
- category verification decisions;
- objective contract-check results;
- final status and reason.

No credentials or unrelated raw HTML are added to this compact decision object.

## Compatibility

- Manual override remains a bypass.
- Existing UI configuration remains readable.
- Combined category details are normalized at runtime for backward compatibility.
- Existing Prefix Rules continue to establish deterministic normalized parts.
- The legacy Phase 7.4 prompt remains present but inactive in the authoritative runtime.
- Airtable writes continue through the existing Phase 7.4 boundary.
- Independent AI review remains disabled.

## Verification

Add focused tests for:

1. Prefix `300` selects Engine family, Engines structure, and engine restricted terms.
2. `Complete Assembly` without authorization cannot be Completed.
3. Configured authorization allows an otherwise restricted engine term.
4. Category aliases match mirrors, tail lights, seat belts, headlights, fuel doors, and rear-view mirrors.
5. Prefix/category matching does not create unsupported product facts.
6. Generic HTML left/right boilerplate is ignored.
7. Genuine opposite-side evidence becomes a conflict and cannot be Completed unresolved.
8. Title segment output follows General, Engines, and Transmissions structures.
9. Unverified category details cannot appear in a Completed title.
10. Material year-scoped restrictions require an explicit title treatment.
11. Existing SKU, prefix `257`, length, override, no-write-on-review, and logging behavior remain intact.
12. The complete Title Optimization suite and full regression suite pass.

Replay the audited 100-record run and report:

- rule coverage by tab;
- category match rate;
- structure-selection counts;
- restricted-term violations;
- source conflicts;
- false-completed candidates;
- legitimate Needs Review count;
- mechanical compliance.

## Acceptance Criteria

- All 100 records receive an explicit selected structure and rule-decision log.
- Known category families in the audit receive their configured Category Rules.
- SKU `1592278` cannot complete with unauthorized `Complete Assembly` and selects Engines structure.
- SKU `1592643` cannot complete while Passenger/Right versus Driver/Left remains unresolved.
- SKU `1593222` cannot complete with duplicated normalized part wording.
- Known scoped-fitment examples cannot complete after silently dropping material restrictions.
- Mechanical compliance remains 100 percent for titles that are written.
- No second AI reviewer call is made.

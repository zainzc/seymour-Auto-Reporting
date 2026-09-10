# Source Priority Design Specification

## Confirmed Requirements

Add Source Priority as the second enabled tab in the existing Title Optimization Workspace. Source Fields remains enabled and unchanged; all other internal tabs stay visible and disabled. The page reuses the existing 1280px shell, top navigation, cards, table styling, feedback, dialogs, audit identity, and secure Electron boundaries. No sidebar is added.

The fixed v1 authority classes are, in order: `manualOverride`, `lockedFixedIpn`, `itemSpecifics`, `categoryConditions`, `manufacturerPartNumber`, `brandMake`, `otherStructuredFields`, `currentEbay`, and `rawHollander`. Manual Override is permanently locked at rank 1. Ranks 2–9 support drag reorder plus accessible Move Up and Move Down buttons. Changes are local until Save Changes.

## Persistence and Validation

Persist only `{ version, policy, order, updatedAt, updatedBy }` under `titleOptimization.sourcePriority` in the existing encrypted electron-store. Seed defaults only when no configuration exists. Validate exactly nine known unique keys and require `manualOverride` at index 0. Saves use last-write-wins, preserve the prior record on failure, and do not retry automatically. A service method exposes the ordered key array for future runtime consumers without implementing resolution logic.

## Malformed Configuration

Never wipe, reseed, or silently persist repairs for malformed existing data. Preserve valid saved entries in their relative order, identify unknown and duplicate entries, append missing expected entries in a clearly marked correction state for safe display, and require an explicit reorder/reset plus Save before corrected data is persisted.

## Interaction and Safety

Reset to Default requires confirmation, updates only local editor state, and marks it dirty. Unsaved internal navigation uses the existing in-app discard dialog; window-close protection uses the existing `beforeunload` pattern. Save failures preserve edits and dirty state. Configuration read failures render a clear error without inventing replacement data.

## Accessibility and Visual Design

Use semantic table markup, visible focus, textual lock/status treatments, labeled drag and move controls, and keyboard-operable dialogs. Drag is an enhancement, never the only reorder mechanism. The white configuration card, row density, badges, hierarchy, and “How Source Priority Works” panel follow the supplied screenshot while using existing application tokens and no sidebar.

## Out of Scope

AI calls, title generation, source conflict execution, Airtable mapping or credentials, per-custom-field authority rows, enable/disable controls, roles, version conflicts, pagination, search, virtualization, and every other unfinished Title Optimization tab.

## Acceptance Criteria

Automated coverage verifies rendering/navigation, defaults, reload, lock invariants, drag and button reorder, numbering, validation, persistence, idempotence, reset confirmation/local-only behavior, dirty navigation, save failures, malformed persistence, IPC security, Source Fields regression, and broader workspace regression. Available lint/typecheck/build commands and Electron manual behavior are verified before completion.

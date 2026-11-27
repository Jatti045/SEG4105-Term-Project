# ADR-002: No offline buffering on the fridge

- **Status:** Accepted
- **Date:** 2026-11-27
- **Supersedes:**
  - Deliverable 1, section 1.11 requirement: "Continue collecting and storing inventory data during temporary connectivity interruptions and synchronize pending data after connectivity is restored."
  - Deliverable 1, section 1.12: the acceptance criterion for "recovery after connectivity interruptions."

## Context

Offline buffering would let the system replay every change made during an outage. The system's job is to know current stock. It does not need the exact time each item was used.

## Decision

The fridge does not store readings while it is disconnected. Each reading is a complete snapshot of every row's current state, not only what changed, so the first reading after the connection returns brings the backend fully up to date.

## Consequences

- No local storage and no sync logic on the fridge.
- During an outage, the dashboard and alerts show stock as of the last reading.
- Usage history has gaps where outages occurred. This is acceptable because only current stock is required.
- Level-0 data store D1 (Device Event Buffer) is removed.
- Risk 3 (internet or cloud outages) in the Deliverable 1 risk analysis relies on local buffering in its reasoning, and needs updating.

# ADR-001: Run image recognition in the backend, not on the fridge

- **Status:** Accepted
- **Date:** 2026-11-27
- **Supersedes:** Deliverable 1, section 1.11 requirement: "Perform initial processing of camera and sensor data on the refrigerator device before transmitting the data to the cloud."

## Context

Deliverable 1 planned for on-device processing before data is sent to the cloud. The fridge's sensor rows already report an item ID, a weight, and an item count, so there is little for the device to process. Running an image recognition model on the fridge would need extra hardware in every unit, and would make the model harder to update.

## Decision

The fridge sends raw readings for each row straight to the backend:

- item ID
- weight reading
- item count
- a shelf image

The backend runs image recognition and all other processing.

## Consequences

- The fridge stays simple and cheap: it only reads sensors and sends data.
- The model can be updated or retrained in one place, with no changes to fridges.
- Each reading includes an image, which uses more bandwidth than sending processed results.
- Level-0 process 1.0 becomes "Capture and Send Readings", with no processing step.

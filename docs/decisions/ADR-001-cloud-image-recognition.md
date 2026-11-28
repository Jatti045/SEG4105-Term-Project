# ADR-001: Run image recognition in the backend, not on the fridge

- **Status:** Accepted
- **Date:** 2026-11-27
- **Amended:** 2026-11-27: rows send an image and a weight only; the backend works out the item count.
- **Supersedes:** Deliverable 1, section 1.11 requirement: "Perform initial processing of camera and sensor data on the refrigerator device before transmitting the data to the cloud."

## Context

Deliverable 1 planned for on-device processing before data is sent to the cloud. Each sensor row only needs to report a weight and take a picture, so there is little for the device to process. Running an image recognition model on the fridge would need extra hardware in every unit, and would make the model harder to update.

## Decision

The fridge sends raw readings for each row straight to the backend:

- row ID
- weight reading, in grams
- a PNG image of the row

The backend runs image recognition and all other processing. It identifies the product from the image and estimates the item count from the weight, using the product's unit weight.

## Consequences

- The fridge stays simple and cheap: it only reads sensors and sends data.
- The model can be updated or retrained in one place, with no changes to fridges.
- Each reading includes an image, which uses more bandwidth than sending processed results.
- Item counts are estimates. A product's unit and package weights must be accurate, or counts will be off.
- Level-0 process 1.0 becomes "Capture and Send Readings", with no processing step.

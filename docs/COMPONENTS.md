# Software Components

## Overview

Smart Inventory Fridge is a small Python HTTP service that provides a simulated
inventory snapshot for the prototype. The service is implemented in
[app.py](../app.py) and uses only the Python standard library.

The components currently in the repository are:

| Component | Responsibility |
| --- | --- |
| Inventory data provider | Generates the simulated stock and expiry data. |
| HTTP request handler | Routes GET requests and formats JSON responses. |
| JSON response writer | Sets HTTP response headers and writes response bodies. |
| HTTP server bootstrap | Starts the multi-threaded server on port 8080. |
| Local documentation | Explains how to run the prototype and links to its handoff. |

## Inventory data provider

**Implementation:** `inventory(today)` in [app.py](../app.py)

**Purpose:** Builds the inventory snapshot using a fixed simulated dataset.
The function accepts a `datetime.date` value and calculates each item's expiry
status relative to that date.

**Dependencies:**
- Python `datetime.date` and `datetime.timedelta`
- No database, sensor, API, or external package

**Interfaces:**
- Input: `today`, a `datetime.date`
- Output: a list of dictionaries, one for each simulated item
- Item fields:
  - `item`: item name
  - `quantity`: simulated stock quantity
  - `expiry`: ISO-formatted date (`YYYY-MM-DD`)
  - `low_stock`: `true` when quantity is less than or equal to 2
  - `expiry_status`: `expired`, `expiring soon`, or `fresh`

An item is `expired` when its expiry date is before `today`. It is
`expiring soon` when it expires within two days, inclusive of `today`. All
other items are `fresh`.

## HTTP request handler

**Implementation:** `InventoryHandler` in [app.py](../app.py)

**Purpose:** Handles HTTP GET requests and maps URL paths to service responses.
It also supplies consistent JSON for successful and unknown routes.

**Dependencies:**
- `BaseHTTPRequestHandler` from `http.server`
- `HTTPStatus` from `http`
- `json`
- `inventory(today)` and `date.today()`

**Interfaces:**

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | HTTP 200 JSON object containing `{"status": "ok"}` |
| `GET` | `/` | HTTP 200 inventory snapshot |
| `GET` | `/inventory` | HTTP 200 inventory snapshot |
| `GET` | Any other path | HTTP 404 JSON object containing `{"error": "Route not found"}` |

The `/` and `/inventory` responses contain:

- `service`: `"Smart Inventory Fridge"`
- `source`: `"simulated"`
- `items`: the list returned by `inventory(date.today())`

Requests that use HTTP methods other than GET are handled by the base
`BaseHTTPRequestHandler` behavior. The prototype does not implement POST, PUT,
PATCH, or DELETE operations.

## JSON response writer

**Implementation:** `InventoryHandler.send_json(status, payload)` in
[app.py](../app.py)

**Purpose:** Serializes a Python payload as JSON and sends it to the HTTP
client.

**Dependencies:**
- `json.dumps`
- `BaseHTTPRequestHandler.send_response`, `send_header`, `end_headers`, and
  `wfile`

**Interfaces:**
- Inputs: an `HTTPStatus` value and a JSON-serializable dictionary
- Output: an HTTP response with:
  - `Content-Type: application/json; charset=utf-8`
  - `Content-Length: <encoded body length>`
  - An indented UTF-8 JSON body

## HTTP server bootstrap

**Implementation:** the `__main__` block in [app.py](../app.py)

**Purpose:** Creates and runs the network server when `app.py` is executed
directly.

**Dependencies:**
- `ThreadingHTTPServer` from `http.server`
- `InventoryHandler`
- Python 3 runtime
- Port 8080 on the host

**Interfaces:**
- Address: `0.0.0.0`
- Port: `8080`
- Base URL for local use: `http://localhost:8080`
- Startup: `python3 app.py`
- Server mode: thread-per-request HTTP service

The server continues running until it is stopped by the process. There is no
TLS configuration, authentication, persistence layer, or configuration file in
the prototype.

## Local documentation

**Implementation:** [README.md](../README.md)

**Purpose:** Provides project context, local startup instructions, prototype
behavior, and the teammate handoff for the Lab 8 assignment.

**Dependencies:** No runtime dependencies. It expects the service to be served
by [app.py](../app.py) on port 8080.

**Interfaces:** Markdown documentation in the repository and links to the
GitHub issue handoff.

## Planned components

[README.md](../README.md) identifies the following components as future project
scope. They are not implemented in the current repository and therefore do not
yet have code interfaces:

- Physical fridge sensors for inventory and temperature readings
- Cloud synchronization for shared or remotely stored inventory state
- A dashboard for viewing stock levels and expiry warnings

## Component interaction

```text
Client
  |
  | HTTP GET
  v
ThreadingHTTPServer (port 8080)
  |
  v
InventoryHandler.do_GET()
  |                         |
  | /health                 | / or /inventory
  v                         v
status JSON         inventory(date.today())
  |                         |
  |                         v
  |                    inventory(today)
  |                         |
  +-------------+-----------+
                v
         send_json(...)
                |
                v
          HTTP JSON response
```

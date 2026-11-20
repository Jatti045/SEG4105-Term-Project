# Smart Inventory Fridge

Group 10's SEG 4105 term project explores how food-service teams can track refrigerated stock and reduce waste. This first prototype serves a simulated inventory snapshot, including stock levels and expiry warnings.

## Run locally

Run `python3 app.py` from the project root, then open <http://localhost:8080/inventory> to see the inventory snapshot. The `/health` endpoint returns the service status.

The prototype uses simulated items. It flags quantities of two or fewer as low stock and marks items expiring within two days. The full project plans include physical fridge sensors, cloud synchronization, and a dashboard.

## Documentation

- [Software Components](docs/COMPONENTS.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [Development Methodology](docs/METHODOLOGY.md)

"""Smart Inventory Fridge inventory service for simulated device readings."""

from datetime import date, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json


def inventory(today):
    items = [
        ("Milk", 2, today + timedelta(days=1)),
        ("Greek yogurt", 8, today + timedelta(days=5)),
        ("Baby spinach", 1, today + timedelta(days=2)),
        ("Fresh basil", 4, today - timedelta(days=1)),
    ]
    return [
        {
            "item": name,
            "quantity": quantity,
            "expiry": expiry.isoformat(),
            "low_stock": quantity <= 2,
            "expiry_status": (
                "expired" if expiry < today
                else "expiring soon" if expiry <= today + timedelta(days=2)
                else "fresh"
            ),
        }
        for name, quantity, expiry in items
    ]


class InventoryHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
        elif self.path in ("/", "/inventory"):
            self.send_json(
                HTTPStatus.OK,
                {"service": "Smart Inventory Fridge", "source": "simulated",
                 "items": inventory(date.today())},
            )
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route not found"})

    def send_json(self, status, payload):
        body = json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    with ThreadingHTTPServer(("0.0.0.0", 8080), InventoryHandler) as server:
        server.serve_forever()

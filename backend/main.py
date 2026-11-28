"""Smart Inventory Fridge API."""

from fastapi import Depends, FastAPI

import catalog
import inventory
import manager
import readings
import recognition
from auth import current_user

app = FastAPI(title="Smart Inventory Fridge API")
app.include_router(manager.router)
app.include_router(readings.router)
app.include_router(catalog.router)
app.include_router(inventory.router)
app.include_router(recognition.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user

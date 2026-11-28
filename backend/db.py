"""PostgreSQL connection, one per request."""

import os

import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://smart_fridge:smart_fridge@localhost:5440/smart_fridge",
)


def get_db():
    """FastAPI dependency that yields a connection and closes it after the request."""
    with psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True) as conn:
        yield conn

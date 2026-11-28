"""Who is making the request.

There is no login yet. Every request acts as the first active manager, so the
manager pages work end to end. Replace `current_user` with a real session
lookup when login is added; the routes depending on it won't need to change.
"""

from fastapi import Depends, HTTPException, status
from psycopg import Connection

from db import get_db


def current_user(db: Connection = Depends(get_db)) -> dict:
    user = db.execute(
        """
        SELECT user_id, name, email, role
        FROM users
        WHERE role = 'manager' AND active
        ORDER BY user_id
        LIMIT 1
        """
    ).fetchone()
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No active manager account.")
    return user


def require_manager(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "manager":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Managers only.")
    return user

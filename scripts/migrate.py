"""Apply VKO LINKWATCH database migrations.

The application also runs these additive migrations during startup. This small
CLI is useful for deployment pipelines that prefer an explicit pre-start step.
"""

from __future__ import annotations

import argparse

from backend.app.db import get_connection, init_db, resolve_db_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate VKO LINKWATCH database")
    parser.add_argument("--db", default=None, help="SQLite path or PostgreSQL DSN (defaults to VKO_DATABASE_URL/VKO_DB_PATH)")
    args = parser.parse_args()
    path = resolve_db_path(args.db)
    init_db(path)
    with get_connection(path) as connection:
        versions = [int(row["version"]) for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()]
    print(f"VKO database migrated: {path} (versions={versions})")


if __name__ == "__main__":
    main()

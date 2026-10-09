from __future__ import annotations

import os
from pathlib import Path

import sqlparse
from sqlalchemy import create_engine, text


ROLE_ENV_MAP = {
    "mpf_crawler": "CRAWLER_DB_PASSWORD",
    "mpf_portfolio": "PORTFOLIO_DB_PASSWORD",
    "mpf_purchase": "PURCHASE_DB_PASSWORD",
    "mpf_valuation": "VALUATION_DB_PASSWORD",
}


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _build_admin_database_url() -> str:
    user = _require_env("POSTGRES_USER")
    password = _require_env("POSTGRES_PASSWORD")
    host = _require_env("POSTGRES_HOST")
    port = _require_env("POSTGRES_PORT")
    database = _require_env("POSTGRES_DB")
    return f"postgresql+psycopg://{user}:{password}@{host}:{port}/{database}"


def _ensure_roles(engine) -> None:
    with engine.begin() as connection:
        for role_name, password_env in ROLE_ENV_MAP.items():
            role_password = _require_env(password_env)
            quoted_password = connection.execute(
                text("SELECT quote_literal(:password)"),
                {"password": role_password},
            ).scalar_one()
            exists = connection.execute(
                text("SELECT 1 FROM pg_roles WHERE rolname = :role_name"),
                {"role_name": role_name},
            ).first()
            if exists:
                connection.exec_driver_sql(
                    f'ALTER ROLE "{role_name}" WITH LOGIN PASSWORD {quoted_password}'
                )
            else:
                connection.exec_driver_sql(
                    f'CREATE ROLE "{role_name}" WITH LOGIN PASSWORD {quoted_password}'
                )


def _apply_sql_migrations(engine) -> None:
    migration_dir = Path(__file__).resolve().parents[1] / "migrations" / "sql"
    migration_files = sorted(migration_dir.glob("*.sql"))
    if not migration_files:
        raise RuntimeError(f"No migration files found in {migration_dir}")

    with engine.begin() as connection:
        for migration_file in migration_files:
            sql_text = migration_file.read_text(encoding="utf-8")
            statements = [stmt.strip() for stmt in sqlparse.split(sql_text) if stmt.strip()]
            for statement in statements:
                connection.execute(text(statement))
            print(f"Applied migration: {migration_file.name}")


def main() -> None:
    admin_url = _build_admin_database_url()
    engine = create_engine(admin_url, future=True, pool_pre_ping=True)
    _ensure_roles(engine)
    _apply_sql_migrations(engine)
    print("Migration completed successfully.")


if __name__ == "__main__":
    main()

from __future__ import annotations

import os
from pathlib import Path

import sqlparse
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL


ROLE_ENV_MAP = {
    "CRAWLER_DB_USER": "CRAWLER_DB_PASSWORD",
    "PORTFOLIO_DB_USER": "PORTFOLIO_DB_PASSWORD",
    "PURCHASE_DB_USER": "PURCHASE_DB_PASSWORD",
    "VALUATION_DB_USER": "VALUATION_DB_PASSWORD",
}


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _build_admin_database_url(database: str | None = None) -> URL:
    user = _require_env("POSTGRES_USER")
    password = _require_env("POSTGRES_PASSWORD")
    host = _require_env("POSTGRES_HOST")
    port = _require_env("POSTGRES_PORT")
    return URL.create(
        "postgresql+psycopg",
        username=user,
        password=password,
        host=host,
        port=int(port),
        database=database if database is not None else _require_env("POSTGRES_DB"),
    )


def _ensure_database() -> None:
    database = _require_env("POSTGRES_DB")
    # CREATE DATABASE cannot run inside a transaction or connect to a missing DB.
    engine = create_engine(
        _build_admin_database_url("postgres"),
        isolation_level="AUTOCOMMIT",
        pool_pre_ping=True,
    )
    try:
        with engine.connect() as connection:
            exists = connection.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :database"),
                {"database": database},
            ).first()
            if not exists:
                quoted_database = connection.dialect.identifier_preparer.quote_identifier(
                    database
                )
                connection.exec_driver_sql(f"CREATE DATABASE {quoted_database}")
                print(f"Created database: {database}")
    finally:
        engine.dispose()


def _ensure_roles(engine) -> None:
    with engine.begin() as connection:
        for role_env, password_env in ROLE_ENV_MAP.items():
            role_name = _require_env(role_env)
            role_password = _require_env(password_env)
            quoted_role = connection.dialect.identifier_preparer.quote_identifier(
                role_name
            )
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
                    f"ALTER ROLE {quoted_role} WITH LOGIN PASSWORD {quoted_password}"
                )
            else:
                connection.exec_driver_sql(
                    f"CREATE ROLE {quoted_role} WITH LOGIN PASSWORD {quoted_password}"
                )


def _apply_sql_migrations(engine) -> None:
    migration_dir = Path(__file__).resolve().parent / "sql"
    migration_files = sorted(migration_dir.glob("*.sql"))
    if not migration_files:
        raise RuntimeError(f"No migration files found in {migration_dir}")

    with engine.begin() as connection:
        for migration_file in migration_files:
            sql_text = migration_file.read_text(encoding="utf-8")
            for identifier_env in (*ROLE_ENV_MAP, "POSTGRES_DB"):
                identifier = _require_env(identifier_env)
                quoted_identifier = (
                    connection.dialect.identifier_preparer.quote_identifier(identifier)
                )
                sql_text = sql_text.replace(
                    f"{{{{{identifier_env}}}}}", quoted_identifier
                )
            statements = [stmt.strip() for stmt in sqlparse.split(sql_text) if stmt.strip()]
            for statement in statements:
                connection.exec_driver_sql(statement)
            print(f"Applied migration: {migration_file.name}")


def main() -> None:
    _ensure_database()
    admin_url = _build_admin_database_url()
    engine = create_engine(admin_url, future=True, pool_pre_ping=True)
    try:
        _ensure_roles(engine)
        _apply_sql_migrations(engine)
    finally:
        engine.dispose()
    print("Migration completed successfully.")


if __name__ == "__main__":
    main()

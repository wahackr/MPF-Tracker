import os
import unittest
from unittest.mock import MagicMock, patch

import migrate
from sqlalchemy.dialects import postgresql


class DatabaseBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "POSTGRES_USER": "migrator",
            "POSTGRES_PASSWORD": "password@with:/?#specials",
            "POSTGRES_HOST": "shared-postgres",
            "POSTGRES_PORT": "5432",
            "POSTGRES_DB": 'mpf-"dev',
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_creates_missing_database_on_server_before_connecting_to_target(self):
        engine = MagicMock()
        connection = engine.connect.return_value.__enter__.return_value
        connection.dialect = postgresql.dialect()
        connection.execute.return_value.first.return_value = None
        with patch.object(migrate, "create_engine", return_value=engine) as create:
            migrate._ensure_database()
        url = create.call_args.args[0]
        self.assertEqual(url.database, "postgres")
        self.assertEqual(url.host, "shared-postgres")
        self.assertEqual(url.password, os.environ["POSTGRES_PASSWORD"])
        self.assertEqual(create.call_args.kwargs["isolation_level"], "AUTOCOMMIT")
        self.assertEqual(connection.execute.call_args.args[1], {"database": 'mpf-"dev'})
        connection.exec_driver_sql.assert_called_once_with('CREATE DATABASE "mpf-""dev"')
        engine.dispose.assert_called_once()

    def test_existing_database_is_left_intact(self):
        engine = MagicMock()
        connection = engine.connect.return_value.__enter__.return_value
        connection.execute.return_value.first.return_value = (1,)
        with patch.object(migrate, "create_engine", return_value=engine):
            migrate._ensure_database()
        connection.exec_driver_sql.assert_not_called()
        engine.dispose.assert_called_once()

    def test_bootstrap_failure_stops_before_roles_and_migrations(self):
        engine = MagicMock()
        connection = engine.connect.return_value.__enter__.return_value
        connection.execute.side_effect = RuntimeError("access denied")
        with patch.object(migrate, "create_engine", return_value=engine), \
                patch.object(migrate, "_ensure_roles") as roles, \
                patch.object(migrate, "_apply_sql_migrations") as migrations:
            with self.assertRaisesRegex(RuntimeError, "access denied"):
                migrate.main()
        roles.assert_not_called()
        migrations.assert_not_called()
        engine.dispose.assert_called_once()

    def test_target_connection_follows_database_creation(self):
        calls = MagicMock()
        engine = MagicMock()
        with patch.object(migrate, "_ensure_database", calls.bootstrap), \
                patch.object(migrate, "create_engine", calls.engine), \
                patch.object(migrate, "_ensure_roles", calls.roles), \
                patch.object(migrate, "_apply_sql_migrations", calls.migrations):
            calls.engine.return_value = engine
            migrate.main()
        self.assertEqual(
            [call[0] for call in calls.mock_calls],
            ["bootstrap", "engine", "roles", "migrations", "engine().dispose"],
        )
        self.assertEqual(calls.engine.call_args.args[0].database, os.environ["POSTGRES_DB"])
        engine.dispose.assert_called_once()


if __name__ == "__main__":
    unittest.main()

from functools import lru_cache

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    service_name: str = "unknown"
    api_key: str = "REPLACE_ME"

    db_host: str = "mpf-db"
    db_port: int = 5432
    db_name: str = "mpf"
    db_user: str = "mpf_migrator"
    db_password: str = "REPLACE_ME_MIGRATOR_PASSWORD"

    health_db_required: bool = True
    enable_job_worker: bool = True
    crawler_use_fixtures: bool = False

    @computed_field
    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()

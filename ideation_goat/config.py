"""Runtime settings, read from environment variables or a local .env file.

Every setting is optional. Without keys the tools still work: GitHub calls are
rate-limited to 60 an hour and summaries fall back to a template.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_URL = "https://github.com/AdityaTummuri/ideation-goat"
DEFAULT_INDEX_URL = f"{REPO_URL}/releases/download/index-latest/index.tar.gz"


def _default_home() -> Path:
    return Path.home() / ".cache" / "ideation-goat"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    # Data sources
    github_token: str | None = Field(default=None, validation_alias=AliasChoices("GITHUB_TOKEN", "GH_TOKEN"))
    semantic_scholar_api_key: str | None = Field(default=None, validation_alias="SEMANTIC_SCHOLAR_API_KEY")

    # Optional LLM summaries; a template summary is used when neither key is set
    gemini_api_key: str | None = Field(default=None, validation_alias="GEMINI_API_KEY")
    gemini_model: str = Field(default="gemini-flash-lite-latest", validation_alias="GEMINI_MODEL")
    groq_api_key: str | None = Field(default=None, validation_alias="GROQ_API_KEY")
    groq_model: str = Field(default="llama-3.3-70b-versatile", validation_alias="GROQ_MODEL")

    # Local storage
    home: Path = Field(default_factory=_default_home, validation_alias="IDEATION_GOAT_HOME")
    index_dir_override: Path | None = Field(default=None, validation_alias="IDEATION_GOAT_INDEX_DIR")
    index_url: str = Field(default=DEFAULT_INDEX_URL, validation_alias="IDEATION_GOAT_INDEX_URL")
    embedding_model: str = Field(
        default="sentence-transformers/all-MiniLM-L6-v2", validation_alias="IDEATION_GOAT_EMBEDDING_MODEL"
    )

    # check_dependencies only reads folders inside this root (defaults to the working directory)
    workspace_root: Path = Field(default_factory=Path.cwd, validation_alias="IDEATION_GOAT_WORKSPACE")

    # HTTP behaviour
    http_timeout: float = Field(default=15.0, validation_alias="IDEATION_GOAT_HTTP_TIMEOUT")
    cache_enabled: bool = Field(default=True, validation_alias="IDEATION_GOAT_CACHE")

    @property
    def index_dir(self) -> Path:
        return self.index_dir_override or self.home / "index"

    @property
    def cache_path(self) -> Path:
        return self.home / "cache.sqlite"

    @property
    def user_agent(self) -> str:
        return f"ideation-goat (+{REPO_URL})"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

from pathlib import Path


REPO_ROOT = Path("/home/wah/Workspaces/MPF-Tracker")


def test_shared_directory_removed() -> None:
    assert not (REPO_ROOT / "shared").exists()


def test_required_module_entrypoints_exist() -> None:
    required_files = (
        REPO_ROOT / "crawler" / "api" / "src" / "index.ts",
        REPO_ROOT / "crawler" / "worker" / "src" / "worker.py",
        REPO_ROOT / "portfolio" / "src" / "index.ts",
        REPO_ROOT / "purchase" / "src" / "index.ts",
        REPO_ROOT / "valuation" / "src" / "index.ts",
    )
    for file_path in required_files:
        assert file_path.exists(), f"Missing required module entrypoint: {file_path}"


def test_only_crawler_has_worker_runtime() -> None:
    assert (REPO_ROOT / "crawler" / "worker").exists()
    assert not (REPO_ROOT / "portfolio" / "worker").exists()
    assert not (REPO_ROOT / "purchase" / "worker").exists()
    assert not (REPO_ROOT / "valuation" / "worker").exists()

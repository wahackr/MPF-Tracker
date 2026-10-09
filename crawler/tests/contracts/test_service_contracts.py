from pathlib import Path
import re


REPO_ROOT = Path(__file__).resolve().parents[3]


def test_shared_directory_removed() -> None:
    assert not (REPO_ROOT / "shared").exists()


def test_required_module_entrypoints_exist() -> None:
    required_files = (
        REPO_ROOT / "crawler" / "api" / "src" / "index.ts",
        REPO_ROOT / "crawler" / "worker" / "src" / "app.py",
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


def test_typescript_services_have_no_cross_service_imports() -> None:
    service_roots = {
        "crawler": REPO_ROOT / "crawler" / "api",
        "portfolio": REPO_ROOT / "portfolio",
        "purchase": REPO_ROOT / "purchase",
        "valuation": REPO_ROOT / "valuation",
    }
    import_pattern = re.compile(r"""from\s+["']([^"']+)["']""")

    for service_name, root in service_roots.items():
        for file_path in root.rglob("*.ts"):
            content = file_path.read_text(encoding="utf-8")
            for specifier in import_pattern.findall(content):
                if specifier.startswith("."):
                    continue
                for other_service in service_roots:
                    if other_service == service_name:
                        continue
                    assert (
                        specifier != other_service and not specifier.startswith(f"{other_service}/")
                    ), f"Cross-service import in {file_path}: {specifier}"


def test_worker_has_no_app_level_service_imports() -> None:
    forbidden = ("portfolio", "purchase", "valuation")
    import_pattern = re.compile(r"""^\s*(?:from|import)\s+([a-zA-Z0-9_\.]+)""", re.MULTILINE)

    for file_path in (REPO_ROOT / "crawler" / "worker" / "src").rglob("*.py"):
        content = file_path.read_text(encoding="utf-8")
        for module_name in import_pattern.findall(content):
            top_level = module_name.split(".")[0]
            assert top_level not in forbidden, f"Worker imports forbidden service module {module_name} in {file_path}"

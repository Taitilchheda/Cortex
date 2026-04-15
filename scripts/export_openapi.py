"""Export FastAPI OpenAPI schema for client contract checks."""
import json
from pathlib import Path

from server.main import app


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "openapi.json"
    out_file.write_text(json.dumps(app.openapi(), indent=2), encoding="utf-8")
    print(f"Wrote {out_file}")


if __name__ == "__main__":
    main()

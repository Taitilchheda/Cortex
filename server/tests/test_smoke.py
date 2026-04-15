from fastapi.testclient import TestClient

from main import app


def test_health_and_contracts() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200

        contracts = client.get("/health/contracts")
        assert contracts.status_code == 200
        payload = contracts.json()
        assert payload.get("status") == "ok"


def test_files_tree_shape() -> None:
    with TestClient(app) as client:
        resp = client.get("/files/tree", params={"path": "F:/Cortex", "depth": 1})
        assert resp.status_code == 200
        data = resp.json()
        assert "tree" in data
        assert "files" in data


def test_preferences_tools_and_queue() -> None:
    with TestClient(app) as client:
        tools = client.get("/tools/registry")
        assert tools.status_code == 200
        assert isinstance(tools.json().get("tools"), list)

        set_pref = client.post("/settings/preferences", json={"key": "smoke.flag", "value": True})
        assert set_pref.status_code == 200

        prefs = client.get("/settings/preferences")
        assert prefs.status_code == 200
        assert prefs.json().get("preferences", {}).get("smoke.flag") is True

        queued = client.post("/queue", json={"task": "smoke-task", "mode": "chat"})
        assert queued.status_code == 200
        task_id = queued.json().get("task", {}).get("id")
        assert task_id

        listed = client.get("/queue")
        assert listed.status_code == 200
        ids = {t.get("id") for t in listed.json().get("tasks", [])}
        assert task_id in ids

        deleted = client.delete(f"/queue/{task_id}")
        assert deleted.status_code == 200

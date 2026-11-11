from fastapi.testclient import TestClient

from myvideo_ai.app import create_app


def test_health_reports_ok_and_python_312():
    client = TestClient(create_app())
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "myvideo-ai"
    assert body["python"].startswith("3.12.")


def test_docs_are_disabled():
    client = TestClient(create_app())
    assert client.get("/docs").status_code == 404

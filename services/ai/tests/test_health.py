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


def test_asr_info_names_the_model_without_loading_it():
    app = create_app()
    client = TestClient(app)
    res = client.get("/asr/info")
    assert res.status_code == 200
    body = res.json()
    assert body["engine"] == "whisper.cpp"
    assert body["model"].endswith(".bin")
    assert body["language"] == "th"
    assert app.state.asr.proc is None  # info must not start the model process

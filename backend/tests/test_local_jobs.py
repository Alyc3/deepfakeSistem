"""Análisis sin worker: la API ejecuta el trabajo y la web lo sigue igual. Sin red, BD ni modelos."""
import asyncio
import threading
import time
import uuid
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import local_jobs
from app.auth_service import get_current_perito
from app.database import get_db
from app.forensic_routes import INTERRUPTED_DETAIL, queue_analysis, router, use_worker
from app.identity import require_identity


def wait_for(condition, seconds=3.0):
    limit = time.monotonic() + seconds
    while time.monotonic() < limit:
        if condition():
            return True
        time.sleep(0.01)
    return False


class LocalRunnerTests(TestCase):
    def test_jobs_run_one_at_a_time_and_publish_progress_and_result(self):
        gate, first, second = threading.Event(), str(uuid.uuid4()), str(uuid.uuid4())

        def slow(report):
            report({"stage": "inference", "message": "Fotograma 1", "current": 1, "total": 24})
            gate.wait(3)
            return {"prediction": "Real"}
        local_jobs.submit(first, slow)
        local_jobs.submit(second, lambda report: {"prediction": "Fake"})
        self.assertTrue(wait_for(lambda: (local_jobs.status(first)["progress"] or {}).get("current") == 1))
        self.assertEqual(local_jobs.status(first)["state"], "PROCESSING")
        self.assertEqual(local_jobs.status(second)["state"], "QUEUED")  # espera su turno
        gate.set()
        self.assertTrue(wait_for(lambda: local_jobs.status(second)["state"] == "COMPLETED"))
        self.assertEqual(local_jobs.status(first)["result"], {"prediction": "Real"})
        self.assertEqual(local_jobs.status(second)["result"], {"prediction": "Fake"})

    def test_a_failed_job_does_not_stop_the_runner(self):
        broken, healthy = str(uuid.uuid4()), str(uuid.uuid4())

        def fail(report):
            raise RuntimeError("fallo de inferencia")
        local_jobs.submit(broken, fail)
        local_jobs.submit(healthy, lambda report: {"ok": True})
        self.assertTrue(wait_for(lambda: local_jobs.status(healthy)["state"] == "COMPLETED"))
        self.assertEqual(local_jobs.status(broken)["state"], "FAILED")

    def test_only_recent_results_are_kept_in_memory(self):
        ids = [str(uuid.uuid4()) for _ in range(local_jobs.KEEP_FINISHED + 3)]
        for job_id in ids:
            local_jobs.submit(job_id, lambda report: {"ok": True})
        self.assertTrue(wait_for(lambda: (local_jobs.status(ids[-1]) or {}).get("state") == "COMPLETED"))
        self.assertIsNone(local_jobs.status(ids[0]))
        self.assertIsNotNone(local_jobs.status(ids[-1]))


class ModeTests(TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.addCleanup(patch.stopall)

    def mode(self, value):
        patch.dict("os.environ", {"INFERENCE_MODE": value}).start()

    def test_explicit_modes_never_probe_the_broker(self):
        ping = patch("app.local_jobs.worker_responds").start()
        self.mode("local")
        self.assertFalse(use_worker(self.db))
        self.mode("worker")
        self.assertTrue(use_worker(self.db))
        ping.assert_not_called()

    def test_auto_uses_the_worker_only_when_one_answers_or_is_busy(self):
        self.mode("auto")
        patch("app.local_jobs.worker_responds", return_value=True).start()
        self.assertTrue(use_worker(self.db))
        patch("app.local_jobs.worker_responds", return_value=False).start()
        patch("app.local_jobs.recently_dispatched", return_value=[]).start()
        self.assertFalse(use_worker(self.db))  # sin worker: analiza la API
        # Un worker ocupado no contesta al ping, pero tiene sin terminar un trabajo que se le entregó.
        patch("app.local_jobs.recently_dispatched", return_value=[str(uuid.uuid4())]).start()
        patch("app.local_jobs.broker_reachable", return_value=True).start()
        self.db.query.return_value.filter.return_value.first.return_value = object()
        self.assertTrue(use_worker(self.db))
        self.db.query.return_value.filter.return_value.first.return_value = None
        self.assertFalse(use_worker(self.db))

    def test_broker_down_is_detected_quickly_without_celery_retries(self):
        patch("app.local_jobs.broker_url", "redis://127.0.0.1:1/0").start()
        patch("app.local_jobs._broker_check", (0.0, False)).start()
        celery = patch("app.local_jobs.celery_app").start()
        started = time.monotonic()
        self.assertFalse(local_jobs.worker_responds())
        self.assertLess(time.monotonic() - started, 4)
        celery.control.ping.assert_not_called()


class JobEndpointTests(TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.db = MagicMock()
        self.perito = SimpleNamespace(id=uuid.uuid4(), external_auth_id="external-test")
        user = {"id": "t", "email": "t@example.test", "status": "ACTIVO", "role": {"name": "PERITO"}}
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_perito] = lambda: self.perito
        app.dependency_overrides[require_identity] = lambda: user
        self.client = TestClient(app)
        self.addCleanup(patch.stopall)
        patch.dict("os.environ", {"INFERENCE_MODE": "auto"}).start()
        self.celery = patch("app.forensic_routes.celery_app").start()

    def job(self, status):
        row = SimpleNamespace(id=uuid.uuid4(), status=status, error_detail=None, report_id=None, updated_at=None)
        self.db.query.return_value.filter.return_value.first.return_value = row
        return row

    def test_queueing_without_a_worker_runs_in_the_api_and_the_same_polling_works(self):
        patch("app.forensic_routes.use_worker", return_value=False).start()
        patch("app.forensic_routes.audit").start()
        task = patch("app.forensic_routes.analyze_evidence_task").start()
        release = threading.Event()
        origins = []

        def analysis(case_id, evidence_id, perito_id, job_id, report_progress, origin):
            origins.append(origin)
            report_progress({"stage": "inference", "message": "Fotograma 3", "current": 3, "total": 24})
            release.wait(3)
            return {"prediction": "Fake", "report_id": "report-1"}
        patch("app.forensic_routes.run_analysis_job", side_effect=analysis).start()
        case, evidence = SimpleNamespace(id=uuid.uuid4()), SimpleNamespace(id=uuid.uuid4())
        queued = asyncio.run(queue_analysis(self.db, case, evidence, self.perito, MagicMock()))
        self.assertEqual((queued["status"], queued["mode"]), ("queued", "local"))
        task.apply_async.assert_not_called()

        self.job("PROCESSING")
        url = f"/api/v1/jobs/{queued['job_id']}"
        self.assertTrue(wait_for(lambda: (self.client.get(url).json().get("progress") or {}).get("current") == 3))
        self.assertEqual(self.client.get(url).json()["status"], "processing")
        release.set()
        self.assertTrue(wait_for(lambda: self.client.get(url).json()["status"] == "completed"))
        self.assertEqual(self.client.get(url).json()["result"]["prediction"], "Fake")
        self.assertEqual(origins, ["api-local"])
        self.celery.AsyncResult.assert_not_called()  # el modo local no toca Celery ni Redis

    def test_a_job_lost_in_a_restart_is_reported_as_interrupted(self):
        row = self.job("PROCESSING")
        patch("app.local_jobs.broker_reachable", return_value=False).start()
        response = self.client.get(f"/api/v1/jobs/{row.id}")
        self.assertEqual(response.json(), {"status": "failed", "job_id": str(row.id), "detail": INTERRUPTED_DETAIL})
        self.assertEqual(row.status, "FAILED")
        self.celery.AsyncResult.assert_not_called()

    def test_worker_jobs_still_report_through_celery(self):
        row = self.job("PROCESSING")
        patch("app.local_jobs.broker_reachable", return_value=True).start()
        self.celery.AsyncResult.return_value = SimpleNamespace(
            state="PROCESSING", info={"stage": "inference"}, failed=lambda: False, successful=lambda: False)
        body = self.client.get(f"/api/v1/jobs/{row.id}").json()
        self.assertEqual((body["status"], body["progress"]), ("processing", {"stage": "inference"}))

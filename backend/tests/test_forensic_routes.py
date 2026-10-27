import asyncio
import io
import uuid
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

from app.auth_service import get_current_perito
from app.database import get_db
from app.forensic_routes import router
from app.forensic_workflow import read_upload
from app.identity import require_identity
from app.storage.runtime import UploadSizeLimit


class ForensicRouteTests(TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.db = MagicMock()
        self.perito = SimpleNamespace(id=uuid.uuid4(), external_auth_id="external-test")
        self.user = {"id": "test", "email": "test@example.test", "status": "ACTIVO", "role": {"name": "PERITO"}}
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_perito] = lambda: self.perito
        self.app.dependency_overrides[require_identity] = lambda: self.user
        self.client = TestClient(self.app)
        self.case_id = str(uuid.uuid4())

    def test_other_users_case_cannot_be_ingested_or_analyzed(self):
        self.db.query.return_value.filter.return_value.first.return_value = None
        with patch("app.forensic_routes.get_storage") as storage:
            for endpoint in ["ingest", "analyze"]:
                result = self.client.post(f"/api/v1/cases/{self.case_id}/{endpoint}", files={"file": ("test.jpg", b"test", "image/jpeg")})
                self.assertEqual(result.status_code, 404)
            storage.assert_not_called()

    def test_cross_case_artifact_download_is_rejected_before_decryption(self):
        self.db.query.return_value.filter.return_value.first.side_effect = [SimpleNamespace(id=uuid.UUID(self.case_id)), None]
        with patch("app.forensic_routes.get_storage") as storage:
            result = self.client.get(f"/api/v1/cases/{self.case_id}/artifacts/{uuid.uuid4()}/download")
            self.assertEqual(result.status_code, 404)
            storage.assert_not_called()

    def test_guests_cannot_ingest_download_or_use_legacy_predict(self):
        self.user["role"]["name"] = "INVITADO"
        with patch("app.forensic_routes.get_storage") as storage:
            self.assertEqual(self.client.post("/predict", files={"file": ("test.jpg", b"test", "image/jpeg")}).status_code, 403)
            self.assertEqual(self.client.get(f"/api/v1/cases/{self.case_id}/artifacts").status_code, 403)
            storage.assert_not_called()

    def test_request_limit_is_enforced_before_multipart_processing(self):
        app = FastAPI()
        app.add_middleware(UploadSizeLimit, max_bytes=16)

        @app.post("/upload")
        async def endpoint():
            return {"ok": True}

        response = TestClient(app).post("/upload", content=b"X" * 17)
        self.assertEqual(response.status_code, 413)

    def test_empty_and_oversized_uploads_are_rejected(self):
        file = UploadFile(io.BytesIO(b""), filename="empty.jpg", headers=Headers({"content-type": "image/jpeg"}))
        with self.assertRaises(HTTPException) as rejected:
            asyncio.run(read_upload(file))
        self.assertEqual(rejected.exception.status_code, 422)
        file = UploadFile(io.BytesIO(b"X" * 9), filename="big.jpg", headers=Headers({"content-type": "image/jpeg"}))
        with patch("app.forensic_workflow.StorageConfig.from_env", return_value=SimpleNamespace(max_upload=8)):
            with self.assertRaises(HTTPException) as rejected:
                asyncio.run(read_upload(file))
        self.assertEqual(rejected.exception.status_code, 413)

    def test_untrusted_mime_does_not_reach_storage(self):
        file = UploadFile(io.BytesIO(b"<script>test</script>"), filename="evidence.html", headers=Headers({"content-type": "text/html"}))
        with self.assertRaises(HTTPException) as rejected:
            asyncio.run(read_upload(file))
        self.assertEqual(rejected.exception.status_code, 415)

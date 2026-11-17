"""Lista de expedientes: paginada, con búsqueda literal y resumen por expediente. Sin red, BD ni modelos."""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth_service import get_current_perito
from app.database import get_db
from app.forensic_routes import _like, router
from app.identity import require_identity


class CaseListTests(TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.db = MagicMock()
        perito = SimpleNamespace(id=uuid.uuid4(), external_auth_id="external-test")
        user = {"id": "t", "email": "t@example.test", "status": "ACTIVO", "role": {"name": "PERITO"}}
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_perito] = lambda: perito
        app.dependency_overrides[require_identity] = lambda: user
        self.client = TestClient(app)

    def test_page_reports_total_and_a_summary_per_case(self):
        case = SimpleNamespace(id=uuid.uuid4(), case_number="FGE-2026-0001", title="Caso", description="x" * 300,
                               created_at=datetime(2026, 11, 10, tzinfo=timezone.utc))
        query = self.db.query.return_value.filter.return_value
        query.count.return_value = 37
        query.order_by.return_value.offset.return_value.limit.return_value.all.return_value = [case]
        self.db.query.return_value.filter.return_value.group_by.return_value.all.return_value = [(case.id, 2)]
        self.db.query.return_value.join.return_value.filter.return_value.order_by.return_value.all.return_value = [
            (case.id, "MANIPULADO"), (case.id, "SIN_MANIPULACION")]
        body = self.client.get("/api/v1/cases?offset=10&limit=10").json()
        self.assertEqual((body["total"], body["offset"], body["limit"]), (37, 10, 10))
        item = body["items"][0]
        self.assertEqual((item["evidences"], item["verdict"]), (2, "MANIPULADO"))  # el dictamen más reciente
        self.assertEqual(len(item["description"]), 160)
        query.order_by.return_value.offset.assert_called_with(10)

    def test_paging_and_search_are_bounded(self):
        for url in ["/api/v1/cases?limit=0", "/api/v1/cases?limit=51", "/api/v1/cases?offset=-1", f"/api/v1/cases?q={'x' * 101}"]:
            self.assertEqual(self.client.get(url).status_code, 422, url)

    def test_search_treats_wildcards_literally(self):
        self.assertEqual(_like("50%_off"), "%50\\%\\_off%")
        self.assertEqual(_like("a\\b"), "%a\\\\b%")

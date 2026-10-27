"""Pruebas sin red, BD ni modelos de inferencia."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.identity import require_identity, require_laboratory
from app.identity_routes import router

USER = {"id": "remote-user", "email": "perito@example.test", "status": "ACTIVO", "role": {"id": "role-1", "name": "ADMINISTRADOR"}}


class IdentityTests(unittest.TestCase):
    def setUp(self):
        patch.dict("os.environ", {"ROLE_PERMISSIONS": '{"ADMINISTRADOR":["users","roles","laboratory"],"PERITO":["laboratory"],"INVITADO":[]}'}).start()
        app = FastAPI()
        app.include_router(router)

        @app.post("/predict", dependencies=[Depends(require_laboratory)])
        def protected_prediction():
            return {"ok": True}

        self.client = TestClient(app)
        self.request = patch("app.identity.httpx.AsyncClient.request", new_callable=AsyncMock).start()
        self.addCleanup(patch.stopall)
        self.headers = {"Authorization": "Bearer example-token"}

    def response(self, code, body=None):
        return httpx.Response(code, json=body, request=httpx.Request("GET", "https://identity.test"))

    def test_login_validates_profile_and_does_not_cache_response(self):
        self.request.side_effect = [self.response(200, {"access_token": "example-token", "token_type": "bearer"}), self.response(200, USER)]
        result = self.client.post("/api/v1/auth/login", json={"email": USER["email"], "password": "test-only"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["user"], USER)
        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertEqual(self.request.call_args_list[0].kwargs["json"]["email"], USER["email"])
        self.assertEqual(self.request.call_args_list[1].kwargs["headers"], self.headers)

    def test_protected_endpoints_require_token(self):
        for path in ["/api/v1/auth/me", "/api/v1/users", "/api/v1/roles"]:
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post("/predict").status_code, 401)
        self.request.assert_not_called()

    def test_rejected_token_has_no_unsigned_fallback(self):
        self.request.return_value = self.response(401, {"detail": "expired"})
        result = self.client.get("/api/v1/auth/me", headers=self.headers)
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.request.call_count, 1)

    def test_only_active_accounts_are_admitted(self):
        for status in ["SUSPENDIDO", "INACTIVO", "PENDIENTE"]:
            self.request.return_value = self.response(200, {**USER, "status": status})
            self.assertEqual(self.client.get("/api/v1/users", headers=self.headers).status_code, 403)

    def test_upstream_role_permissions_are_enforced(self):
        self.request.side_effect = [self.response(200, USER), self.response(403, {})]
        self.assertEqual(self.client.get("/api/v1/users", headers=self.headers).status_code, 403)

    def test_analyst_cannot_reach_management_even_if_provider_would_allow_it(self):
        self.request.return_value = self.response(200, {**USER, "role": {"id": "perito", "name": "PERITO"}})
        self.assertEqual(self.client.get("/api/v1/users", headers=self.headers).status_code, 403)
        self.assertEqual(self.request.call_count, 1)

    def test_guest_and_unknown_roles_cannot_analyze(self):
        for role in ["INVITADO", "UNRECOGNIZED"]:
            self.request.return_value = self.response(200, {**USER, "role": {"id": "role", "name": role}})
            self.assertEqual(self.client.post("/predict", headers=self.headers).status_code, 403)

    def test_analyst_can_analyze(self):
        self.request.return_value = self.response(200, {**USER, "role": {"id": "perito", "name": "PERITO"}})
        self.assertEqual(self.client.post("/predict", headers=self.headers).status_code, 200)

    def test_user_update_forwards_contract(self):
        self.request.side_effect = [self.response(200, USER), self.response(200, {**USER, "status": "SUSPENDIDO"})]
        result = self.client.patch("/api/v1/users/remote-user", headers=self.headers, json={"status": "SUSPENDIDO", "role_name": "PERITO"})
        self.assertEqual(result.status_code, 200)
        args = self.request.call_args
        self.assertEqual(args.args[0], "PATCH")
        self.assertTrue(args.args[1].endswith("/api/users/remote-user"))
        self.assertEqual(args.kwargs["json"], {"status": "SUSPENDIDO", "role_name": "PERITO"})

    def test_roles_and_registration_contracts(self):
        operations = [
            ("post", "/api/v1/users", {"email": "new@example.test", "password": "test-only", "role_name": "PERITO"}, "/api/auth/register", 201),
            ("post", "/api/v1/roles", {"name": "PERITO"}, "/api/roles/", 201),
            ("put", "/api/v1/roles/role-1", {"name": "PERITO"}, "/api/roles/role-1", 200),
        ]
        for method, path, body, upstream, status in operations:
            self.request.side_effect = [self.response(200, USER), self.response(status, body)]
            result = getattr(self.client, method)(path, headers=self.headers, json=body)
            self.assertEqual(result.status_code, status)
            self.assertTrue(self.request.call_args.args[1].endswith(upstream))

    def test_role_deletion_handles_empty_response(self):
        self.request.side_effect = [self.response(200, USER), self.response(204)]
        result = self.client.delete("/api/v1/roles/role-1", headers=self.headers)
        self.assertEqual(result.status_code, 204)
        self.assertEqual(result.content, b"")

    def test_unavailable_service_fails_closed(self):
        self.request.side_effect = httpx.ConnectError("offline")
        self.assertEqual(self.client.get("/api/v1/auth/me", headers=self.headers).status_code, 503)

    def test_bad_provider_responses_are_rejected(self):
        self.request.return_value = self.response(200, {})
        self.assertEqual(self.client.get("/api/v1/auth/me", headers=self.headers).status_code, 502)
        self.assertEqual(self.client.post("/api/v1/auth/login", json={"email": USER["email"], "password": "test-only"}).status_code, 502)


if __name__ == "__main__":
    unittest.main()

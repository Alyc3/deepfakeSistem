"""Formato de los datos de entrada: sin red, BD ni modelos de inferencia."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.identity_routes import UserInput, UserUpdate, router
from app.schemas import CaseCreateSchema, FinalizeReportSchema
from app.validators import install_validation_handler, sha256_or_none

ADMIN = {"id": "remote-user", "email": "admin@example.test", "status": "ACTIVO", "role": {"id": "role-1", "name": "ADMINISTRADOR"}}


def messages(error: ValidationError) -> str:
    return " ".join(item["msg"] for item in error.errors())


class SchemaTests(unittest.TestCase):
    def test_names_accept_only_letters(self):
        for name in ["María José", "Núñez", "O'Brien", "Pérez-Gómez"]:
            self.assertEqual(UserInput(email="a@b.co", password="x", role_name="PERITO", first_name=name).first_name, name)
        for name in ["Juan2", "Ana_", "123"]:
            with self.assertRaises(ValidationError) as raised:
                UserInput(email="a@b.co", password="x", role_name="PERITO", first_name=name)
            self.assertIn("Solo admite letras", messages(raised.exception))

    def test_numeric_fields_accept_only_digits(self):
        self.assertEqual(UserInput(email="a@b.co", password="x", role_name="PERITO", identifier="1104567890").identifier, "1104567890")
        for identifier in ["110456789A", "11045", "110-456-7890"]:
            with self.assertRaises(ValidationError):
                UserInput(email="a@b.co", password="x", role_name="PERITO", identifier=identifier)
        self.assertEqual(UserInput(email="a@b.co", password="x", role_name="PERITO", phone_number="+593 99 999 9999").phone_number, "+593 99 999 9999")
        with self.assertRaises(ValidationError):
            UserInput(email="a@b.co", password="x", role_name="PERITO", phone_number="099-ABC-1234")

    def test_emails_are_checked_and_lowercased(self):
        self.assertEqual(UserInput(email=" Perito@UNL.edu.ec ", password="x", role_name="PERITO").email, "perito@unl.edu.ec")
        for email in ["perito", "perito@", "perito@unl", "per ito@unl.edu.ec"]:
            with self.assertRaises(ValidationError):
                UserInput(email=email, password="x", role_name="PERITO")

    def test_new_accounts_can_only_start_active_or_pending(self):
        self.assertEqual(UserInput(email="a@b.co", password="x", role_name="PERITO", status="PENDIENTE").status, "PENDIENTE")
        for status in ["INACTIVO", "SUSPENDIDO"]:
            with self.assertRaises(ValidationError):
                UserInput(email="a@b.co", password="x", role_name="PERITO", status=status)
        self.assertEqual(UserUpdate(status="INACTIVO").status, "INACTIVO")  # al editar sí se puede

    def test_update_fields_can_be_cleared_but_email_cannot(self):
        self.assertIsNone(UserUpdate(phone_number=None).phone_number)
        with self.assertRaises(ValidationError):
            UserUpdate(email=None)
        self.assertEqual(UserUpdate().model_dump(exclude_unset=True), {})

    def test_case_number_title_and_conclusions(self):
        case = CaseCreateSchema(case_number=" fge-2026-0001 ", title="  Suplantación   en video ", description="  ")
        self.assertEqual((case.case_number, case.title, case.description), ("FGE-2026-0001", "Suplantación en video", None))
        for data in [{"case_number": "caso con espacios", "title": "Caso válido"}, {"case_number": "FGE-1", "title": "12345"},
                     {"case_number": "FGE-1", "title": "Caso", "extra": "x"}]:
            with self.assertRaises(ValidationError):
                CaseCreateSchema(**data)
        for text in ["corto", "1234567890", "Revisión\x00oculta del caso"]:
            with self.assertRaises(ValidationError):
                FinalizeReportSchema(expert_conclusions=text)

    def test_declared_hash_must_be_hexadecimal(self):
        self.assertEqual(sha256_or_none(" " + "A" * 64 + " "), "a" * 64)
        self.assertIsNone(sha256_or_none(""))
        for value in ["g" * 64, "a" * 63]:
            with self.assertRaises(HTTPException) as raised:
                sha256_or_none(value)
            self.assertEqual(raised.exception.status_code, 422)


class RouteTests(unittest.TestCase):
    def setUp(self):
        patch.dict("os.environ", {"ROLE_PERMISSIONS": '{"ADMINISTRADOR":["users","roles","laboratory"]}'}).start()
        app = FastAPI()
        app.include_router(router)
        install_validation_handler(app)
        self.client = TestClient(app)
        self.request = patch("app.identity.httpx.AsyncClient.request", new_callable=AsyncMock).start()
        self.request.return_value = httpx.Response(200, json=ADMIN, request=httpx.Request("GET", "https://identity.test"))
        self.addCleanup(patch.stopall)
        self.headers = {"Authorization": "Bearer example-token"}

    def test_invalid_user_is_rejected_in_spanish_before_reaching_the_service(self):
        body = {"email": "nuevo@example.test", "password": "x", "role_name": "PERITO", "first_name": "Ana3", "identifier": "11A4567890"}
        response = self.client.post("/api/v1/users", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 422)
        payload = response.json()
        self.assertIsInstance(payload["detail"], str)
        self.assertEqual(len(payload["errors"]), 2)
        self.assertIn("Identificación: Solo admite números", payload["detail"])
        upstream = [call.args[1] for call in self.request.call_args_list]
        self.assertFalse(any(url.endswith("/api/auth/register") for url in upstream))

    def test_invalid_role_name_is_rejected(self):
        response = self.client.post("/api/v1/roles", headers=self.headers, json={"name": "rol con espacios"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("Nombre del rol", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()

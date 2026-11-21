"""La documentación de la API (ReDoc) debe cubrir todos los endpoints."""
from unittest import TestCase

from fastapi import FastAPI

from app.api_docs import TAGS
from app.forensic_routes import router as forensic_router
from app.identity_routes import router as identity_router


class ApiDocumentationTests(TestCase):
    def setUp(self):
        app = FastAPI(openapi_tags=TAGS)
        app.include_router(identity_router)
        app.include_router(forensic_router)
        self.spec = app.openapi()
        self.operations = [(method.upper(), path, operation) for path, methods in self.spec["paths"].items()
                           for method, operation in methods.items()]

    def test_every_endpoint_is_explained(self):
        for method, path, operation in self.operations:
            with self.subTest(endpoint=f"{method} {path}"):
                self.assertTrue(operation.get("summary"), "falta summary")
                self.assertGreater(len(operation.get("description", "")), 40, "falta una descripción")
                self.assertEqual(len(operation.get("tags", [])), 1, "debe tener exactamente un grupo")

    def test_every_tag_is_declared(self):
        declared = {tag["name"] for tag in TAGS}
        used = {tag for _, _, operation in self.operations for tag in operation["tags"]}
        self.assertLessEqual(used, declared)

    def test_success_and_error_responses_are_documented(self):
        for method, path, operation in self.operations:
            with self.subTest(endpoint=f"{method} {path}"):
                codes = set(operation["responses"])
                self.assertTrue(codes & {"200", "201", "202", "204"}, "falta la respuesta de éxito")
                self.assertIn("401", codes)

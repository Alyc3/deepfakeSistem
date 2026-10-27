import base64
import io
import json
import os
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
from botocore.config import Config
from botocore.stub import Stubber
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.forensic_storage import ForensicStorage
from app.storage.adapters import LocalObjectStore, S3ObjectStore
from app.storage.config import StorageConfig
from app.storage.ports import Artifact, IntegrityError, RetentionNotVerified, WriteConflict
from app.storage.retention import RetentionGuard
from app.storage.sealing import Sealer, canonical_json, public_id, sha256


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = replace(StorageConfig.from_env(), local=True, root=Path(self.temp.name), require_retention=False)
        self.sealer = Sealer({"test-key": os.urandom(32)}, "test-key", Ed25519PrivateKey.generate(), {})
        self.store = LocalObjectStore(self.config)
        self.guard = MagicMock()
        self.guard.check.return_value = {"verified": False, "mode": "test"}
        self.storage = ForensicStorage(self.config, self.store, self.sealer, self.guard)
        self.case, self.evidence, self.owner = [str(uuid.uuid4()) for _ in range(3)]
        self.data = b"raw original test evidence"

    def ingest(self, evidence=None, name="sample.mp4"):
        return self.storage.ingest(self.data, name, "video/mp4", self.case, evidence or self.evidence, self.owner, "external-user-test")

    def test_original_working_and_manifest_are_independently_encrypted_and_verified(self):
        bundle = self.ingest()
        self.assertEqual(len(bundle.artifacts), 2)
        original, working = bundle.artifacts
        self.assertEqual(original.sha256, working.sha256)
        self.assertEqual(self.storage.read(working), self.data)
        self.storage.verify(working, bundle.manifest, self.case, self.evidence, self.owner)
        self.assertNotEqual(self.store.read(original.uri)[1], self.store.read(working.uri)[1])
        for path in Path(self.temp.name).rglob("*.enc"):
            self.assertNotIn(self.data, path.read_bytes())

    def test_reusing_a_filename_never_replaces_an_original(self):
        first = self.ingest()
        second = self.ingest(evidence=str(uuid.uuid4()))
        self.assertNotEqual(first.artifacts[0].uri, second.artifacts[0].uri)
        self.assertEqual(self.storage.read(first.artifacts[0]), self.data)

    def test_concurrent_create_once_contract_rejects_existing_key(self):
        self.ingest()
        with self.assertRaises(WriteConflict):
            self.ingest()

    def test_traversal_in_received_name_does_not_determine_storage_path(self):
        bundle = self.ingest(name="../../other/evil.mp4")
        self.assertNotIn("evil", bundle.artifacts[0].uri)
        self.assertFalse((Path(self.temp.name).parent / "other" / "evil.mp4").exists())
        with self.assertRaises(IntegrityError):
            self.store.put_once(self.config.prefix + "/../escape", b"test")

    def test_ciphertext_corruption_is_detected(self):
        bundle = self.ingest()
        key, data = self.store.read(bundle.artifacts[1].uri)
        path = self.store.path(key)
        os.chmod(path, 0o600)
        path.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
        with self.assertRaises(IntegrityError):
            self.storage.read(bundle.artifacts[1])

    def test_aad_prevents_moving_ciphertext_to_another_reference(self):
        original = self.ingest().artifacts[0]
        _, encrypted = self.store.read(original.uri)
        forged_key = self.config.prefix + "/moved/object.enc"
        uri = self.store.put_once(forged_key, encrypted)
        with self.assertRaises(IntegrityError):
            self.storage.read(replace(original, uri=uri))

    def test_database_hash_change_is_detected(self):
        artifact = self.ingest().artifacts[0]
        with self.assertRaises(IntegrityError):
            self.storage.read(replace(artifact, sha256="0" * 64))

    def test_owner_and_case_bindings_are_checked_against_signed_manifest(self):
        bundle = self.ingest()
        with self.assertRaises(IntegrityError):
            self.storage.verify(bundle.artifacts[0], bundle.manifest, self.case, self.evidence, str(uuid.uuid4()))
        with self.assertRaises(IntegrityError):
            self.storage.verify(bundle.artifacts[0], bundle.manifest, str(uuid.uuid4()), self.evidence, self.owner)

    def test_forged_manifest_signature_is_rejected(self):
        other = Sealer({"test-key": os.urandom(32)}, "test-key", Ed25519PrivateKey.generate(), {})
        with self.assertRaises(IntegrityError):
            self.sealer.verify_manifest(other.sign_manifest({"owner": "attacker"}))

    def test_retention_failure_prevents_any_upload(self):
        self.guard.check.side_effect = RetentionNotVerified("not locked")
        with self.assertRaises(RetentionNotVerified):
            self.ingest()
        self.assertEqual(list(Path(self.temp.name).rglob("*.enc")), [])

    def test_reports_and_human_revisions_are_new_objects_and_link_the_evidence(self):
        evidence = self.ingest()
        jpeg = b"\xff\xd8\xfftest-fixture"
        result = {"prediction": "Suspect", "confidence": 51, "explanation": {"image": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode(), "frames": []}}
        report_id = str(uuid.uuid4())
        first = self.storage.archive_report(result, self.case, self.evidence, report_id, self.owner, "external-user-test", evidence.manifest, evidence.artifacts[0], {"test": True})
        self.assertIn("image", result["explanation"])
        self.assertEqual([a.kind for a in first.artifacts], ["plate", "report"])
        report = first.artifacts[-1]
        document = json.loads(self.storage.read(report))
        self.assertEqual(document["original_sha256"], sha256(self.data))
        self.assertNotIn("image", document["result"]["explanation"])
        payload = self.storage.verify(report, first.manifest, self.case, self.evidence, self.owner, report_id)
        self.assertEqual(payload["report_id"], report_id)
        second = self.storage.archive_report({"expert_conclusions": "Reviewed"}, self.case, self.evidence, report_id, self.owner, "external-user-test", evidence.manifest, evidence.artifacts[0], {"test": True}, {"uri": report.uri, "sha256": report.sha256})
        self.assertNotEqual(first.manifest.uri, second.manifest.uri)
        self.assertEqual(json.loads(self.storage.read(second.artifacts[-1]))["previous_revision"]["sha256"], report.sha256)

    def test_key_rotation_can_keep_old_objects_and_signatures_readable(self):
        bundle = self.ingest()
        rotated = Sealer({**self.sealer.keys, "new": os.urandom(32)}, "new", Ed25519PrivateKey.generate(), {self.sealer.signing_id: self.sealer.signing_key.public_key()})
        storage = ForensicStorage(self.config, self.store, rotated, self.guard)
        self.assertEqual(storage.read(bundle.artifacts[0]), self.data)
        storage.verify(bundle.artifacts[0], bundle.manifest, self.case, self.evidence, self.owner)

    def test_local_storage_does_not_claim_worm_retention(self):
        guard = RetentionGuard(replace(self.config, require_retention=True))
        with self.assertRaises(RetentionNotVerified):
            guard.check()

    def test_s3_put_is_conditional_and_does_not_request_public_acl(self):
        config = replace(self.config, local=False)
        client = boto3.client("s3", region_name="auto", aws_access_key_id="fixture", aws_secret_access_key="fixture", endpoint_url="https://storage.example.test", config=Config(signature_version="s3v4"))
        store = S3ObjectStore(config, client)
        key = config.prefix + "/test/object.enc"
        with Stubber(client) as stub:
            stub.add_client_error("put_object", service_error_code="PreconditionFailed", http_status_code=412)
            with self.assertRaises(WriteConflict):
                store.put_once(key, b"encrypted fixture")
        with self.assertRaises(IntegrityError):
            store.read("s3://foreign-bucket/" + key)

    def test_retention_guard_checks_private_domains_and_indefinite_coverage(self):
        config = replace(self.config, local=False, require_retention=True)
        rules = {"rules": [{"id": "test", "enabled": True, "prefix": config.prefix + "/", "condition": {"type": "Indefinite"}}]}
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "fixture-token"}), patch.object(RetentionGuard, "_get", side_effect=[rules, {"enabled": False}, {"domains": []}]):
            self.assertTrue(RetentionGuard(config).check()["verified"])
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "fixture-token"}), patch.object(RetentionGuard, "_get", side_effect=[rules, {"enabled": True}, {"domains": []}]):
            with self.assertRaises(RetentionNotVerified):
                RetentionGuard(config).check()
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "fixture-token"}), patch.object(RetentionGuard, "_get", side_effect=[{"rules": []}, {"enabled": False}, {"domains": []}]):
            with self.assertRaises(RetentionNotVerified):
                RetentionGuard(config).check()


if __name__ == "__main__":
    unittest.main()

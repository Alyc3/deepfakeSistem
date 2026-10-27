"""Diagnóstico privado. --write-probe crea un objeto sintético retenido indefinidamente."""
import argparse
import uuid
from dataclasses import replace

from botocore.exceptions import ClientError

from app.forensic_storage import ForensicStorage, get_storage
from app.storage.adapters import S3ObjectStore
from app.storage.ports import WriteConflict
from app.storage.sealing import canonical_json, sha256


def check(write_probe=False, workflow_probe=False):
    storage = get_storage()
    storage.store.check()
    status = storage.retention.check()
    print("Acceso al almacén: correcto; retención verificada:", status["verified"])
    if not write_probe and not workflow_probe:
        return
    if not isinstance(storage.store, S3ObjectStore) or not status["verified"]:
        raise RuntimeError("La prueba real requiere S3 y retención verificada")
    key = f"{storage.config.prefix}/_checks/{uuid.uuid4()}/storage-probe.enc"
    data = canonical_json({"purpose": "certiface-storage-self-test", "contains_evidence": False})
    encrypted = storage.sealer.encrypt(data, key)
    uri = storage.store.put_once(key, encrypted)
    stored_key, persisted = storage.store.read(uri)
    if storage.sealer.decrypt(persisted, stored_key, sha256(data)) != data:
        raise RuntimeError("Falló la recuperación cifrada")
    client, bucket = storage.store.client, storage.config.bucket
    # Solo se intenta modificar/borrar el objeto sintético creado en esta ejecución.
    # No acepta claves de objetos preexistentes ni datos personales.
    for operation in ["overwrite", "delete"]:
        try:
            if operation == "overwrite":
                client.put_object(Bucket=bucket, Key=key, Body=encrypted, ContentType="application/octet-stream")
            else:
                client.delete_object(Bucket=bucket, Key=key)
        except ClientError as error:
            code = str(error.response.get("Error", {}).get("Code"))
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") not in (400, 403, 409, 412):
                raise RuntimeError("No se pudo comprobar la protección") from None
            print(f"Protección remota {operation}: rechazo confirmado ({code})")
        else:
            raise RuntimeError(f"El proveedor permitió {operation}: la retención no protege el objeto")
    print("Cifrado y recuperación: correctos. Objeto sintético conservado bajo _checks; no contiene evidencia")
    if workflow_probe:
        config = replace(storage.config, prefix=f"{storage.config.prefix}/_checks/{uuid.uuid4()}")
        sandbox = ForensicStorage(config, S3ObjectStore(config), storage.sealer)
        case, evidence, report, owner = [str(uuid.uuid4()) for _ in range(4)]
        bundle = sandbox.ingest(data, "synthetic-storage-self-test.bin", "application/octet-stream", case, evidence, owner, "storage-self-test")
        sandbox.verify(bundle.artifacts[1], bundle.manifest, case, evidence, owner)
        report_bundle = sandbox.archive_report({"self_test": True, "contains_evidence": False}, case, evidence, report, owner, "storage-self-test", bundle.manifest, bundle.artifacts[0], {"purpose": "storage-self-test; no inference"})
        report_artifact = report_bundle.artifacts[-1]
        sandbox.verify(report_artifact, report_bundle.manifest, case, evidence, owner, report)
        sandbox.read(report_artifact)
        print("Ingesta, copia, manifiestos y reporte JSON recuperados y verificados en R2; solo datos sintéticos bajo _checks")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-probe", action="store_true")
    parser.add_argument("--workflow-probe", action="store_true")
    args = parser.parse_args()
    check(args.write_probe, args.workflow_probe)

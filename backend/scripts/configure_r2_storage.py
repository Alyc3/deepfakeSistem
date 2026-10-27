"""Inspecciona R2. --apply añade una regla al prefijo forense sin eliminar reglas existentes."""
import argparse
import os

import httpx

from app.storage.config import StorageConfig
from app.storage.retention import RetentionGuard


def configure(apply=False):
    config = StorageConfig.from_env()
    if config.local:
        raise RuntimeError("Selecciona el almacenamiento remoto antes de configurar R2")
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    root = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{config.bucket}"
    with httpx.Client(timeout=20.0, headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}) as client:
        locks = RetentionGuard._get(client, root + "/lock")
        managed = RetentionGuard._get(client, root + "/domains/managed")
        domains = RetentionGuard._get(client, root + "/domains/custom")
        if managed.get("enabled") is not False or any(domain.get("enabled") is not False for domain in domains.get("domains", [])):
            raise RuntimeError("Hay acceso público. No se modificará un bucket compartido automáticamente")
        rules = locks.get("rules", [])
        prefix = config.prefix + "/"
        covered = any(rule.get("enabled") is True and (rule.get("condition") or {}).get("type") == "Indefinite" and prefix.startswith(rule.get("prefix") or "") for rule in rules)
        if not covered and not apply:
            print("Bucket privado. Falta Bucket Lock; ejecutar --apply para añadir la regla al prefijo forense")
            return
        if not covered:
            rule_id = "certiface-forensic-indefinite"
            if any(rule.get("id") == rule_id for rule in rules):
                raise RuntimeError("Existe una regla con el mismo ID pero distinta política; revísala manualmente")
            result = client.put(root + "/lock", json={"rules": [*rules, {"id": rule_id, "enabled": True, "prefix": prefix, "condition": {"type": "Indefinite"}}]})
            result.raise_for_status()
            if result.json().get("success") is not True:
                raise RuntimeError("R2 no confirmó la regla")
    status = RetentionGuard(config).check()
    print("Bucket privado y retención indefinida verificados para", status["prefix"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    configure(parser.parse_args().apply)

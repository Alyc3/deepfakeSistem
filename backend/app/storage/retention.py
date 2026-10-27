import os
from datetime import datetime, timezone

import httpx

from app.storage.config import StorageConfig
from app.storage.ports import RetentionNotVerified


class RetentionGuard:
    """Comprueba la regla real antes de cada preservación; nunca usa una bandera de éxito manual."""
    def __init__(self, config: StorageConfig):
        self.config = config

    def check(self) -> dict:
        if not self.config.require_retention:
            return {"verified": False, "mode": "development", "reason": "Retención no exigida explícitamente"}
        if self.config.local:
            raise RetentionNotVerified("El disco local no ofrece retención forense verificable")
        token = os.getenv("CLOUDFLARE_API_TOKEN", "")
        account = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
        if not token or not account:
            raise RetentionNotVerified("Falta un token de lectura de configuración R2 para verificar Bucket Lock y privacidad")
        if not self.config.endpoint.endswith(f"{account}.r2.cloudflarestorage.com"):
            raise RetentionNotVerified("El endpoint no coincide con la cuenta R2 configurada")
        try:
            root = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{self.config.bucket}"
            with httpx.Client(timeout=15.0, headers={"Authorization": f"Bearer {token}"}) as client:
                locks = self._get(client, root + "/lock")
                managed = self._get(client, root + "/domains/managed")
                custom = self._get(client, root + "/domains/custom")
            rules = locks.get("rules", [])
            covered = [rule for rule in rules if rule.get("enabled") is True and (rule.get("condition") or {}).get("type") == "Indefinite" and (self.config.prefix + "/").startswith(rule.get("prefix") or "")]
            if not covered:
                raise RetentionNotVerified("No hay una regla Bucket Lock indefinida que cubra el prefijo forense")
            domains = custom.get("domains", [])
            if managed.get("enabled") is not False or any(domain.get("enabled") is not False for domain in domains):
                raise RetentionNotVerified("El bucket no tiene su acceso público deshabilitado de forma verificable")
            return {"verified": True, "provider": "cloudflare-r2", "mode": "Indefinite", "prefix": self.config.prefix + "/", "rule_ids": [rule["id"] for rule in covered], "checked_at": datetime.now(timezone.utc).isoformat()}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise RetentionNotVerified("No se pudo verificar la retención y privacidad del bucket R2") from None

    @staticmethod
    def _get(client, url):
        response = client.get(url)
        response.raise_for_status()
        data = response.json()
        if data.get("success") is not True or not isinstance(data.get("result"), dict):
            raise ValueError()
        return data["result"]

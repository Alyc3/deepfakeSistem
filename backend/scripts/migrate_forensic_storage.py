"""Migración aditiva versionada. No borra ni reemplaza evidencias existentes."""
import argparse
import hashlib

import httpx
from sqlalchemy import text

from app.database import DATABASE_URL, database_url, engine
from app.storage.config import BACKEND

VERSION = "0001_forensic_archive"


def migrate(https=False, version=VERSION):
    source = (BACKEND / "migrations" / f"{version}.sql").read_bytes()
    checksum = hashlib.sha256(source).hexdigest()
    statements = [part.strip() for part in source.decode("utf-8").split("-- statement-break") if part.strip()]
    marker = f"INSERT INTO forensic_schema_migrations(version, checksum) VALUES ('{version}', '{checksum}') ON CONFLICT(version) DO NOTHING"
    if https:
        host = database_url.host or ""
        if not host.endswith(".neon.tech"):
            raise ValueError("El modo HTTPS requiere Neon")
        with httpx.Client(timeout=40) as client:
            def query(body):
                result = client.post(f"https://{host}/sql", headers={"Neon-Connection-String": DATABASE_URL}, json=body)
                if result.status_code != 200:
                    raise RuntimeError("Neon no confirmó la migración. Ninguna credencial se imprimió")
                return result.json()
            exists = query({"query": "SELECT to_regclass('public.forensic_schema_migrations') AS name", "params": []})
            if exists["rows"][0]["name"]:
                previous = query({"query": "SELECT checksum FROM forensic_schema_migrations WHERE version=$1", "params": [version]})
                if previous["rows"]:
                    if previous["rows"][0]["checksum"] != checksum:
                        raise RuntimeError("La migración aplicada no coincide: no se modificará")
                    print("Migración existente verificada")
                    return
            query({"queries": [{"query": sql, "params": []} for sql in ["SELECT pg_advisory_xact_lock(178403721)", *statements, marker]]})
    else:
        with engine.begin() as connection:
            connection.execute(text("SELECT pg_advisory_xact_lock(178403721)"))
            exists = connection.execute(text("SELECT to_regclass('public.forensic_schema_migrations')")).scalar()
            if exists:
                previous = connection.execute(text("SELECT checksum FROM forensic_schema_migrations WHERE version=:version"), {"version": version}).scalar()
                if previous:
                    if previous != checksum:
                        raise RuntimeError("La migración aplicada no coincide")
                    print("Migración existente verificada")
                    return
            for sql in [*statements, marker]:
                connection.exec_driver_sql(sql)
    print("Migración forense aplicada:", version)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--https", action="store_true")
    args = parser.parse_args()
    for migration in sorted((BACKEND / "migrations").glob("0*.sql")):
        migrate(args.https, migration.stem)

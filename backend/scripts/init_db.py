"""Inicialización aditiva de las tablas periciales, sin tocar tablas ajenas.

Ejecutar desde backend: python -m scripts.init_db
Para cambios posteriores de esquema, usar migraciones versionadas.
"""
import logging
import argparse
import httpx
from sqlalchemy import inspect, text
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects import postgresql
from app.database import Base, engine, DATABASE_URL, database_url
from app import models_db  # registra los modelos en Base.metadata


def initialize_database():
    with engine.begin() as connection:
        connection.execute(text("SELECT pg_advisory_xact_lock(178403721)"))
        existing = set(inspect(connection).get_table_names())
        Base.metadata.create_all(bind=connection, checkfirst=True)
        tables = set(Base.metadata.tables)
        logging.info("Base conectada. Tablas periciales disponibles: %d; creadas: %d", len(tables), len(tables - existing))
        return tables


def initialize_database_https():
    """Inicialización transaccional por HTTPS oficial de Neon si la red bloquea TCP.

    Esto no cambia el transporte del ORM: las operaciones de la API siguen
    necesitando acceso a PostgreSQL por el puerto 5432.
    """
    host = database_url.host or ""
    if not host.endswith(".neon.tech"):
        raise ValueError("El modo HTTPS solo está disponible para Neon")
    dialect = postgresql.dialect()
    queries = [{"query": "SELECT pg_advisory_xact_lock(178403721)", "params": []}]
    for table in Base.metadata.sorted_tables:
        queries.append({"query": str(CreateTable(table, if_not_exists=True).compile(dialect=dialect)), "params": []})
        for index in table.indexes:
            queries.append({"query": str(CreateIndex(index, if_not_exists=True).compile(dialect=dialect)), "params": []})
    queries.append({"query": "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name", "params": [list(Base.metadata.tables)]})
    with httpx.Client(timeout=30.0) as client:
        response = client.post(f"https://{host}/sql", headers={"Neon-Connection-String": DATABASE_URL}, json={"queries": queries})
        if response.status_code != 200:
            raise RuntimeError("Neon rechazó la inicialización HTTPS")
        results = response.json()
        last = results[-1] if isinstance(results, list) else results.get("results", [])[-1]
        logging.info("Tablas periciales disponibles por HTTPS: %s", ", ".join(row["table_name"] for row in last["rows"]))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--https", action="store_true", help="Crear tablas usando la API SQL HTTPS de Neon")
    args = parser.parse_args()
    try:
        initialize_database_https() if args.https else initialize_database()
    except Exception as error:
        logging.error("No se pudo inicializar PostgreSQL (%s). Revisa DATABASE_URL y la conectividad.", type(error).__name__)
        raise SystemExit(1)

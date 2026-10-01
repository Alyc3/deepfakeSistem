import os
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Cargar variables desde .env
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://neondb_owner:npg_Fqpske37cLnX@ep-rough-heart-acobr7v9-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require",
)

# Ajuste para psycopg2 si viene con postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Conexión sincronizada a PostgreSQL / Neon con pooler
engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependencia FastAPI para inyectar sesión de base de datos."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

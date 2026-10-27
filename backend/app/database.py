import os
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import declarative_base, sessionmaker

# Cargar variables desde .env
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

DATABASE_URL = os.environ["DATABASE_URL"]

# Ajuste para psycopg2 si viene con postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Conexión sincronizada a PostgreSQL / Neon con pooler
database_url = make_url(DATABASE_URL)
# SQLAlchemy 2.1 usa psycopg 3 por defecto; el proyecto instala psycopg2.
if database_url.drivername in ("postgres", "postgresql"):
    database_url = database_url.set(drivername="postgresql+psycopg2")

engine = create_engine(
    database_url,
    pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "5")),
    pool_pre_ping=True,
    pool_recycle=300,
    pool_timeout=15,
    connect_args={"connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT", "10"))},
    hide_parameters=True,
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

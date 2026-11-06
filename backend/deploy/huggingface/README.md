---
title: CertiFace API
emoji: 🔍
colorFrom: gray
colorTo: red
sdk: docker
app_port: 7860
startup_duration_timeout: 1h
pinned: false
---

# CertiFace API

Backend de peritaje forense para detección de deepfakes (FastAPI + Celery +
Redis en un solo contenedor). Este Space se publica desde `backend/` del
repositorio con `python deploy/huggingface/deploy.py`; no se edita aquí.

- Salud: `GET /health/live` (proceso) y `GET /health/ready` (PostgreSQL + R2).
- Documentación interactiva: `/docs`.

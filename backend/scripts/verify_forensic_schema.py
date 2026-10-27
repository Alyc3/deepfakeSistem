"""Prueba transaccional: los datos sintéticos se revierten al rechazar una mutación."""
import uuid

import httpx

from app.database import DATABASE_URL, database_url


def verify():
    if not (database_url.host or "").endswith(".neon.tech"):
        raise RuntimeError("La comprobación HTTPS requiere Neon")
    endpoint = "https://" + database_url.host + "/sql"
    with httpx.Client(timeout=30) as client:
        def query(body):
            response = client.post(endpoint, headers={"Neon-Connection-String": DATABASE_URL}, json=body)
            return response.status_code, response.json()
        for target in ["evidences", "analysis_reports", "stored_artifacts"]:
            perito, case, evidence, report, artifact = [str(uuid.uuid4()) for _ in range(5)]
            statements = [
                ("INSERT INTO peritos(id, external_auth_id, email, first_name, last_name, identifier, role_name) VALUES ($1::uuid,$1::text,'storage-probe@example.test','Storage','Probe','TEST','PERITO')", [perito]),
                ("INSERT INTO forensic_cases(id,case_number,title,perito_id) VALUES ($1::uuid,$1::text,'TRANSACTIONAL STORAGE PROBE',$2)", [case, perito]),
                ("INSERT INTO evidences(id,case_id,file_name,file_size_bytes,mime_type,sha256_original,sha256_working_copy,original_storage_uri,working_storage_uri) VALUES ($1,$2,'synthetic',0,'application/octet-stream',$3,$3,'probe://original','probe://working')", [evidence, case, "0" * 64]),
                ("INSERT INTO analysis_reports(id,evidence_id,perito_id,status) VALUES ($1,$2,$3,'TEST')", [report, evidence, perito]),
                ("INSERT INTO stored_artifacts(id,case_id,evidence_id,report_id,owner_id,kind,storage_uri,sha256,size_bytes,content_type,manifest_uri,manifest_sha256,manifest_size_bytes,signing_key_id,retention,created_at) VALUES ($1::uuid,$2,$3,$4,$5,'test',$1::text,$6,0,'application/json','probe://manifest',$6,0,$6,'{}'::jsonb,now())", [artifact, case, evidence, report, perito, "0" * 64]),
            ]
            reference = {"evidences": evidence, "analysis_reports": report, "stored_artifacts": artifact}[target]
            statements.append((f"DELETE FROM {target} WHERE id=$1", [reference]))
            status, response = query({"queries": [{"query": sql, "params": params} for sql, params in statements]})
            if status == 200 or response.get("code") != "42501":
                raise RuntimeError("No se confirmó la protección append-only en " + target + ": " + str(response.get("code")) + " " + str(response.get("message", ""))[:180])
            status, result = query({"query": "SELECT count(*)::int AS count FROM peritos WHERE id=$1", "params": [perito]})
            if status != 200 or result["rows"][0]["count"] != 0:
                raise RuntimeError("La transacción de prueba no fue revertida")
            print("Inmutabilidad de fila y rollback confirmados:", target)
        for mutation, expected_code, label in [
            ("UPDATE custody_audit_log SET action='CHANGED' WHERE perito_id=$1", "42501", "contenido de auditoría"),
            ("UPDATE custody_audit_log SET synced_to_central_audit=true WHERE perito_id=$1", "22012", "confirmación de entrega permitida"),
            ("UPDATE custody_audit_log SET synced_to_central_audit=NULL WHERE perito_id=$1", "42501", "estado de entrega protegido"),
        ]:
            perito = str(uuid.uuid4())
            batch = [
                {"query": "INSERT INTO peritos(id,external_auth_id,email,first_name,last_name,identifier,role_name) VALUES ($1::uuid,$1::text,'audit-probe@example.test','Audit','Probe','TEST','PERITO')", "params": [perito]},
                {"query": "INSERT INTO custody_audit_log(perito_id,action,ip_address,hash_verified,synced_to_central_audit,timestamp,details) VALUES ($1,'TEST','127.0.0.1',false,false,now(),'{}'::jsonb)", "params": [perito]},
                {"query": mutation, "params": [perito]},
                {"query": "SELECT 1/0", "params": []},
            ]
            status, result = query({"queries": batch})
            if status == 200 or result.get("code") != expected_code:
                raise RuntimeError("No se confirmó la política de auditoría: " + label + " / " + str(result.get("code")) + " " + str(result.get("message", ""))[:120])
            status, rows = query({"query": "SELECT count(*)::int AS count FROM peritos WHERE id=$1", "params": [perito]})
            if status != 200 or rows["rows"][0]["count"] != 0:
                raise RuntimeError("La prueba de auditoría no se revirtió")
            print("Política de auditoría y rollback confirmados:", label)



if __name__ == "__main__":
    verify()

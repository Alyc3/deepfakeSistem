
CREATE TABLE IF NOT EXISTS stored_artifacts (
	id UUID NOT NULL, 
	case_id UUID NOT NULL, 
	evidence_id UUID NOT NULL, 
	report_id UUID, 
	owner_id UUID NOT NULL, 
	kind VARCHAR(30) NOT NULL, 
	storage_uri TEXT NOT NULL, 
	sha256 VARCHAR(64) NOT NULL, 
	size_bytes BIGINT NOT NULL, 
	content_type VARCHAR(100) NOT NULL, 
	manifest_uri TEXT NOT NULL, 
	manifest_sha256 VARCHAR(64) NOT NULL, 
	manifest_size_bytes BIGINT NOT NULL, 
	signing_key_id VARCHAR(64) NOT NULL, 
	retention JSONB NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(case_id) REFERENCES forensic_cases (id), 
	FOREIGN KEY(evidence_id) REFERENCES evidences (id), 
	FOREIGN KEY(report_id) REFERENCES analysis_reports (id), 
	FOREIGN KEY(owner_id) REFERENCES peritos (id), 
	UNIQUE (storage_uri)
)



-- statement-break

CREATE INDEX IF NOT EXISTS ix_stored_artifacts_case_id ON stored_artifacts (case_id)

-- statement-break

CREATE INDEX IF NOT EXISTS ix_stored_artifacts_evidence_id ON stored_artifacts (evidence_id)

-- statement-break

CREATE INDEX IF NOT EXISTS ix_stored_artifacts_owner_id ON stored_artifacts (owner_id)

-- statement-break

CREATE INDEX IF NOT EXISTS ix_stored_artifacts_report_id ON stored_artifacts (report_id)

-- statement-break

CREATE TABLE IF NOT EXISTS forensic_schema_migrations (
 version varchar(80) PRIMARY KEY, checksum varchar(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)

-- statement-break

CREATE OR REPLACE FUNCTION certiface_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Forensic records are append-only' USING ERRCODE = '42501';
END;
$$

-- statement-break

CREATE OR REPLACE FUNCTION certiface_protect_custody() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Custody records cannot be deleted' USING ERRCODE = '42501';
 END IF;
 IF (to_jsonb(NEW) - 'synced_to_central_audit') IS DISTINCT FROM (to_jsonb(OLD) - 'synced_to_central_audit')
    OR (OLD.synced_to_central_audit AND NOT NEW.synced_to_central_audit) THEN
  RAISE EXCEPTION 'Custody event content is immutable' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END;
$$

-- statement-break

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'certiface_immutable_stored_artifacts' AND tgrelid = 'public.stored_artifacts'::regclass) THEN
  CREATE TRIGGER certiface_immutable_stored_artifacts BEFORE UPDATE OR DELETE ON public.stored_artifacts
  FOR EACH ROW EXECUTE FUNCTION certiface_deny_mutation();
 END IF;
END $$

-- statement-break

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'certiface_immutable_evidences' AND tgrelid = 'public.evidences'::regclass) THEN
  CREATE TRIGGER certiface_immutable_evidences BEFORE UPDATE OR DELETE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION certiface_deny_mutation();
 END IF;
END $$

-- statement-break

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'certiface_immutable_analysis_reports' AND tgrelid = 'public.analysis_reports'::regclass) THEN
  CREATE TRIGGER certiface_immutable_analysis_reports BEFORE UPDATE OR DELETE ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION certiface_deny_mutation();
 END IF;
END $$

-- statement-break

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'certiface_immutable_timecode_inconsistencies' AND tgrelid = 'public.timecode_inconsistencies'::regclass) THEN
  CREATE TRIGGER certiface_immutable_timecode_inconsistencies BEFORE UPDATE OR DELETE ON public.timecode_inconsistencies
  FOR EACH ROW EXECUTE FUNCTION certiface_deny_mutation();
 END IF;
END $$

-- statement-break

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'certiface_custody_append_only' AND tgrelid = 'public.custody_audit_log'::regclass) THEN
  CREATE TRIGGER certiface_custody_append_only BEFORE UPDATE OR DELETE ON public.custody_audit_log
  FOR EACH ROW EXECUTE FUNCTION certiface_protect_custody();
 END IF;
END $$

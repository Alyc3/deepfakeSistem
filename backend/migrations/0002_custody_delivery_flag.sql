CREATE OR REPLACE FUNCTION certiface_protect_custody() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Custody records cannot be deleted' USING ERRCODE = '42501';
 END IF;
 IF (to_jsonb(NEW) - 'synced_to_central_audit') IS DISTINCT FROM (to_jsonb(OLD) - 'synced_to_central_audit')
    OR (NEW.synced_to_central_audit IS DISTINCT FROM OLD.synced_to_central_audit
        AND NOT (OLD.synced_to_central_audit IS FALSE AND NEW.synced_to_central_audit IS TRUE)) THEN
  RAISE EXCEPTION 'Custody event content is immutable' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END;
$$

-- INV-14: the audit log is append-only. Reject UPDATE and DELETE (TRUNCATE too) at the database level.
CREATE FUNCTION audit_event_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_reject_mutation();

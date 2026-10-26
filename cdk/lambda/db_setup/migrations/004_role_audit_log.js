/**
 * Migration 004: Create role_audit_log
 *
 * Role changes (elevate/lower instructor, elevate/lower admin, and the one-off
 * bootstrapAdmin Lambda) previously wrote users.roles with no record of who
 * changed whose role, from what, to what (finding f-c6bc8cfe). This table is
 * that record. It's written in the same transaction as the users.roles update
 * by adminFunction and bootstrapAdmin, both of which connect as app_tc.
 *
 * Emails are stored alongside the user ids so the trail survives user
 * deletion (the FKs are ON DELETE SET NULL). actor_email is
 * 'bootstrap-admin-lambda' for the bootstrap path, which has no API caller.
 *
 * Idempotent: CREATE ... IF NOT EXISTS / DROP ... IF EXISTS.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS public.role_audit_log (
      audit_id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
      action character varying NOT NULL,
      actor_user_id uuid REFERENCES public.users (user_id) ON DELETE SET NULL,
      actor_email character varying NOT NULL,
      target_user_id uuid REFERENCES public.users (user_id) ON DELETE SET NULL,
      target_email character varying NOT NULL,
      old_roles character varying[] NOT NULL,
      new_roles character varying[] NOT NULL,
      created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
      CONSTRAINT role_audit_log_action_check CHECK (action IN (
        'elevate_instructor', 'lower_instructor',
        'elevate_admin', 'lower_admin', 'bootstrap_admin'
      ))
    )
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS role_audit_log_target_created_idx
      ON public.role_audit_log (target_user_id, created_at)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS public.role_audit_log_target_created_idx`);
  pgm.sql(`DROP TABLE IF EXISTS public.role_audit_log`);
};

/**
 * Migration 005: Audit instructor group assignments in role_audit_log
 *
 * POST /admin/enroll_instructor grants group-staff privilege (an
 * enrollments row with enrollment_type = 'instructor') but left no audit
 * record (finding f-0f827c5e). This allows the 'enroll_instructor' action
 * and adds simulation_group_id so the row says which group was granted.
 *
 * simulation_group_id has no foreign key on purpose: the audit trail must
 * survive deletion of the group, and role_audit_log is append-only for the
 * app roles (db_setup APPEND_ONLY_TABLES), so ON DELETE SET NULL would not
 * fit either.
 *
 * Idempotent: ADD/DROP COLUMN IF [NOT] EXISTS, DROP CONSTRAINT IF EXISTS.
 */

const BASE_ACTIONS = [
  "elevate_instructor",
  "lower_instructor",
  "elevate_admin",
  "lower_admin",
  "bootstrap_admin",
];

function actionCheck(actions) {
  return actions.map((a) => `'${a}'`).join(", ");
}

exports.up = (pgm) => {
  pgm.sql(
    `ALTER TABLE public.role_audit_log ADD COLUMN IF NOT EXISTS simulation_group_id uuid`,
  );
  pgm.sql(
    `ALTER TABLE public.role_audit_log DROP CONSTRAINT IF EXISTS role_audit_log_action_check`,
  );
  pgm.sql(`
    ALTER TABLE public.role_audit_log ADD CONSTRAINT role_audit_log_action_check
      CHECK (action IN (${actionCheck([...BASE_ACTIONS, "enroll_instructor"])}))
  `);
};

exports.down = (pgm) => {
  pgm.sql(
    `ALTER TABLE public.role_audit_log DROP CONSTRAINT IF EXISTS role_audit_log_action_check`,
  );
  // NOT VALID: audit rows are never deleted, so existing 'enroll_instructor'
  // rows must not block the rollback. New rows are still checked.
  pgm.sql(`
    ALTER TABLE public.role_audit_log ADD CONSTRAINT role_audit_log_action_check
      CHECK (action IN (${actionCheck(BASE_ACTIONS)})) NOT VALID
  `);
  pgm.sql(
    `ALTER TABLE public.role_audit_log DROP COLUMN IF EXISTS simulation_group_id`,
  );
};

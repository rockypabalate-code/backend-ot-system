const { query } = require('../database');
const { runStep } = require('./runner');

async function createOvertimePlanSignatureRecordsTable(executor = { query }) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_signature_records (
      signature_record_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
      signature_owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      acted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      signer_role TEXT NOT NULL,
      confirmation_method TEXT NOT NULL,
      signature_file_path TEXT NOT NULL,
      signature_mime_type TEXT,
      signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_signature_records_signer_role_check
        CHECK (signer_role IN ('employee', 'supervisor')),
      CONSTRAINT overtime_plan_signature_records_confirmation_method_check
        CHECK (confirmation_method IN ('self', 'supervisor_on_behalf')),
      CONSTRAINT overtime_plan_signature_records_status_check
        CHECK (status IN ('active', 'superseded'))
    );
  `);

  await executor.query(`
    CREATE INDEX IF NOT EXISTS overtime_plan_signature_records_plan_idx
    ON overtime_plan_signature_records (plan_id, employee_id, signed_at);
  `);
  await executor.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS overtime_plan_signature_records_active_idx
    ON overtime_plan_signature_records (plan_id, employee_id)
    WHERE status = 'active';
  `);
}

async function addOvertimePlanSignatureMimeTypeColumn(executor = { query }) {
  await executor.query(
    'ALTER TABLE overtime_plan_signature_records ADD COLUMN IF NOT EXISTS signature_mime_type TEXT;'
  );
  await executor.query(`
    UPDATE overtime_plan_signature_records
    SET signature_mime_type = CASE
      WHEN LOWER(signature_file_path) LIKE '%.jpg'
        OR LOWER(signature_file_path) LIKE '%.jpeg'
        THEN 'image/jpeg'
      ELSE 'image/png'
    END
    WHERE signature_mime_type IS NULL;
  `);
}

async function addOvertimePlanApprovalSignatureColumns(executor = { query }) {
  await executor.query(
    'ALTER TABLE overtime_plan_approvals ADD COLUMN IF NOT EXISTS signature_file_path TEXT;'
  );
  await executor.query(
    'ALTER TABLE overtime_plan_approvals ADD COLUMN IF NOT EXISTS signature_mime_type TEXT;'
  );
}

async function createOvertimePlanDocumentsTable(executor = { query }) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_documents (
      document_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL UNIQUE REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      file_path TEXT,
      file_type TEXT NOT NULL DEFAULT 'xlsx',
      generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      generated_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_documents_file_type_check CHECK (file_type = 'xlsx'),
      CONSTRAINT overtime_plan_documents_status_check CHECK (status IN ('pending', 'ready', 'failed'))
    );
  `);

  await executor.query(`
    CREATE INDEX IF NOT EXISTS overtime_plan_documents_status_idx
    ON overtime_plan_documents (status, generated_at);
  `);
}

async function createOvertimePurgeAuditTable(executor = { query }) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_purge_audits (
      purge_audit_id TEXT PRIMARY KEY,
      department_plan_id TEXT NOT NULL,
      performed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      remarks TEXT NOT NULL,
      delete_source_employee_plans BOOLEAN NOT NULL,
      deleted_record_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
      excel_files_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT overtime_purge_audits_status_check
        CHECK (status IN ('pending', 'completed', 'failed'))
    );
  `);

  await executor.query(`
    CREATE INDEX IF NOT EXISTS overtime_purge_audits_plan_idx
    ON overtime_purge_audits (department_plan_id, performed_at DESC);
  `);
  await executor.query(`
    CREATE INDEX IF NOT EXISTS overtime_purge_audits_performed_by_idx
    ON overtime_purge_audits (performed_by, performed_at DESC);
  `);
}

async function createActualOvertimeTables(executor = { query }) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_periods (
      actual_period_id TEXT PRIMARY KEY,
      source_department_plan_id TEXT NOT NULL UNIQUE REFERENCES overtime_plans(plan_id) ON DELETE RESTRICT,
      department_id TEXT NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
      period_type TEXT NOT NULL,
      period_start_date DATE NOT NULL,
      period_end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      finalized_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      finalized_at TIMESTAMPTZ,
      finalization_remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_actual_periods_type_check CHECK (period_type IN ('weekly', 'monthly')),
      CONSTRAINT overtime_actual_periods_status_check CHECK (status IN ('open', 'finalized')),
      CONSTRAINT overtime_actual_periods_date_range_check CHECK (period_start_date <= period_end_date)
    );
  `);

  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_entries (
      actual_entry_id TEXT PRIMARY KEY,
      actual_period_id TEXT NOT NULL REFERENCES overtime_actual_periods(actual_period_id) ON DELETE CASCADE,
      source_plan_item_id TEXT NOT NULL UNIQUE REFERENCES overtime_plan_items(plan_item_id) ON DELETE RESTRICT,
      source_employee_plan_id TEXT REFERENCES overtime_plans(plan_id) ON DELETE SET NULL,
      employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
      actual_date DATE NOT NULL,
      planned_hours NUMERIC(6, 2) NOT NULL,
      actual_hours NUMERIC(6, 2) NOT NULL,
      planned_reason TEXT NOT NULL,
      last_adjustment_remarks TEXT,
      last_updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      last_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_actual_entries_planned_hours_check CHECK (planned_hours > 0),
      CONSTRAINT overtime_actual_entries_actual_hours_check CHECK (actual_hours >= 0),
      CONSTRAINT overtime_actual_entries_unique_employee_date UNIQUE (actual_period_id, employee_id, actual_date)
    );
  `);

  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_comments (
      comment_id TEXT PRIMARY KEY,
      actual_entry_id TEXT NOT NULL REFERENCES overtime_actual_entries(actual_entry_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      remarks TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_adjustment_logs (
      adjustment_id TEXT PRIMARY KEY,
      actual_entry_id TEXT NOT NULL REFERENCES overtime_actual_entries(actual_entry_id) ON DELETE CASCADE,
      previous_hours NUMERIC(6, 2) NOT NULL,
      new_hours NUMERIC(6, 2) NOT NULL,
      changed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      remarks TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_activity_logs (
      activity_id TEXT PRIMARY KEY,
      actual_period_id TEXT NOT NULL REFERENCES overtime_actual_periods(actual_period_id) ON DELETE CASCADE,
      actual_entry_id TEXT REFERENCES overtime_actual_entries(actual_entry_id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      action_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_actual_activity_logs_action_check
        CHECK (action IN ('actual_hours_updated', 'actual_comment_added', 'actual_period_finalized'))
    );
  `);

  await executor.query('ALTER TABLE notifications ALTER COLUMN plan_id DROP NOT NULL;');
  await executor.query('ALTER TABLE notifications ALTER COLUMN log_id DROP NOT NULL;');
  await executor.query(`
    ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS actual_period_id TEXT
      REFERENCES overtime_actual_periods(actual_period_id) ON DELETE CASCADE;
  `);
  await executor.query(`
    ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS actual_entry_id TEXT
      REFERENCES overtime_actual_entries(actual_entry_id) ON DELETE SET NULL;
  `);
  await executor.query(`
    ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS actual_activity_id TEXT
      REFERENCES overtime_actual_activity_logs(activity_id) ON DELETE CASCADE;
  `);
  await executor.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'notifications_target_check'
      ) THEN
        ALTER TABLE notifications DROP CONSTRAINT notifications_target_check;
      END IF;
    END $$;
  `);
  await executor.query(`
    ALTER TABLE notifications
    ADD CONSTRAINT notifications_target_check CHECK (
      (
        plan_id IS NOT NULL
        AND log_id IS NOT NULL
        AND actual_period_id IS NULL
        AND actual_activity_id IS NULL
      )
      OR
      (
        plan_id IS NULL
        AND log_id IS NULL
        AND actual_period_id IS NOT NULL
        AND actual_activity_id IS NOT NULL
      )
    );
  `);

  await executor.query('ALTER TABLE overtime_actual_entries DROP COLUMN IF EXISTS actual_start_time;');
  await executor.query('ALTER TABLE overtime_actual_entries DROP COLUMN IF EXISTS actual_end_time;');
  await executor.query('ALTER TABLE overtime_actual_adjustment_logs DROP COLUMN IF EXISTS previous_start_time;');
  await executor.query('ALTER TABLE overtime_actual_adjustment_logs DROP COLUMN IF EXISTS new_start_time;');
  await executor.query('ALTER TABLE overtime_actual_adjustment_logs DROP COLUMN IF EXISTS previous_end_time;');
  await executor.query('ALTER TABLE overtime_actual_adjustment_logs DROP COLUMN IF EXISTS new_end_time;');

  await executor.query(`
    CREATE TABLE IF NOT EXISTS overtime_actual_documents (
      document_id TEXT PRIMARY KEY,
      actual_period_id TEXT NOT NULL UNIQUE REFERENCES overtime_actual_periods(actual_period_id) ON DELETE CASCADE,
      file_path TEXT,
      file_type TEXT NOT NULL DEFAULT 'xlsx',
      generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      generated_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_actual_documents_file_type_check CHECK (file_type = 'xlsx'),
      CONSTRAINT overtime_actual_documents_status_check CHECK (status IN ('pending', 'ready', 'failed'))
    );
  `);

  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_periods_department_idx ON overtime_actual_periods (department_id, period_start_date, period_end_date);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_periods_status_idx ON overtime_actual_periods (status);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_entries_period_idx ON overtime_actual_entries (actual_period_id, actual_date);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_entries_employee_idx ON overtime_actual_entries (employee_id, actual_date);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_comments_entry_idx ON overtime_actual_comments (actual_entry_id, created_at);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_adjustments_entry_idx ON overtime_actual_adjustment_logs (actual_entry_id, changed_at);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_activity_period_idx ON overtime_actual_activity_logs (actual_period_id, created_at DESC);');
  await executor.query('CREATE INDEX IF NOT EXISTS overtime_actual_activity_entry_idx ON overtime_actual_activity_logs (actual_entry_id, created_at DESC);');
  await executor.query('CREATE INDEX IF NOT EXISTS notifications_actual_period_idx ON notifications (actual_period_id, created_at DESC);');
  await executor.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_actual_activity_idx
    ON notifications (recipient_user_id, actual_activity_id)
    WHERE actual_activity_id IS NOT NULL;
  `);
  await createOvertimePurgeAuditTable(executor);
}

async function applyOvertimeSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      department_id TEXT PRIMARY KEY,
      department_name TEXT NOT NULL,
      parent_department_id TEXT REFERENCES departments(department_id) ON DELETE RESTRICT,
      head_employee_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT departments_status_check CHECK (status IN ('active', 'inactive'))
    );
  `);

  await query('ALTER TABLE departments ADD COLUMN IF NOT EXISTS parent_department_id TEXT;');
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'departments_parent_department_id_fkey'
      ) THEN
        ALTER TABLE departments
        ADD CONSTRAINT departments_parent_department_id_fkey
        FOREIGN KEY (parent_department_id)
        REFERENCES departments(department_id)
        ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS employees (
      employee_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      employee_no TEXT,
      department_id TEXT NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
      position TEXT,
      manager_id TEXT,
      supervisor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      shift TEXT NOT NULL DEFAULT 'day',
      employment_type TEXT NOT NULL DEFAULT 'regular',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT employees_shift_check CHECK (shift IN ('day', 'night')),
      CONSTRAINT employees_status_check CHECK (status IN ('active', 'inactive'))
    );
  `);

  await query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS supervisor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;');
  await query("ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift TEXT NOT NULL DEFAULT 'day';");
  await query(`
    UPDATE employees
    SET shift = 'day'
    WHERE shift IS NULL
       OR shift NOT IN ('day', 'night');
  `);
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'employees'
          AND column_name = 'first_name'
      ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'employees'
          AND column_name = 'middle_name'
      ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'employees'
          AND column_name = 'last_name'
      ) THEN
        UPDATE users AS u
        SET first_name = CASE
              WHEN NULLIF(e.first_name, '') IS NOT NULL
                   AND (u.first_name IS NULL OR u.first_name = '' OR u.first_name IN ('User', 'Employee'))
                THEN e.first_name
              ELSE u.first_name
            END,
            middle_name = CASE
              WHEN NULLIF(e.middle_name, '') IS NOT NULL
                   AND (u.middle_name IS NULL OR u.middle_name = '')
                THEN e.middle_name
              ELSE u.middle_name
            END,
            last_name = CASE
              WHEN NULLIF(e.last_name, '') IS NOT NULL
                   AND (u.last_name IS NULL OR u.last_name = '' OR u.last_name IN ('User', 'Employee'))
                THEN e.last_name
              ELSE u.last_name
            END,
            updated_at = NOW()
        FROM employees AS e
        WHERE u.id = e.user_id;
      END IF;
    END $$;
  `);
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'employees_shift_check'
      ) THEN
        ALTER TABLE employees
        ADD CONSTRAINT employees_shift_check CHECK (shift IN ('day', 'night'));
      END IF;
    END $$;
  `);
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS first_name;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS middle_name;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS last_name;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS full_name;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS hourly_rate;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS daily_rate;');
  await query('ALTER TABLE employees DROP COLUMN IF EXISTS is_department_leader;');

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_policies (
      policy_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      minimum_hours NUMERIC(6, 2) NOT NULL DEFAULT 1,
      maximum_hours_per_day NUMERIC(6, 2) NOT NULL DEFAULT 4,
      requires_manager_approval BOOLEAN NOT NULL DEFAULT true,
      requires_hr_approval BOOLEAN NOT NULL DEFAULT true,
      rate_multiplier NUMERIC(6, 2) NOT NULL DEFAULT 1.25,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_policies_status_check CHECK (status IN ('active', 'inactive'))
    );
  `);



  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_approval_routes (
      route_id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
      route_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_approval_routes_status_check CHECK (status IN ('active', 'inactive'))
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_approval_route_steps (
      step_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES overtime_plan_approval_routes(route_id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      approver_role TEXT NOT NULL,
      approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_approval_route_steps_order_check CHECK (step_order > 0),
      CONSTRAINT overtime_plan_approval_route_steps_role_check CHECK (approver_role IN ('supervisor', 'japanese_management', 'hr', 'admin')),
      CONSTRAINT overtime_plan_approval_route_steps_unique_order UNIQUE (route_id, step_order)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plans (
      plan_id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(department_id) ON DELETE RESTRICT,
      period_type TEXT NOT NULL,
      period_start_date DATE NOT NULL,
      period_end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      plan_scope TEXT NOT NULL DEFAULT 'employee',
      route_id TEXT REFERENCES overtime_plan_approval_routes(route_id) ON DELETE SET NULL,
      current_step_order INTEGER,
      current_approval_id TEXT,
      current_approver_role TEXT,
      current_approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      supervisor_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      supervisor_reviewed_at TIMESTAMPTZ,
      department_submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      department_submitted_at TIMESTAMPTZ,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      submitted_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      submitted_at TIMESTAMPTZ,
      approved_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      approved_at TIMESTAMPTZ,
      rejected_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      rejected_at TIMESTAMPTZ,
      closed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      closed_at TIMESTAMPTZ,
      remarks TEXT,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plans_period_type_check CHECK (period_type IN ('weekly', 'monthly')),
      CONSTRAINT overtime_plans_scope_check CHECK (plan_scope IN ('employee', 'department')),
      CONSTRAINT overtime_plans_status_check CHECK (status IN ('draft', 'submitted', 'submitted_to_supervisor', 'supervisor_returned', 'supervisor_accepted', 'pending_approval', 'returned_for_revision', 'approved', 'rejected', 'closed')),
      CONSTRAINT overtime_plans_date_range_check CHECK (period_start_date <= period_end_date)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_items (
      plan_item_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
      planned_date DATE NOT NULL,
      planned_hours NUMERIC(6, 2) NOT NULL,
      reason TEXT NOT NULL,
      source_employee_plan_id TEXT REFERENCES overtime_plans(plan_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_items_hours_check CHECK (planned_hours > 0)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_logs (
      log_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      action_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      remarks TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      plan_id TEXT NOT NULL REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      log_id TEXT NOT NULL REFERENCES overtime_plan_logs(log_id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT notifications_recipient_log_unique UNIQUE (recipient_user_id, log_id)
    );
  `);


  await query(`
    CREATE TABLE IF NOT EXISTS overtime_plan_approvals (
      approval_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES overtime_plans(plan_id) ON DELETE CASCADE,
      route_id TEXT REFERENCES overtime_plan_approval_routes(route_id) ON DELETE SET NULL,
      step_id TEXT REFERENCES overtime_plan_approval_route_steps(step_id) ON DELETE SET NULL,
      step_order INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      approver_role TEXT NOT NULL,
      approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      acted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      acted_at TIMESTAMPTZ,
      signature_file_path TEXT,
      signature_mime_type TEXT,
      remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT overtime_plan_approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
      CONSTRAINT overtime_plan_approvals_role_check CHECK (approver_role IN ('supervisor', 'japanese_management', 'hr', 'admin'))
    );
  `);

  await addOvertimePlanApprovalSignatureColumns();
  await createOvertimePlanSignatureRecordsTable();
  await addOvertimePlanSignatureMimeTypeColumn();
  await createOvertimePlanDocumentsTable();
  await createActualOvertimeTables();

  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS rejection_reason TEXT;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS closed_by TEXT REFERENCES users(id) ON DELETE RESTRICT;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;');
  await query("ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS plan_scope TEXT NOT NULL DEFAULT 'employee';");
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS route_id TEXT REFERENCES overtime_plan_approval_routes(route_id) ON DELETE SET NULL;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS current_step_order INTEGER;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS current_approval_id TEXT;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS current_approver_role TEXT;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS current_approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS supervisor_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS supervisor_reviewed_at TIMESTAMPTZ;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS department_submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL;');
  await query('ALTER TABLE overtime_plans ADD COLUMN IF NOT EXISTS department_submitted_at TIMESTAMPTZ;');
  await query('ALTER TABLE overtime_plan_items ADD COLUMN IF NOT EXISTS source_employee_plan_id TEXT REFERENCES overtime_plans(plan_id) ON DELETE SET NULL;');

  await query(`
    UPDATE overtime_plan_approval_route_steps
    SET approver_role = 'supervisor'
    WHERE approver_role = 'manager';
  `);
  await query(`
    UPDATE overtime_plan_approvals
    SET approver_role = 'supervisor'
    WHERE approver_role = 'manager';
  `);
  await query(`
    UPDATE overtime_plans
    SET current_approver_role = 'supervisor'
    WHERE current_approver_role = 'manager';
  `);

  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plan_approval_route_steps_role_check'
      ) THEN
        ALTER TABLE overtime_plan_approval_route_steps DROP CONSTRAINT overtime_plan_approval_route_steps_role_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE overtime_plan_approval_route_steps
    ADD CONSTRAINT overtime_plan_approval_route_steps_role_check
    CHECK (approver_role IN ('supervisor', 'japanese_management', 'hr', 'admin'));
  `);

  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plan_approvals_role_check'
      ) THEN
        ALTER TABLE overtime_plan_approvals DROP CONSTRAINT overtime_plan_approvals_role_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE overtime_plan_approvals
    ADD CONSTRAINT overtime_plan_approvals_role_check
    CHECK (approver_role IN ('supervisor', 'japanese_management', 'hr', 'admin'));
  `);

  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plans_period_type_check'
      ) THEN
        ALTER TABLE overtime_plans DROP CONSTRAINT overtime_plans_period_type_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE overtime_plans
    ADD CONSTRAINT overtime_plans_period_type_check
    CHECK (period_type IN ('weekly', 'monthly'));
  `);


  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plans_scope_check'
      ) THEN
        ALTER TABLE overtime_plans DROP CONSTRAINT overtime_plans_scope_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE overtime_plans
    ADD CONSTRAINT overtime_plans_scope_check
    CHECK (plan_scope IN ('employee', 'department'));
  `);

  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plans_status_check'
      ) THEN
        ALTER TABLE overtime_plans DROP CONSTRAINT overtime_plans_status_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE overtime_plans
    ADD CONSTRAINT overtime_plans_status_check
    CHECK (status IN ('draft', 'submitted', 'submitted_to_supervisor', 'supervisor_returned', 'supervisor_accepted', 'pending_approval', 'returned_for_revision', 'approved', 'rejected', 'closed'));
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'overtime_plans_date_range_check'
      ) THEN
        ALTER TABLE overtime_plans
        ADD CONSTRAINT overtime_plans_date_range_check
        CHECK (period_start_date <= period_end_date);
      END IF;
    END $$;
  `);

  await query('CREATE INDEX IF NOT EXISTS employees_user_id_idx ON employees (user_id);');
  await query('CREATE INDEX IF NOT EXISTS departments_parent_department_id_idx ON departments (parent_department_id);');
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS employees_employee_no_unique_idx
    ON employees (employee_no)
    WHERE employee_no IS NOT NULL;
  `);
  await query('CREATE INDEX IF NOT EXISTS overtime_plans_department_id_idx ON overtime_plans (department_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plans_status_idx ON overtime_plans (status);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plans_period_idx ON overtime_plans (period_start_date, period_end_date);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_items_plan_id_idx ON overtime_plan_items (plan_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_items_employee_id_idx ON overtime_plan_items (employee_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_logs_plan_id_idx ON overtime_plan_logs (plan_id);');
  await query('CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx ON notifications (recipient_user_id, created_at DESC);');
  await query('CREATE INDEX IF NOT EXISTS notifications_plan_id_idx ON notifications (plan_id);');
  await query(`
    CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
    ON notifications (recipient_user_id, created_at DESC)
    WHERE read_at IS NULL;
  `);
  await query('CREATE INDEX IF NOT EXISTS employees_supervisor_user_id_idx ON employees (supervisor_user_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plans_scope_idx ON overtime_plans (plan_scope);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plans_current_approver_idx ON overtime_plans (current_approver_role, current_approver_user_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_approval_routes_department_idx ON overtime_plan_approval_routes (department_id, status);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_approval_route_steps_route_idx ON overtime_plan_approval_route_steps (route_id, step_order);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_approvals_plan_id_idx ON overtime_plan_approvals (plan_id);');
  await query('CREATE INDEX IF NOT EXISTS overtime_plan_approvals_pending_idx ON overtime_plan_approvals (plan_id, status, step_order);');
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS overtime_plan_items_unique_employee_date_idx
    ON overtime_plan_items (plan_id, employee_id, planned_date);
  `);

  console.log('Overtime tables are ready.');
}

async function setupOvertimeTables() {
  await runStep('Apply overtime schema and indexes', applyOvertimeSchema);
}

module.exports = {
  addOvertimePlanApprovalSignatureColumns,
  addOvertimePlanSignatureMimeTypeColumn,
  applyOvertimeSchema,
  createActualOvertimeTables,
  createOvertimePlanDocumentsTable,
  createOvertimePurgeAuditTable,
  createOvertimePlanSignatureRecordsTable,
  setupOvertimeTables,
};

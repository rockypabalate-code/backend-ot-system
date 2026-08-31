require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { closePool, query } = require('./database');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey || supabaseAnonKey === 'replace-with-your-supabase-anon-key') {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required to check realtime.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function triggerEmployeeUpdate() {
  const result = await query(`
    UPDATE employees
    SET updated_at = NOW()
    WHERE employee_id = (
      SELECT employee_id
      FROM employees
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING employee_id;
  `);

  if (!result.rows[0]) {
    throw new Error('No employee rows exist to trigger a realtime update.');
  }

  return result.rows[0].employee_id;
}

async function checkRealtime() {
  let timeout;

  await new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for a Supabase Realtime event.'));
    }, 20000);

    const channel = supabase
      .channel('backend-api-realtime-check')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'employees',
        },
        async (payload) => {
          clearTimeout(timeout);
          console.log(`Realtime event received for employee ${payload.new.employee_id}.`);
          await supabase.removeChannel(channel);
          resolve();
        }
      )
      .subscribe(async (status, error) => {
        if (error) {
          clearTimeout(timeout);
          reject(error);
          return;
        }

        if (status === 'SUBSCRIBED') {
          const employeeId = await triggerEmployeeUpdate();
          console.log(`Triggered employee update for ${employeeId}.`);
        }
      });
  });
}

checkRealtime()
  .catch((error) => {
    console.error('Supabase Realtime check failed.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await supabase.removeAllChannels();
    await closePool();
    process.exit(process.exitCode || 0);
  });

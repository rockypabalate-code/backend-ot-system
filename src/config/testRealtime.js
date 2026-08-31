require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const realtimeTables = [
  'overtime_actual_entries',
  'employees',
  'overtime_actual_comments',
];

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required to test realtime.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const channel = supabase.channel('backend-api-realtime-test');

realtimeTables.forEach((table) => {
  channel.on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table,
    },
    (payload) => {
      console.log(JSON.stringify({
        table,
        event: payload.eventType,
        new: payload.new,
        old: payload.old,
      }, null, 2));
    }
  );
});

channel.subscribe((status, error) => {
  console.log(`Realtime subscription status: ${status}`);

  if (error) {
    console.error(error);
  }

  if (status === 'SUBSCRIBED') {
    console.log('Listening for Supabase Realtime changes. Press Ctrl+C to stop.');
  }
});

process.on('SIGINT', async () => {
  await supabase.removeChannel(channel);
  process.exit(0);
});

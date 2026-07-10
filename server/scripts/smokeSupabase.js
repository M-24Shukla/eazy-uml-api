import 'dotenv/config';
import { requireSupabase } from '../db/supabase.js';

const tables = ['app_users', 'projects', 'artifacts', 'project_access_grants'];

const db = requireSupabase();

for (const table of tables) {
  const { error } = await db.from(table).select('id', { count: 'exact', head: true });

  if (error) {
    console.error(`${table}: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`${table}: ok`);
  }
}

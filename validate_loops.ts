import { pool } from "./src/infrastructure/db/index.js";
import { loopDefinitionSchema } from "./src/services/conductor/workflow/types.js";

async function main() {
  const result = await pool.query("SELECT id, title, metadata_json->>'loopDefinition' as def FROM workflows WHERE status = 'active';");
  for (const row of result.rows) {
    try {
      if (row.def) {
        loopDefinitionSchema.parse(JSON.parse(row.def));
      }
    } catch (e: any) {
      console.log(`Failed loop ${row.id} (${row.title}):`);
      console.log(e.errors || e.message);
    }
  }
  process.exit(0);
}
main();

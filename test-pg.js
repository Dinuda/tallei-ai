import pg from 'pg';
import "dotenv/config";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
client.connect().then(() => {
  console.log("Connected successfully!");
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});

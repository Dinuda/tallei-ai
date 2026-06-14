import { pool } from "./infrastructure/db/index.js";
import { config } from "./config/index.js";

async function run() {
  // Get a valid userId and tenantId
  const userResult = await pool.query("SELECT user_id, tenant_id FROM tenant_memberships LIMIT 1");
  const user = userResult.rows[0];
  if (!user) {
    console.error("No users found in database");
    await pool.end();
    return;
  }
  
  console.log(`Using User ID: ${user.user_id}`);
  console.log(`Internal Secret: ${config.internalApiSecret}`);
  
  const url = `http://127.0.0.1:3000/api/memories/cleanup/loop-miner/runs`;
  console.log(`Fetching ${url}...`);
  
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "X-Internal-Secret": config.internalApiSecret,
        "X-User-Id": user.user_id,
      }
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log("Response body:");
    console.log(text);
  } catch (err) {
    console.error("Fetch error:", err);
  }
  
  await pool.end();
}

run().catch(console.error);

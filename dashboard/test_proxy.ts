import { config } from "dotenv";
config({ path: ".env.local" });

import { NextRequest } from "next/server";
import { GET } from "./app/api/memories/cleanup/[...path]/route.ts";

async function run() {
  console.log("SECRET VALUE:", JSON.stringify(process.env.INTERNAL_API_SECRET));
  const req = new NextRequest("http://localhost:3001/api/memories/cleanup/loop-miner/runs", {
    method: "GET"
  });
  const context = {
    params: Promise.resolve({ path: ["loop-miner", "runs"] })
  };
  
  try {
    const res = await GET(req, context);
    console.log("Status:", res.status);
    console.log("Body:", await res.json());
  } catch (err) {
    console.error("Caught error:", err);
  }
}

run().catch(console.error);

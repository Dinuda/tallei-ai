import "./patch.js";
import express from "express";
import { config } from "./config.js";
import memoriesRouter from "./routes/memories.js";
import authRouter from "./routes/auth.js";
import keysRouter from "./routes/keys.js";
import { initDb } from "./db/index.js";

const app = express();

// Body parsing
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tallei", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api/keys", keysRouter);
app.use("/api/memories", memoriesRouter);

// Start
initDb().then(() => {
  app.listen(config.port, () => {
    console.log(`🧠 Tallei running on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
  });
}).catch(e => {
  console.error("Failed to initialize database:", e);
  process.exit(1);
});

export default app;

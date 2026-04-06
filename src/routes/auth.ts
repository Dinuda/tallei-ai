import { Router } from "express";
import { register, login } from "../services/auth.js";

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Missing email or password" });
      return;
    }
    const user = await register(email, password);
    res.json({ success: true, user });
  } catch (error: any) {
    if (error.code === '23505') { // Postgres unique violation
      res.status(409).json({ error: "Email already exists" });
    } else {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await login(email, password);
    if (!result) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

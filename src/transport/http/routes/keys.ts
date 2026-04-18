import { Router } from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

function sendDeprecated(res: any): void {
  res.status(410).json({
    error: "API keys are deprecated",
    message: "Legacy gm_* API keys are disabled. Reconnect via OAuth at /dashboard/setup.",
  });
}

router.get("/", (_req, res) => {
  sendDeprecated(res);
});

router.post("/", (_req, res) => {
  sendDeprecated(res);
});

router.delete("/:id", (_req, res) => {
  sendDeprecated(res);
});

export default router;

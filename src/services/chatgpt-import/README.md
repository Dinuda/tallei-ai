# ChatGPT Import Service Module

This module groups ChatGPT import flow concerns:

- `jobs.service.ts`: queueing, claiming, retries, and worker tick processing.
- `storage.ts`: artifact pathing, persistence, and orphan cleanup.
- `index.ts`: module entrypoint exports.

Compatibility exports remain at:
- `src/services/chatgpt-import-jobs.ts`
- `src/services/chatgpt-import-storage.ts`

# ChatGPT Import Service Module

This module groups ChatGPT import flow concerns:

- `jobs.service.ts`: queueing, claiming, retries, and worker tick processing.
- `storage.ts`: artifact pathing, persistence, and orphan cleanup.

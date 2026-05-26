# Notifications Service Module

This module groups outbound notification concerns:

- `resend-email.ts`: shared email transport.
- `email-templates.ts`: mail template builders.
- `signup-notifications.ts`: signup notifications.
- `payment-notifications.ts`: billing/payment notifications.
- `index.ts`: module entrypoint exports.

Compatibility exports remain at top-level service files.

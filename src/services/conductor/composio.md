# Connector integration

Tallei uses a provider-neutral connector boundary. Composio is the current provider adapter and is used through its direct APIs; Tool Router Sessions are not used.

## Ownership

- Tallei owns connector workflow state and stores provider-neutral connection records in `connector_connections`.
- Composio remains the credential vault and OAuth host. Tallei stores only opaque account and request identifiers.
- A workspace can select one connected account per toolkit.
- Connector discovery, compilation, execution, and trigger metadata are accessed through `getConnectorProvider()`.

## Direct Composio APIs

- Toolkit metadata and versions: `toolkits.list()` and `toolkits.get()`
- Actions and schemas: direct tools list/retrieve APIs
- Account status: `connectedAccounts.list()`
- OAuth: `authConfigs.list()` followed by `connectedAccounts.link()`
- OAuth verification: `connectedAccounts.waitForConnection()` and `connectedAccounts.get()`
- Execution: `tools.execute()` with an explicit connected account and toolkit version
- Trigger metadata and subscriptions: direct trigger APIs

## Metadata caching

The global catalogue and semantic searches use bounded TTL caches. Toolkit actions and triggers are keyed by the concrete toolkit version returned from `toolkits.get().meta.availableVersions[0]`. A lightweight version lookup is refreshed periodically; unchanged versions reuse their existing metadata entries.

Explicit `COMPOSIO_TOOLKIT_VERSION_<TOOLKIT>` values override latest-version discovery. `TALLEI_CONNECTORS__COMPOSIO_AUTH_CONFIG_ID` can select a specific auth config; otherwise the adapter requires exactly one enabled Composio-managed auth config for the toolkit.

## Compatibility

Existing loop specs may contain `composioSessionId`, `workflowSteps`, or `pitfalls`. They remain readable for compatibility, but new compilations do not write Session-derived fields. Public Conductor tool names and HTTP response shapes remain unchanged.

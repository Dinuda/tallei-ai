# Tallei Vertex AI Agent Engine Adapter

This package is a thin Google ADK agent wrapper for Tallei. It does not own
business logic or state. It calls the Node backend's internal Agent Engine tool
gateway at `/internal/agent-tools/:toolName`.

## Runtime contract

Required environment variables:

- `TALLEI_BACKEND_URL`: backend base URL, for example `https://api.example.com`
- `TALLEI_AGENT_ENGINE_TOKEN`: short-lived signed token minted by the backend

The backend validates the token and derives tenant/user identity from signed
claims. The ADK tool inputs must not carry raw tenant or user IDs.

## Local smoke test

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r agent-engine/requirements.txt
python agent-engine/smoke_test.py
```

## Deploy shape

Deploy this directory to Vertex AI Agent Engine using source-file deployment and
`agent_framework="google-adk"`. The deployed Agent Engine service account should
only be able to call the backend internal tool endpoint and the Google resources
needed for Vertex AI Search.

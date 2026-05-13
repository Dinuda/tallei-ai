import os
from typing import Any, Dict, Optional

import requests
from google.adk.agents import Agent


BACKEND_URL = os.environ.get("TALLEI_BACKEND_URL", "").rstrip("/")
AGENT_TOKEN = os.environ.get("TALLEI_AGENT_ENGINE_TOKEN", "")


class ToolCallError(RuntimeError):
    pass


def _call_tool(tool_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not BACKEND_URL:
        raise ToolCallError("TALLEI_BACKEND_URL is not configured")
    if not AGENT_TOKEN:
        raise ToolCallError("TALLEI_AGENT_ENGINE_TOKEN is not configured")

    response = requests.post(
        f"{BACKEND_URL}/internal/agent-tools/{tool_name}",
        json={"input": payload},
        headers={"Authorization": f"Bearer {AGENT_TOKEN}"},
        timeout=45,
    )
    try:
        body = response.json()
    except ValueError as exc:
        raise ToolCallError(f"Backend returned non-JSON response: HTTP {response.status_code}") from exc

    if response.status_code >= 400 or not body.get("ok", False):
        raise ToolCallError(str(body.get("error") or f"Backend tool failed: HTTP {response.status_code}"))
    return body.get("result", {})


def recall_memories(query: str, limit: int = 5, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    return _call_tool("recall_memories", {
        "query": query,
        "limit": limit,
        "conversation_id": conversation_id,
    })


def save_memory(kind: str, content: str, title: Optional[str] = None, category: Optional[str] = None) -> Dict[str, Any]:
    return _call_tool("save_memory", {
        "kind": kind,
        "content": content,
        "title": title,
        "category": category,
        "platform": "gemini",
    })


def prepare_response(message: str, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    return _call_tool("prepare_response", {
        "message": message,
        "conversation_id": conversation_id,
    })


def collab_create_task(title: str, brief: Optional[str] = None, first_actor: str = "chatgpt") -> Dict[str, Any]:
    return _call_tool("collab_create_task", {
        "title": title,
        "brief": brief,
        "first_actor": first_actor,
    })


def collab_check_turn(task_id: str, actor: str = "chatgpt") -> Dict[str, Any]:
    return _call_tool("collab_check_turn", {
        "task_id": task_id,
        "actor": actor,
    })


def collab_take_turn(task_id: str, content: str, actor: str = "chatgpt", mark_done: bool = False) -> Dict[str, Any]:
    return _call_tool("collab_take_turn", {
        "task_id": task_id,
        "content": content,
        "actor": actor,
        "mark_done": mark_done,
    })


def ingest_uploaded_file(openai_file_id_refs: list[dict[str, Any]], conversation_id: Optional[str] = None) -> Dict[str, Any]:
    return _call_tool("ingest_uploaded_file", {
        "openaiFileIdRefs": openai_file_id_refs,
        "conversation_id": conversation_id,
    })


def get_task(task_id: str) -> Dict[str, Any]:
    return _call_tool("get_task", {"task_id": task_id})


root_agent = Agent(
    name="tallei_agent",
    model=os.environ.get("TALLEI_AGENT_ENGINE_MODEL", "gemini-2.0-flash"),
    description="Tallei assistant adapter for memory, documents, and collab workflows.",
    instruction=(
        "You are Tallei running on Vertex AI Agent Engine. Use tools for memory, "
        "document, and collab state. The Node backend is authoritative; do not "
        "invent task state or tenant/user identifiers."
    ),
    tools=[
        recall_memories,
        save_memory,
        prepare_response,
        collab_create_task,
        collab_check_turn,
        collab_take_turn,
        ingest_uploaded_file,
        get_task,
    ],
)

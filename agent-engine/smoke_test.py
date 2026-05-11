from tallei_agent import root_agent


def test_agent_loads() -> None:
    assert root_agent.name == "tallei_agent"
    assert len(root_agent.tools) == 8


if __name__ == "__main__":
    test_agent_loads()
    print("agent-load-ok")

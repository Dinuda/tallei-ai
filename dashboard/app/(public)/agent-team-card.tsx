export type AgentRole = {
  initials: string;
  title: string;
  description: string;
};

export type AgentTeamCardProps = {
  name: string;
  agents: readonly AgentRole[];
};

export function AgentTeamCard({ name, agents }: AgentTeamCardProps) {
  return (
    <article className="loops-agent-team-card">
      <h3 className="loops-agent-team-name">{name}</h3>
      <ul className="loops-agent-team-list">
        {agents.map((agent) => (
          <li key={agent.title} className="loops-agent-team-row">
            <div className="loops-agent-avatar" aria-hidden>
              {agent.initials}
            </div>
            <div className="loops-agent-team-copy">
              <p className="loops-agent-team-title">{agent.title}</p>
              <p className="loops-agent-team-desc">{agent.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Code2, Cpu, Loader2, RefreshCw, Shield, Braces, Workflow, Puzzle, FileJson, GitBranch, ListChecks, Radio } from "lucide-react";
import styles from "./page.module.css";

type ToolContract = {
  toolRef: string;
  provider: "internal" | "composio";
  name: string;
  description: string;
  skillTags: string[];
  effect: string;
  resources: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  executionMode: string;
  approval: { required: boolean; suggestedGate?: string; reason?: string };
  renderRecommendations: Array<{ target: string; reason: string; strength: string }>;
  source: string;
};

type ToolSpec = {
  ref: string;
  label: string;
  provider: string;
  description: string;
  shortCircuits: boolean;
  outputDescription: string;
  outputSchema: Record<string, unknown>;
  handoffFormat: string;
  useCases: string[];
  limitations: string[];
  risk: string;
  requiresConnector: boolean;
  requiresPreSendApproval: boolean;
  toolkit?: string;
  actions?: Array<{
    slug: string;
    name: string;
    description: string;
    risk: string;
    contract?: ToolContract;
  }>;
  contract?: ToolContract;
};

type ToolUseCase = {
  name: string;
  description: string;
  requiredTools: string[];
  outcome: string;
  category: string;
};

type ToolCatalogEntry = {
  ref: string;
  label: string;
  description: string;
  provider: string;
  toolkit: string | null;
  requiresConnector: boolean;
  requiresApproval: boolean;
  riskLevel: string;
  integrationKey: string;
  isActionable: boolean;
};

type ToolSpecRegistry = {
  internalTools: ToolSpec[];
  composioToolkits: ToolSpec[];
  toolContracts: ToolContract[];
  useCases: ToolUseCase[];
  generatedAt: string;
};

type PlatformInfo = {
  renderTargets: Array<{ target: string; description: string }>;
  approvalFlows: {
    gateTypes: Array<{ type: string; description: string }>;
    approvalModes: Array<{ mode: string; description: string }>;
    rejectionBehaviors: Array<{ behavior: string; description: string }>;
    channels: Array<{ channel: string; description: string }>;
    executionModes: Array<{ mode: string; description: string }>;
    toolEffects: Array<{ effect: string; description: string }>;
    stageKinds: Array<{ kind: string; description: string }>;
    connectorActionRisks: Array<{ risk: string; description: string }>;
  };
};

type IntegrationsData = {
  toolSpecRegistry: ToolSpecRegistry;
  toolCatalog: ToolCatalogEntry[];
  platform: PlatformInfo;
};

function effectBadge(effect: string): string {
  const map: Record<string, string> = {
    none: styles.effectNone,
    read_external: styles.effectRead,
    write_external: styles.effectWrite,
    irreversible_external: styles.effectDestructive,
  };
  return map[effect] ?? styles.effectNone;
}

function executionBadge(mode: string): string {
  const map: Record<string, string> = {
    short_circuit: styles.execShortCircuit,
    llm_assisted: styles.execLlm,
    approval_executed: styles.execApproval,
  };
  return map[mode] ?? "";
}

function riskBadge(risk: string): string {
  const map: Record<string, string> = {
    none: styles.riskNone,
    read: styles.riskRead,
    low: styles.riskRead,
    write: styles.riskWrite,
    send: styles.riskWrite,
    medium: styles.riskWrite,
    high: styles.riskDestructive,
    destructive: styles.riskDestructive,
  };
  return map[risk] ?? styles.riskNone;
}

function Section({ title, icon, children, count }: { title: string; icon: React.ReactNode; children: React.ReactNode; count?: number }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>{icon}</span>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {count !== undefined && <span className={styles.sectionCount}>{count}</span>}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </div>
  );
}

function CollapsibleCard({ title, subtitle, badge, children, defaultOpen }: { title: string; subtitle?: string; badge?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className={styles.card}>
      <button className={styles.cardHeader} onClick={() => setOpen(!open)} type="button">
        <div className={styles.cardTitleRow}>
          <span className={styles.cardChevron} data-open={open}>{">"}</span>
          <div>
            <div className={styles.cardTitle}>{title}</div>
            {subtitle && <div className={styles.cardSubtitle}>{subtitle}</div>}
          </div>
        </div>
        {badge && <div className={styles.cardBadges}>{badge}</div>}
      </button>
      {open && <div className={styles.cardBody}>{children}</div>}
    </div>
  );
}

function PropertyGrid({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div className={styles.propertyGrid}>
      {items.map((item) => (
        <div key={item.label} className={styles.propertyRow}>
          <span className={styles.propertyLabel}>{item.label}</span>
          <span className={styles.propertyValue}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function DeveloperIntegrationsPage() {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/developer/integrations", { cache: "no-store" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Failed to load integrations data");
      setData(payload as IntegrationsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <Loader2 className={styles.spinner} size={24} />
          Loading tool catalog...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          <p>{error ?? "No data available"}</p>
          <button className={styles.retryBtn} onClick={loadData} type="button">Retry</button>
        </div>
      </div>
    );
  }

  const { toolSpecRegistry, toolCatalog, platform } = data;
  const totalContracts = toolSpecRegistry.toolContracts.length;
  const totalCatalog = toolCatalog.length;
  const totalActions = toolSpecRegistry.composioToolkits.reduce((sum, t) => sum + (t.actions?.length ?? 0), 0);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>Integrations & Tool Catalog</h1>
          <p className={styles.pageSubtitle}>All tools, contracts, render targets, and approval flows available across Tallei</p>
        </div>
        <button className={styles.refreshBtn} onClick={loadData} type="button">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      <div className={styles.statBar}>
        <div className={styles.stat}>
          <Code2 size={16} />
          <span className={styles.statValue}>{totalCatalog}</span>
          <span className={styles.statLabel}>Tool Catalog Entries</span>
        </div>
        <div className={styles.stat}>
          <FileJson size={16} />
          <span className={styles.statValue}>{totalContracts}</span>
          <span className={styles.statLabel}>Tool Contracts</span>
        </div>
        <div className={styles.stat}>
          <Cpu size={16} />
          <span className={styles.statValue}>{toolSpecRegistry.internalTools.length}</span>
          <span className={styles.statLabel}>Internal Tools</span>
        </div>
        <div className={styles.stat}>
          <Puzzle size={16} />
          <span className={styles.statValue}>{toolSpecRegistry.composioToolkits.length}</span>
          <span className={styles.statLabel}>Connected Toolkits</span>
        </div>
        <div className={styles.stat}>
          <GitBranch size="16" />
          <span className={styles.statValue}>{totalActions}</span>
          <span className={styles.statLabel}>Connector Actions</span>
        </div>
        <div className={styles.stat}>
          <ListChecks size="16" />
          <span className={styles.statValue}>{toolSpecRegistry.useCases.length}</span>
          <span className={styles.statLabel}>Use Cases</span>
        </div>
      </div>

      <Section title="Tool Contracts" icon={<FileJson size={18} />} count={totalContracts}>
        {toolSpecRegistry.toolContracts.length === 0 ? (
          <p className={styles.empty}>No tool contracts loaded.</p>
        ) : (
          toolSpecRegistry.toolContracts.map((contract) => (
            <CollapsibleCard
              key={contract.toolRef}
              title={`${contract.toolRef}`}
              subtitle={contract.name}
              badge={
                <>
                  <span className={`${styles.miniBadge} ${effectBadge(contract.effect)}`}>{contract.effect}</span>
                  <span className={`${styles.miniBadge} ${executionBadge(contract.executionMode)}`}>{contract.executionMode}</span>
                  {contract.approval.required && <span className={`${styles.miniBadge} ${styles.badgeApproval}`}>approval</span>}
                </>
              }
            >
              <p className={styles.contractDesc}>{contract.description}</p>
              <PropertyGrid
                items={[
                  { label: "Skills", value: contract.skillTags.join(", ") || "—" },
                  { label: "Resources", value: contract.resources.join(", ") || "—" },
                  { label: "Effect", value: contract.effect },
                  { label: "Execution Mode", value: contract.executionMode },
                  { label: "Approval Required", value: contract.approval.required ? `Yes${contract.approval.suggestedGate ? ` (${contract.approval.suggestedGate})` : ""}${contract.approval.reason ? ` — ${contract.approval.reason}` : ""}` : "No" },
                  { label: "Source", value: contract.source },
                  { label: "Render Recommendations", value: contract.renderRecommendations.length > 0 ? contract.renderRecommendations.map((r) => `${r.target} (${r.strength})`).join(", ") : "None" },
                ]}
              />
              <details className={styles.schemaDetails}>
                <summary className={styles.schemaSummary}>Output Schema</summary>
                <pre className={styles.schemaBlock}>{JSON.stringify(contract.outputSchema, null, 2)}</pre>
              </details>
            </CollapsibleCard>
          ))
        )}
      </Section>

      <Section title="Internal Tools" icon={<Cpu size={18} />} count={toolSpecRegistry.internalTools.length}>
        {toolSpecRegistry.internalTools.map((tool) => (
          <CollapsibleCard key={tool.ref} title={tool.ref} subtitle={tool.label} defaultOpen badge={<span className={`${styles.miniBadge} ${riskBadge(tool.risk)}`}>{tool.risk}</span>}>
            <p>{tool.description}</p>
            <PropertyGrid
              items={[
                { label: "Provider", value: tool.provider },
                { label: "Short Circuits", value: tool.shortCircuits ? "Yes" : "No" },
                { label: "Risk", value: tool.risk },
                { label: "Output", value: tool.outputDescription },
                { label: "Requires Connector", value: tool.requiresConnector ? "Yes" : "No" },
                { label: "Requires Pre-Send Approval", value: tool.requiresPreSendApproval ? "Yes" : "No" },
              ]}
            />
            {tool.useCases.length > 0 && (
              <div className={styles.miniList}>
                <div className={styles.miniListTitle}>Use Cases</div>
                {tool.useCases.map((uc) => (<div key={uc} className={styles.miniListItem}>{uc}</div>))}
              </div>
            )}
            {tool.limitations.length > 0 && (
              <div className={styles.miniList}>
                <div className={styles.miniListTitle}>Limitations</div>
                {tool.limitations.map((lim) => (<div key={lim} className={styles.miniListItem}>{lim}</div>))}
              </div>
            )}
            {tool.contract && (
              <details className={styles.schemaDetails}>
                <summary className={styles.schemaSummary}>Contract Output Schema</summary>
                <pre className={styles.schemaBlock}>{JSON.stringify(tool.contract.outputSchema, null, 2)}</pre>
              </details>
            )}
          </CollapsibleCard>
        ))}
      </Section>

      <Section title="Connected App Toolkits" icon={<Puzzle size={18} />} count={toolSpecRegistry.composioToolkits.length}>
        {toolSpecRegistry.composioToolkits.length === 0 ? (
          <p className={styles.empty}>No connected app toolkits. Connect apps in the Connected Apps page.</p>
        ) : (
          toolSpecRegistry.composioToolkits.map((toolkit) => (
            <CollapsibleCard key={toolkit.ref} title={toolkit.label} subtitle={`${toolkit.ref}${toolkit.toolkit ? ` (${toolkit.toolkit})` : ""}`} defaultOpen badge={<span className={`${styles.miniBadge} ${riskBadge(toolkit.risk)}`}>{toolkit.risk}</span>}>
              <p>{toolkit.description}</p>
              <PropertyGrid
                items={[
                  { label: "Provider", value: toolkit.provider },
                  { label: "Requires Connector", value: toolkit.requiresConnector ? "Yes" : "No" },
                  { label: "Pre-Send Approval", value: toolkit.requiresPreSendApproval ? "Yes" : "No" },
                ]}
              />
              {toolkit.limitations.length > 0 && (
                <div className={styles.miniList}>
                  <div className={styles.miniListTitle}>Limitations</div>
                  {toolkit.limitations.map((lim) => (<div key={lim} className={styles.miniListItem}>{lim}</div>))}
                </div>
              )}
              {toolkit.contract && (
                <>
                  <h4 className={styles.subSectionTitle}>Search Tool Contract</h4>
                  <PropertyGrid
                    items={[
                      { label: "Skills", value: toolkit.contract.skillTags.join(", ") },
                      { label: "Effect", value: toolkit.contract.effect },
                      { label: "Execution", value: toolkit.contract.executionMode },
                      { label: "Approval", value: toolkit.contract.approval.required ? `Yes (${toolkit.contract.approval.suggestedGate ?? "pre_send"})` : "No" },
                    ]}
                  />
                </>
              )}
              {toolkit.actions && toolkit.actions.length > 0 && (
                <>
                  <h4 className={styles.subSectionTitle}>Actions ({toolkit.actions.length})</h4>
                  {toolkit.actions.map((action) => (
                    <CollapsibleCard key={action.slug} title={action.slug} subtitle={action.name} badge={<span className={`${styles.miniBadge} ${riskBadge(action.risk)}`}>{action.risk}</span>}>
                      <p>{action.description}</p>
                      <PropertyGrid items={[
                        { label: "Risk", value: action.risk },
                        { label: "Contract", value: action.contract ? `${action.contract.toolRef} (${action.contract.effect})` : "None" },
                      ]} />
                      {action.contract && (
                        <details className={styles.schemaDetails}>
                          <summary className={styles.schemaSummary}>Contract Details</summary>
                          <PropertyGrid items={[
                            { label: "Skills", value: action.contract.skillTags.join(", ") },
                            { label: "Resources", value: action.contract.resources.join(", ") || "—" },
                            { label: "Effect", value: action.contract.effect },
                            { label: "Execution", value: action.contract.executionMode },
                            { label: "Approval", value: action.contract.approval.required ? `Yes (${action.contract.approval.suggestedGate ?? "pre_send"})` : "No" },
                          ]} />
                          <pre className={styles.schemaBlock}>{JSON.stringify(action.contract.outputSchema, null, 2)}</pre>
                        </details>
                      )}
                    </CollapsibleCard>
                  ))}
                </>
              )}
            </CollapsibleCard>
          ))
        )}
      </Section>

      <Section title="Tool Catalog (Auth-Filtered)" icon={<Radio size={18} />} count={totalCatalog}>
        {toolCatalog.length === 0 ? (
          <p className={styles.empty}>No tools available.</p>
        ) : (
          <div className={styles.catalogGrid}>
            {toolCatalog.map((entry) => (
              <div key={entry.ref} className={styles.catalogEntry}>
                <div className={styles.catalogEntryHeader}>
                  <code className={styles.catalogRef}>{entry.ref}</code>
                  <span className={`${styles.miniBadge} ${riskBadge(entry.riskLevel)}`}>{entry.riskLevel}</span>
                </div>
                <div className={styles.catalogEntryBody}>
                  <p>{entry.description}</p>
                  <PropertyGrid
                    items={[
                      { label: "Provider", value: entry.provider },
                      { label: "Toolkit", value: entry.toolkit ?? "—" },
                      { label: "Requires Connector", value: entry.requiresConnector ? "Yes" : "No" },
                      { label: "Requires Approval", value: entry.requiresApproval ? "Yes" : "No" },
                      { label: "Actionable", value: entry.isActionable ? "Yes" : "No" },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Render Targets" icon={<Workflow size={18} />} count={platform.renderTargets.length}>
        <div className={styles.flowGrid}>
          {platform.renderTargets.map((rt) => (
            <div key={rt.target} className={styles.flowCard}>
              <code className={styles.flowCode}>{rt.target}</code>
              <p className={styles.flowDesc}>{rt.description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Approval Flows &amp; Platform" icon={<Shield size={18} />}>
        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Gate Types</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.gateTypes.map((gt) => (
              <div key={gt.type} className={styles.flowCard}>
                <code className={styles.flowCode}>{gt.type}</code>
                <p className={styles.flowDesc}>{gt.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Approval Modes</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.approvalModes.map((am) => (
              <div key={am.mode} className={styles.flowCard}>
                <code className={styles.flowCode}>{am.mode}</code>
                <p className={styles.flowDesc}>{am.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Rejection Behaviors</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.rejectionBehaviors.map((rb) => (
              <div key={rb.behavior} className={styles.flowCard}>
                <code className={styles.flowCode}>{rb.behavior}</code>
                <p className={styles.flowDesc}>{rb.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Approval Channels</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.channels.map((ch) => (
              <div key={ch.channel} className={styles.flowCard}>
                <code className={styles.flowCode}>{ch.channel}</code>
                <p className={styles.flowDesc}>{ch.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Execution Modes</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.executionModes.map((em) => (
              <div key={em.mode} className={styles.flowCard}>
                <code className={styles.flowCode}>{em.mode}</code>
                <p className={styles.flowDesc}>{em.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Tool Effects</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.toolEffects.map((te) => (
              <div key={te.effect} className={styles.flowCard}>
                <code className={`${styles.flowCode} ${effectBadge(te.effect)}`}>{te.effect}</code>
                <p className={styles.flowDesc}>{te.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Stage Kinds</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.stageKinds.map((sk) => (
              <div key={sk.kind} className={styles.flowCard}>
                <code className={styles.flowCode}>{sk.kind}</code>
                <p className={styles.flowDesc}>{sk.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.flowSection}>
          <h3 className={styles.flowSectionTitle}>Connector Action Risks</h3>
          <div className={styles.flowGrid}>
            {platform.approvalFlows.connectorActionRisks.map((cr) => (
              <div key={cr.risk} className={styles.flowCard}>
                <code className={`${styles.flowCode} ${riskBadge(cr.risk)}`}>{cr.risk}</code>
                <p className={styles.flowDesc}>{cr.description}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Use Cases" icon={<ListChecks size={18} />} count={toolSpecRegistry.useCases.length}>
        <div className={styles.useCaseGrid}>
          {toolSpecRegistry.useCases.map((uc) => (
            <div key={uc.name} className={styles.useCaseCard}>
              <div className={styles.useCaseHeader}>
                <div>
                  <div className={styles.useCaseName}>{uc.name}</div>
                  <span className={`${styles.miniBadge} ${styles.badgeCategory}`}>{uc.category}</span>
                </div>
              </div>
              <p className={styles.useCaseDesc}>{uc.description}</p>
              <PropertyGrid items={[
                { label: "Required Tools", value: uc.requiredTools.join(", ") },
                { label: "Outcome", value: uc.outcome },
              ]} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

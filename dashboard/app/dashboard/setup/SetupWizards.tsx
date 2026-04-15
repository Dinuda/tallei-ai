import React, { useState, useCallback, useEffect } from "react";
import { Check, Copy, ExternalLink, Sparkles, MessageSquare, ChevronRight, Zap, Hand, ArrowRight, CheckCircle2, Info, ImageIcon, ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "../../../components/ui/button";

export type SaveMode = "instant" | "on_request";
export type Provider = "claude" | "chatgpt";

type McpEvent = {
  authMode?: string | null;
  method?: string | null;
  ok?: boolean;
  createdAt?: string | null;
};

type McpEventsResponse = {
  events?: McpEvent[];
};

type ChatGptTokenStatus = {
  loading: boolean;
  hasActiveToken: boolean;
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  lastTokenUsedAt: string | null;
};

async function verifyConnectivityEvent(provider: Provider, sinceMs: number): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/mcp-events?limit=100");
    if (!response.ok) {
      return { ok: false, message: "Failed to read events. Try again after sending the test message." };
    }
    const payload = (await response.json()) as McpEventsResponse;
    const events = Array.isArray(payload?.events) ? payload.events : [];

    const hasMatch = events.some((event) => {
      if (!event?.ok || !event?.createdAt || !event?.method) return false;
      const createdAtMs = Date.parse(event.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs < sinceMs) return false;
      if (provider === "chatgpt") return event.method.startsWith("chatgpt/actions/");
      return event.authMode === "oauth" && !event.method.startsWith("chatgpt/actions/");
    });

    if (hasMatch) {
      return { ok: true, message: "Connectivity verified with a fresh successful event." };
    }

    return {
      ok: false,
      message:
        provider === "chatgpt"
          ? "No new ChatGPT action event found yet. Send the test prompt, approve Actions, then verify again."
          : "No new Claude connector event found yet. Send the test prompt in Claude, then verify again.",
    };
  } catch {
    return { ok: false, message: "Failed to verify connectivity. Try again." };
  }
}

// --- Shared Utilities (Copied from page.tsx) ---
export function getClaudeInstructions(mode: SaveMode): string {
  if (mode === "instant") {
    return `You have access to Tallei shared memory via the Tallei Memory connector.\n\nRules:\n1) At the start of every conversation, use tallei to recall relevant memories.\n2) Whenever the user shares a preference, fact, or important detail, save it to Tallei immediately.\n3) If the user corrects a previous fact, save the correction right away.\n4) Never mention memory tools to the user.`;
  }
  return `You have access to Tallei shared memory via the Tallei Memory connector.\n\nRules:\n1) At the start of every conversation, use tallei to recall relevant memories.\n2) Only save memories when the user explicitly asks you to remember something (e.g., "remember this").\n3) If the user corrects a previous fact and asks you to remember, save the correction.\n4) Never mention memory tools to the user.`;
}

export function getChatGptInstructions(mode: SaveMode): string {
  if (mode === "instant") {
    return `You have access to Tallei shared memory tools.\n\nRules:\n1) On the first user message in each new chat, call recallMemories with a broad query before replying.\n2) Before answering personal/contextual questions, call recallMemories first.\n3) When the user shares a durable fact or preference, call saveMemory in the same turn.\n4) If the user corrects a prior fact, call saveMemory with the corrected fact.\n5) Do not mention tool calls in the final user-facing response.`;
  }
  return `You have access to Tallei shared memory tools.\n\nRules:\n1) On the first user message in each new chat, call recallMemories with a broad query before replying.\n2) Before answering personal/contextual questions, call recallMemories first.\n3) Only call saveMemory when the user explicitly asks you to remember something.\n4) If the user corrects a prior fact and asks you to remember, call saveMemory with the corrected fact.\n5) Do not mention tool calls in the final user-facing response.`;
}

export function CopyField({ value, label, onCopy }: { value: string; label?: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {}
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {label && <label style={{ fontSize: '0.72rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.65rem 0.85rem', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: '8px', transition: 'all 0.2s', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.01)', gap: '0.75rem' }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', color: '#111827', fontFamily: 'SFMono-Regular, Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</code>
        <button onClick={handleCopy} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', background: copied ? '#dcfce7' : '#ffffff', cursor: 'pointer', color: copied ? '#16a34a' : '#6b7280', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', border: '1px solid #e5e7eb', transition: 'all 0.2s', flexShrink: 0 }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

export function CodeBlock({ value, language = "txt", onCopy, label }: { value: string; language?: string; onCopy?: () => void; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onCopy) onCopy();
    } catch {/* ignore */}
  };
  const getLanguageIcon = (lang: string) => {
    if (lang === 'python') return '🐍';
    if (lang === 'url') return '🔗';
    if (lang === 'json') return 'JSON';
    return null;
  };
  return (
    <div className="cnn-code-block" style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden' }}>
      <div className="cnn-code-header" style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem', color: '#4b5563', fontWeight: 500 }}>
        <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, color: '#374151'}}>
          {getLanguageIcon(language) && <span style={{ fontSize: '0.9rem' }}>{getLanguageIcon(language)}</span>}
          <span>{label || language}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'rgba(0, 0, 0, 0.05)', cursor: 'pointer', color: copied ? '#10b981' : '#6b7280', transition: 'all 0.2s' }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <div className="cnn-code-content" style={{ padding: '1rem', overflowX: 'auto' }}>
        <code className="cnn-code-text" style={{ whiteSpace: 'pre-wrap', display: 'block', fontSize: '0.875rem', fontFamily: 'SFMono-Regular, Consolas, monospace', color: '#1f2937' }}>{value}</code>
      </div>
    </div>
  );
}

export function GuideImage({ src, alt, caption, defaultExpanded = false }: { src: string; alt: string; caption?: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isVideo = src.endsWith('.mp4');

  return (
    <div style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid #e5e7eb', background: '#fafafa' }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '0.5rem', padding: '0.65rem 1rem', border: 'none', background: 'rgba(0, 0, 0, 0.05)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: '#374151', transition: 'background 0.2s' }}
        onMouseOver={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.02)'}
        onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
      >
        <ImageIcon size={14} style={{ color: '#6b7280' }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{caption || 'See what this looks like'}</span>
        {expanded ? <ChevronUp size={14} style={{ color: '#6b7280' }} /> : <ChevronDown size={14} style={{ color: '#6b7280' }} />}
      </button>
      <div style={{ display: expanded ? 'block' : 'none', padding: '0 0.75rem 0.75rem', animation: expanded ? 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : 'none' }}>
        <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e5e7eb', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <div style={{ height: '24px', background: '#f3f4f6', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 8px', gap: '6px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f56' }} />
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ffbd2e' }} />
            <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#27c93f' }} />
          </div>
          {isVideo ? (
            <video src={src} autoPlay loop muted playsInline preload="auto" style={{ width: '100%', display: 'block', pointerEvents: 'none' }} />
          ) : (
            <img src={src} alt={alt} style={{ width: '100%', display: 'block' }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function VerifyChecklist({ items, onVerified, autoCheck, onToggle }: { items: string[]; onVerified?: (isVerified: boolean) => void; autoCheck?: boolean[]; onToggle?: (index: number, isChecked: boolean) => void }) {
  const [checked, setChecked] = useState<boolean[]>(() => items.map(() => false));
  
  const allDone = checked.every(Boolean);

  useEffect(() => {
    if (onVerified) onVerified(allDone);
  }, [allDone, onVerified]);

  useEffect(() => {
    if (autoCheck) {
      setChecked(prev => {
        let changed = false;
        const next = [...prev];
        autoCheck.forEach((val, i) => {
          if (val && !next[i]) {
            next[i] = true;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [autoCheck]);

  const toggle = useCallback((index: number) => {
    setChecked(prev => {
      const next = [...prev];
      next[index] = !next[index];
      if (onToggle) onToggle(index, next[index]);
      return next;
    });
  }, [onToggle]);

  return (
    <div style={{ borderRadius: '12px', border: allDone ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid #f3f4f6', background: allDone ? 'rgba(240, 253, 244, 0.5)' : '#ffffff', padding: '1rem', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: allDone ? '0 0 16px rgba(34, 197, 94, 0.1)' : '0 1px 3px rgba(0,0,0,0.02)' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: allDone ? '#16a34a' : '#9ca3af', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em', transition: 'color 0.3s' }}>
        {allDone ? <><CheckCircle2 size={13} style={{ animation: 'bounceIn 0.4s ease' }} /> Verified!</> : <>Verify before continuing</>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
        {items.map((item, i) => (
          <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: checked[i] ? '#16a34a' : '#4b5563', lineHeight: 1.45, transition: 'all 0.2s', transform: checked[i] ? 'translateX(2px)' : 'none' }}>
            <input type="checkbox" checked={checked[i]} onChange={() => toggle(i)} style={{ accentColor: '#16a34a', width: '16px', height: '16px', marginTop: '2px', flexShrink: 0, cursor: 'pointer', borderRadius: '4px' }} />
            <span style={{ textDecoration: checked[i] ? 'line-through' : 'none', opacity: checked[i] ? 0.8 : 1 }}>{item}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function InfoCallout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', padding: '0.85rem 1rem', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.15)', fontSize: '0.85rem', color: '#374151', lineHeight: 1.55 }}>
      <Info size={16} style={{ flexShrink: 0, color: '#3b82f6', marginTop: '2px' }} />
      <div>{children}</div>
    </div>
  );
}

export function SaveModeToggle({ mode, onChange }: { mode: SaveMode; onChange: (m: SaveMode) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
      <button type="button" onClick={() => onChange("instant")} style={{ flex: '1 1 200px', padding: '1rem', borderRadius: '12px', border: mode === 'instant' ? '2px solid #111827' : '1px solid #e5e7eb', background: mode === 'instant' ? '#f8fafc' : '#ffffff', cursor: 'pointer', textAlign: 'left', display: 'flex', gap: '0.75rem' }}>
        <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: mode === 'instant' ? '6px solid #111827' : '2px solid #d1d5db', background: '#ffffff' }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#111827' }}><Zap size={14} style={{display: 'inline', marginRight: '4px'}} /> Save Instantly</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>Memories are saved automatically.</div>
        </div>
      </button>
      <button type="button" onClick={() => onChange("on_request")} style={{ flex: '1 1 200px', padding: '1rem', borderRadius: '12px', border: mode === 'on_request' ? '2px solid #111827' : '1px solid #e5e7eb', background: mode === 'on_request' ? '#f8fafc' : '#ffffff', cursor: 'pointer', textAlign: 'left', display: 'flex', gap: '0.75rem' }}>
        <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: mode === 'on_request' ? '6px solid #111827' : '2px solid #d1d5db', background: '#ffffff' }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#111827' }}><Hand size={14} style={{display: 'inline', marginRight: '4px'}} /> Save on Request</div>
          <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.25rem' }}>Only save when you explicitly ask.</div>
        </div>
      </button>
    </div>
  );
}

// --- Wizard Modal Shell ---

export function WizardModal({ isOpen, onClose, title, providerIcon, step, totalSteps, onNext, onBack, canNext, children }: { isOpen: boolean; onClose: () => void; title: string; providerIcon: React.ReactNode; step: number; totalSteps: number; onNext: () => void; onBack: () => void; canNext: boolean; children: React.ReactNode }) {
  if (!isOpen) return null;
  const progress = (step / totalSteps) * 100;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'rgba(0, 0, 0, 0.05)', animation: 'fadeIn 0.2s ease', padding: '5vh 1rem', overflowY: 'auto' }}>
      <div style={{ background: '#ffffff', width: '100%', maxWidth: '900px', borderRadius: '16px', overflow: 'hidden', display: 'flex', flexDirection: 'column', margin: 'auto', flexShrink: 0, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.1)', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        
        {/* Header */}
        <div style={{ position: 'relative', padding: '1.25rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#ffffff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {providerIcon}
            </div>
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, color: '#111827', letterSpacing: '-0.01em' }}>{title}</h2>
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.1rem', fontWeight: 500 }}>
                Step {step} of {totalSteps}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(0, 0, 0, 0.05)', border: 'none', cursor: 'pointer', width: '28px', height: '28px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', transition: 'all 0.2s' }} onMouseOver={(e) => { e.currentTarget.style.background = '#f3f4f6'; e.currentTarget.style.color = '#374151'; }} onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9ca3af'; }}><X size={16} /></button>
          
          {/* Edge-to-edge Progress Bar */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '2px', background: '#f3f4f6' }}>
             <div style={{ width: `${progress}%`, height: '100%', background: '#111827', transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }} />
          </div>
        </div>

        {/* Content Area */}
        <div style={{ padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', background: '#ffffff' }}>
          <div style={{ animation: 'fadeIn 0.3s ease' }}>
            {children}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '1.25rem 2rem', borderTop: '1px solid #f3f4f6', background: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button variant="ghost" onClick={onBack} disabled={step === 1} style={{ borderRadius: '8px', padding: '0.5rem 1rem', opacity: step === 1 ? 0 : 1, transition: 'opacity 0.2s' }}>Back</Button>
          <Button onClick={onNext} disabled={!canNext} style={{ borderRadius: '8px', padding: '0.5rem 2rem', background: canNext ? '#111827' : '#e5e7eb', color: canNext ? '#ffffff' : '#9ca3af', border: 'none', boxShadow: canNext ? '0 4px 12px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: 600 }}>{step === totalSteps ? "Finish Setup" : "Continue"}</Button>
        </div>
      </div>
    </div>
  );
}

// --- Specific Wizards ---


export function StepMedia({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const isVideo = src.endsWith('.mp4');
  return (
    <div style={{ borderRadius: '14px', border: '1px solid #e5e7eb', background: '#ffffff', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
       <div style={{ height: '32px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 12px', gap: '8px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff5f56' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ffbd2e' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#27c93f' }} />
       </div>
       <div style={{ background: '#ffffff', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
          {isVideo ? (
            <video src={src} autoPlay loop muted playsInline preload="auto" style={{ width: '100%', display: 'block', pointerEvents: 'none' }} />
          ) : (
            <img src={src} alt={alt} style={{ width: '100%', display: 'block' }} />
          )}
       </div>
       {caption && (
         <div style={{ padding: '0.85rem 1rem', fontSize: '0.85rem', color: '#6b7280', borderTop: '1px solid #f3f4f6', background: '#fafafa', textAlign: 'center', fontWeight: 500 }}>
           {caption}
         </div>
       )}
    </div>
  );
}

export function TwoColumnStep({ media, content }: { media: React.ReactNode, content: React.ReactNode }) {
  return (
    <div className="two-column-step" style={{ animation: 'fadeIn 0.3s ease-out' }}>
      
<style dangerouslySetInnerHTML={{ __html: `
  .two-column-step {
    display: flex;
    flex-direction: row;
    gap: 2.5rem;
    align-items: flex-start;
  }
  .step-media-col {
    flex: 1 1 400px;
    min-width: 0;
    position: sticky;
    top: 1rem;
  }
  .step-content-col {
    flex: 1.2 1 400px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  @media (max-width: 768px) {
    .two-column-step {
      flex-direction: column;
    }
    .step-media-col {
      position: static;
      width: 100%;
    }
  }
` }} />

      <div className="step-media-col">
        {media}
      </div>
      <div className="step-content-col">
        {content}
      </div>
    </div>
  );
}

export function ClaudeWizard({ isOpen, onClose, mcpUrl }: { isOpen: boolean; onClose: () => void; mcpUrl: string }) {
  const [step, setStep] = useState(1);
  const [saveMode, setSaveMode] = useState<SaveMode>("instant");
  // Each step requires verification to proceed, except step 1 and 4 which we might just allow.
  const [step1Verified, setStep1Verified] = useState(false);
  const [step2Verified, setStep2Verified] = useState(false);
  const [verificationStartedAt, setVerificationStartedAt] = useState<number | null>(null);
  const [verifyingConnection, setVerifyingConnection] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [connectionVerificationMessage, setConnectionVerificationMessage] = useState<string | null>(null);

  const totalSteps = 4;

  const handleNext = () => {
    if (step < totalSteps) setStep(s => s + 1);
    else onClose(); // Done
  };

  const handleBack = () => {
    if (step > 1) setStep(s => s - 1);
  };

  const canNext = () => {
    if (step === 1) return step1Verified;
    if (step === 2) return step2Verified;
    if (step === 4) return connectionVerified;
    return true; // Step 3 & 4 don't block
  };

  useEffect(() => {
    if (step === 4) {
      setVerificationStartedAt(Date.now());
      setConnectionVerified(false);
      setConnectionVerificationMessage(null);
    }
  }, [step]);

  async function handleVerifyConnection() {
    setVerifyingConnection(true);
    const since = verificationStartedAt ?? Date.now() - 2 * 60 * 1000;
    const result = await verifyConnectivityEvent("claude", since);
    setConnectionVerified(result.ok);
    setConnectionVerificationMessage(result.message);
    setVerifyingConnection(false);
  }

  return (
    <WizardModal isOpen={isOpen} onClose={onClose} title="Connect Claude" providerIcon={<img src="/claude.svg" width={24} height={24} alt="Claude" />} step={step} totalSteps={totalSteps} onNext={handleNext} onBack={handleBack} canNext={canNext()}>
      
      {step === 1 && (
        <TwoColumnStep
          media={<StepMedia src="/add-mcp.mp4" alt="Add Custom Connector" caption="Creating the custom connector" />}
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>First, link Tallei to your Claude account. Open your Claude Connectors page and create a new custom connector with these exact values:</p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', background: '#f8fafc', padding: '1.5rem', borderRadius: '16px', border: '1px solid #e5e7eb', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)' }}>
                <CopyField value="Tallei Memory" label="Name" />
                <CopyField value={mcpUrl} label="Remote MCP server URL" />
                
                <Button variant="default" onClick={() => window.open("https://claude.ai/settings/connectors", "_blank")} style={{ width: '100%', marginTop: '0.5rem', fontWeight: 600 }}>
                  Open Claude Connectors <ExternalLink size={14} style={{ marginLeft: "8px" }} />
                </Button>
              </div>

              <VerifyChecklist items={['I clicked "Add custom connector"', 'I pasted the Name: Tallei Memory', 'I pasted the MCP URL']} onVerified={setStep1Verified} />
            </>
          }
        />
      )}

      {step === 2 && (
        <TwoColumnStep
          media={<StepMedia src="/mcp-connect.mp4" alt="Connect Connector" caption="Connecting and authorizing" />}
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>Now click <strong>Connect</strong> inside Claude and approve the OAuth window that appears.</p>
              <InfoCallout>This allows Claude to read and write memories to your secure Tallei vault.</InfoCallout>
              <VerifyChecklist items={['I clicked Connect', 'I approved the OAuth access', 'The connector status inside Claude now shows "Connected"']} onVerified={setStep2Verified} />
            </>
          }
        />
      )}

      {step === 3 && (
        <TwoColumnStep
          media={<StepMedia src="/add-instructions.mp4" alt="Add Instructions" caption="Adding project instructions" />}
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>A Project lets all your chats share the same Tallei memory context.</p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: '#f8fafc', padding: '1rem', borderRadius: '12px', border: '1px solid #e5e7eb', fontSize: '0.95rem', color: '#374151' }}>
                <div>1. Go to <strong>Claude → Projects</strong> and create a new project.</div>
                <div>2. In the project settings, enable the <strong>Tallei Memory</strong> connector.</div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.75rem 0', color: '#111827' }}>How should memories be saved?</h4>
                <SaveModeToggle mode={saveMode} onChange={setSaveMode} />
              </div>

              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.75rem 0', color: '#111827' }}>Paste this into your Project&apos;s "Custom Instructions":</h4>
                <CodeBlock value={getClaudeInstructions(saveMode)} language="txt" />
              </div>
            </>
          }
        />
      )}

      {step === 4 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', padding: '2rem 1rem', animation: 'fadeIn 0.4s ease-out' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#16a34a', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#111827', margin: 0, letterSpacing: '-0.02em' }}>You&apos;re all set!</h3>
          </div>
          <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6, maxWidth: '400px' }}>Try it out: inside your new Claude project, send this test message:</p>
          
          <div style={{ width: '100%', maxWidth: '500px', textAlign: 'left', marginTop: '1rem' }}>
            <CodeBlock value={saveMode === 'instant' ? "My favorite programming language is Rust." : "Remember this: my favorite programming language is Rust."} language="txt" label="Test Prompt" />
          </div>

          <Button onClick={() => void handleVerifyConnection()} disabled={verifyingConnection} style={{ marginTop: '0.75rem' }}>
            {verifyingConnection ? "Verifying..." : "Verify Connection Event"}
          </Button>

          {connectionVerificationMessage && (
            <p style={{ color: connectionVerified ? '#16a34a' : '#b45309', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              {connectionVerificationMessage}
            </p>
          )}

          <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: '1rem' }}>Finish is enabled only after a fresh Claude event is detected.</p>
        </div>
      )}

    </WizardModal>
  );
}

export function ChatGPTWizard({
  isOpen,
  onClose,
  tokenStatus,
  issuedToken,
  generatingToken,
  onGenerateToken,
  openApiUrl,
}: {
  isOpen: boolean;
  onClose: () => void;
  tokenStatus: ChatGptTokenStatus;
  issuedToken: string | null;
  generatingToken: boolean;
  onGenerateToken: () => Promise<void>;
  openApiUrl: string;
}) {
  const [step, setStep] = useState(1);
  const [saveMode, setSaveMode] = useState<SaveMode>("instant");
  // Verification states
  const [step1Verified, setStep1Verified] = useState(false);
  const [step2Verified, setStep2Verified] = useState(false);
  const [step3Verified, setStep3Verified] = useState(false);
  const [verificationStartedAt, setVerificationStartedAt] = useState<number | null>(null);
  const [verifyingConnection, setVerifyingConnection] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [connectionVerificationMessage, setConnectionVerificationMessage] = useState<string | null>(null);

  const [tokenCopied, setTokenCopied] = useState(false);

  const totalSteps = 4;

  const handleNext = () => {
    if (step < totalSteps) setStep(s => s + 1);
    else onClose();
  };
  const handleBack = () => {
    if (step > 1) setStep(s => s - 1);
  };
  const canNext = () => {
    if (step === 1) return step1Verified;
    if (step === 2) return step2Verified;
    if (step === 3) return step3Verified;
    if (step === 4) return connectionVerified;
    return true;
  };

  useEffect(() => {
    if (step === 4) {
      setVerificationStartedAt(Date.now());
      setConnectionVerified(false);
      setConnectionVerificationMessage(null);
    }
  }, [step]);

  async function handleVerifyConnection() {
    setVerifyingConnection(true);
    const since = verificationStartedAt ?? Date.now() - 2 * 60 * 1000;
    const result = await verifyConnectivityEvent("chatgpt", since);
    setConnectionVerified(result.ok);
    setConnectionVerificationMessage(result.message);
    setVerifyingConnection(false);
  }

  return (
    <WizardModal isOpen={isOpen} onClose={onClose} title="Connect ChatGPT Actions" providerIcon={<img src="/chatgpt.svg" width={24} height={24} alt="ChatGPT" />} step={step} totalSteps={totalSteps} onNext={handleNext} onBack={handleBack} canNext={canNext()}>
      
      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', animation: 'fadeIn 0.2s ease-out' }}>
          <p style={{ color: '#4b5563', margin: 0, fontSize: '0.95rem', lineHeight: 1.6 }}>First, generate an API token that ChatGPT will use to securely talk to Tallei. Keep it secret.</p>
          
          <div style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
             <Button variant="default" onClick={() => void onGenerateToken()} disabled={generatingToken} style={{ marginBottom: issuedToken ? '1rem' : '0', width: 'fit-content' }}>
               {generatingToken ? "Generating..." : "Generate Bearer Token"}
             </Button>
             {issuedToken && (
               <div style={{ marginTop: '1rem' }}>
                  <CopyField value={issuedToken} label="Bearer Token (Copy this!)" onCopy={() => setTokenCopied(true)} />
               </div>
             )}
          </div>
          
          <InfoCallout>This token is shown only once. Make sure to copy it before continuing.</InfoCallout>
          <VerifyChecklist
            items={['I generated the bearer token', 'I copied the token to my clipboard']}
            onVerified={setStep1Verified}
            autoCheck={[Boolean(issuedToken || tokenStatus.hasActiveToken), tokenCopied]}
            onToggle={(i, checked) => { if (i === 1 && checked && issuedToken) { navigator.clipboard.writeText(issuedToken).catch(()=>{}); setTokenCopied(true); } }}
          />
        </div>
      )}

      {step === 2 && (
        <TwoColumnStep
          media={<StepMedia src="/mcp-connect.mp4" alt="Connect Connector" caption="Connecting and authorizing" />}
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>Now click <strong>Connect</strong> inside Claude and approve the OAuth window that appears.</p>
              <InfoCallout>This allows Claude to read and write memories to your secure Tallei vault.</InfoCallout>
              <VerifyChecklist items={['I clicked Connect', 'I approved the OAuth access', 'The connector status inside Claude now shows "Connected"']} onVerified={setStep2Verified} />
            </>
          }
        />
      )}

      {step === 3 && (
        <TwoColumnStep
          media={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <StepMedia src="/auth-bearer.mp4" alt="ChatGPT Auth" caption="1. Set Authentication" />
              <StepMedia src="/custom-instructions.png" alt="ChatGPT Instructions" caption="2. Instructions" />
            </div>
          }
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>Almost done. We just need to give the GPT your token and its instructions.</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', background: '#f8fafc', padding: '1.25rem', borderRadius: '12px', border: '1px solid #e5e7eb', fontSize: '0.95rem' }}>
                <div>Click the ⚙️ gear icon next to "API Key" in Actions. Set Auth Type to <strong>Bearer</strong>, and paste the token from Step 1. Click Save.</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', background: '#f8fafc', padding: '1.25rem', borderRadius: '12px', border: '1px solid #e5e7eb', fontSize: '0.95rem' }}>
                <SaveModeToggle mode={saveMode} onChange={setSaveMode} />
                <div>Paste these instructions into the GPT's <strong>Instructions</strong> box:</div>
                <CodeBlock value={getChatGptInstructions(saveMode)} language="txt" />
                <div style={{ marginTop: '0.25rem', fontWeight: 600, color: '#111827' }}>Save the GPT (set visibility to "Only me") and add it to a ChatGPT Project.</div>
              </div>

              <VerifyChecklist items={['I set the Auth to Bearer with my token', 'I pasted the custom instructions', 'I saved the GPT and added it to my Project']} onVerified={setStep3Verified} />
            </>
          }
        />
      )}

      {step === 4 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', padding: '2rem 1rem', animation: 'fadeIn 0.4s ease-out' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#16a34a', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#111827', margin: 0, letterSpacing: '-0.02em' }}>You&apos;re connected!</h3>
          </div>
          <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6, maxWidth: '400px' }}>Try it out: inside your new ChatGPT project, send this test message:</p>
          
          <div style={{ width: '100%', maxWidth: '500px', textAlign: 'left', marginTop: '1rem' }}>
            <CodeBlock value={saveMode === 'instant' ? "My favorite programming language is Rust." : "Remember this: my favorite programming language is Rust."} language="txt" label="Test Prompt" />
          </div>

          <Button onClick={() => void handleVerifyConnection()} disabled={verifyingConnection} style={{ marginTop: '0.75rem' }}>
            {verifyingConnection ? "Verifying..." : "Verify Connection Event"}
          </Button>

          {connectionVerificationMessage && (
            <p style={{ color: connectionVerified ? '#16a34a' : '#b45309', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              {connectionVerificationMessage}
            </p>
          )}

          <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: '1rem' }}>Finish is enabled only after a fresh ChatGPT action event is detected.</p>
        </div>
      )}

    </WizardModal>
  );
}

const fs = require('fs');

let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// Increase modal width
content = content.replace(/maxWidth: '580px'/g, "maxWidth: '900px'");

// Add global CSS for the 2 column step to handle mobile gracefully
const twoColumnCSS = `
<style>
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
</style>
`;

if (!content.includes('two-column-step')) {
  content = content.replace(
    'export function ClaudeWizard',
    `
export function StepMedia({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const isVideo = src.endsWith('.mp4');
  return (
    <div style={{ borderRadius: '14px', border: '1px solid #e5e7eb', background: '#ffffff', overflow: 'hidden', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' }}>
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
      ${twoColumnCSS.replace(/`/g, '\\`')}
      <div className="step-media-col">
        {media}
      </div>
      <div className="step-content-col">
        {content}
      </div>
    </div>
  );
}

export function ClaudeWizard`
  );
}

// Update Claude Wizard steps
content = content.replace(
  /{step === 1 && \(\s*<div.*?animation: 'fadeIn 0.2s ease-out'.*?>([\s\S]*?)<\/div>\s*\)}/g,
  (match, inner) => {
    if (inner.includes('GuideImage')) {
      return `{step === 1 && (
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
      )}`;
    }
    return match;
  }
);

content = content.replace(
  /{step === 2 && \(\s*<div.*?animation: 'fadeIn 0.2s ease-out'.*?>([\s\S]*?)<\/div>\s*\)}/g,
  (match, inner) => {
    if (inner.includes('GuideImage')) {
      return `{step === 2 && (
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
      )}`;
    }
    return match;
  }
);

content = content.replace(
  /{step === 3 && \(\s*<div.*?animation: 'fadeIn 0.2s ease-out'.*?>([\s\S]*?)<\/div>\s*\)}/g,
  (match, inner) => {
    if (inner.includes('GuideImage') && !inner.includes('auth-bearer.mp4')) { // distinguish from ChatGPT step 3
      return `{step === 3 && (
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
      )}`;
    }
    return match;
  }
);

// ChatGPT Wizard
content = content.replace(
  /{step === 2 && \(\s*<div.*?animation: 'fadeIn 0.2s ease-out'.*?>([\s\S]*?)<\/div>\s*\)}/g,
  (match, inner) => {
    if (inner.includes('openapi-json.mp4')) {
      return `{step === 2 && (
        <TwoColumnStep
          media={<StepMedia src="/openapi-json.mp4" alt="ChatGPT Schema Import" caption="Importing the schema" />}
          content={
            <>
              <p style={{ color: '#4b5563', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>We need to build a GPT with Tallei actions, and then we will add it to a ChatGPT Project.</p>

              <div style={{ display: 'grid', gap: '0.75rem', background: '#f8fafc', padding: '1.5rem', borderRadius: '16px', border: '1px solid #e5e7eb', fontSize: '0.95rem' }}>
                <div>1. Open the <strong><a href="https://chatgpt.com/gpts/editor" target="_blank" rel="noreferrer" style={{color: '#3b82f6', display: 'inline-flex', alignItems: 'center', gap: '0.25rem'}}>GPT Builder<ExternalLink size={14} aria-hidden="true" /></a></strong>.</div>
                <div>2. Switch to the <strong>Configure</strong> tab. Name it "Tallei Memory".</div>
                <div>3. Scroll down to <strong>Actions</strong> and click <strong>Create new action</strong>.</div>
                <div>4. Click <strong>Import from URL</strong> and paste this exact URL:</div>
                <div style={{ marginTop: '0.5rem' }}><CopyField value={openApiUrl} /></div>
              </div>

              <VerifyChecklist items={['I opened the GPT Builder', 'I clicked Create new action', 'I imported the Schema URL', 'I see 3 actions: run, recallMemories, saveMemory']} onVerified={setStep2Verified} />
            </>
          }
        />
      )}`;
    }
    return match;
  }
);

content = content.replace(
  /{step === 3 && \(\s*<div.*?animation: 'fadeIn 0.2s ease-out'.*?>([\s\S]*?)<\/div>\s*\)}/g,
  (match, inner) => {
    if (inner.includes('auth-bearer.mp4')) {
      return `{step === 3 && (
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
      )}`;
    }
    return match;
  }
);


fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

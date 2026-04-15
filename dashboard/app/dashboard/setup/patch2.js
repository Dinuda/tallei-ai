const fs = require('fs');

let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// Fix ChatGPTWizard step 2
content = content.replace(
  /{step === 2 && \([\s\S]*?Now click <strong>Connect<\/strong> inside Claude[\s\S]*?<\/TwoColumnStep>\s*\)}/g,
  `{step === 2 && (
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
      )}`
);

fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

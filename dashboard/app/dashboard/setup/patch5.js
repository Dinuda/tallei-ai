const fs = require('fs');
let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// 1. Update VerifyChecklist props
content = content.replace(
  /export function VerifyChecklist\(\{ items, onVerified, autoCheck \}: \{ items: string\[\]; onVerified\?: \(isVerified: boolean\) => void; autoCheck\?: boolean\[\] \}\) \{/,
  "export function VerifyChecklist({ items, onVerified, autoCheck, onToggle }: { items: string[]; onVerified?: (isVerified: boolean) => void; autoCheck?: boolean[]; onToggle?: (index: number, isChecked: boolean) => void }) {"
);

// 2. Update the toggle function in VerifyChecklist
content = content.replace(
  /const toggle = useCallback\(\(index: number\) => \{\n\s*setChecked\(prev => \{\n\s*const next = \[\.\.\.prev\];\n\s*next\[index\] = !next\[index\];\n\s*return next;\n\s*\}\);\n\s*\}, \[\]\);/,
  `const toggle = useCallback((index: number) => {
    setChecked(prev => {
      const next = [...prev];
      next[index] = !next[index];
      if (onToggle) onToggle(index, next[index]);
      return next;
    });
  }, [onToggle]);`
);

// 3. Add onToggle to the ChatGPTWizard VerifyChecklist step 1
content = content.replace(
  /<VerifyChecklist items=\{\['I generated the bearer token', 'I copied the token to my clipboard'\]\} onVerified=\{setStep1Verified\} autoCheck=\{\[!!issuedToken, tokenCopied\]\} \/>/,
  `<VerifyChecklist items={['I generated the bearer token', 'I copied the token to my clipboard']} onVerified={setStep1Verified} autoCheck={[!!issuedToken, tokenCopied]} onToggle={(i, checked) => { if (i === 1 && checked && issuedToken) { navigator.clipboard.writeText(issuedToken).catch(()=>{}); setTokenCopied(true); } }} />`
);

fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

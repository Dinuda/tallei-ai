const fs = require('fs');
let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// The replacement of the component definition might not have worked due to regex mismatches. Let's do string replacement instead.
const oldDef = "export function VerifyChecklist({ items, onVerified, autoCheck }: { items: string[]; onVerified?: (isVerified: boolean) => void; autoCheck?: boolean[] }) {";
const newDef = "export function VerifyChecklist({ items, onVerified, autoCheck, onToggle }: { items: string[]; onVerified?: (isVerified: boolean) => void; autoCheck?: boolean[]; onToggle?: (index: number, isChecked: boolean) => void }) {";
content = content.replace(oldDef, newDef);

// Replace toggle function
const oldToggle = `  const toggle = useCallback((index: number) => {
    setChecked(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);`;
const newToggle = `  const toggle = useCallback((index: number) => {
    setChecked(prev => {
      const next = [...prev];
      next[index] = !next[index];
      if (onToggle) onToggle(index, next[index]);
      return next;
    });
  }, [onToggle]);`;
content = content.replace(oldToggle, newToggle);

// Let's replace the autoCheck property area since it has line breaks
content = content.replace(
  /autoCheck=\{\[Boolean\(issuedToken \|\| tokenStatus\.hasActiveToken\), tokenCopied\]\}\s*\/>/g,
  `autoCheck={[Boolean(issuedToken || tokenStatus.hasActiveToken), tokenCopied]}\n            onToggle={(i, checked) => { if (i === 1 && checked && issuedToken) { navigator.clipboard.writeText(issuedToken).catch(()=>{}); setTokenCopied(true); } }}\n          />`
);

// We also have to handle the second one, because I see two definitions of ChatGPTWizard (maybe). Wait, is there only one? 
// The grep showed line 598. The SetupWizards.tsx looks huge now (maybe due to multiple patch attempts or duplicated content).
fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

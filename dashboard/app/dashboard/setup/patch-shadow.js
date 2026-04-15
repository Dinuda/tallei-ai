const fs = require('fs');

let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// Replace the heavy box-shadow in StepMedia with a much subtler one (or just rely on the border)
content = content.replace(
  /boxShadow: '0 8px 30px rgba\\(0,0,0,0\\.06\\)'/,
  "boxShadow: '0 2px 8px rgba(0,0,0,0.03)'" // Subtler shadow
);

fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

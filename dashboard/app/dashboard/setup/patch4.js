const fs = require('fs');
let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

// It seems the boxShadow regex didn't match. Let's fix it by targeting the exact text.
content = content.replace(
  "boxShadow: '0 4px 20px rgba(0,0,0,0.1)'",
  "boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.1)'" 
);

// We also want to make sure the backdrop color is extremely light but noticeable.
content = content.replace(
  "background: 'rgba(255, 255, 255, 0.7)'",
  "background: 'rgba(0, 0, 0, 0.05)'" // A tiny bit of black instead of washing out the screen with white
);

fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

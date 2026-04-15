const fs = require('fs');

let content = fs.readFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', 'utf8');

const oldStyle = `<style>
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
</style>`;

const newStyle = `<style dangerouslySetInnerHTML={{ __html: \`
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
\` }} />`;

content = content.replace(oldStyle, newStyle);
fs.writeFileSync('dashboard/app/dashboard/setup/SetupWizards.tsx', content);

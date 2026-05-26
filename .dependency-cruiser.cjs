module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "orchestration-no-transport-imports",
      severity: "warn",
      from: { path: "^src/orchestration" },
      to: { path: "^src/transport" },
    },
    {
      name: "infrastructure-no-transport-imports",
      severity: "warn",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/transport" },
    },
    {
      name: "feature-no-app-imports",
      severity: "warn",
      from: { path: "^src/feature" },
      to: { path: "^src/app" },
    },
    {
      name: "adapters-no-feature-imports",
      severity: "warn",
      from: { path: "^src/adapters" },
      to: { path: "^src/feature" },
    },
    {
      name: "adapters-no-app-imports",
      severity: "warn",
      from: { path: "^src/adapters" },
      to: { path: "^src/app" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};

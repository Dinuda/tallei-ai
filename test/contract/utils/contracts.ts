import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface HttpRouteContractEntry {
  readonly method: string;
  readonly path: string;
  readonly source: string;
}

export interface McpToolContractEntry {
  readonly name: string;
  readonly inputSchema: string;
}

interface ImportBinding {
  readonly modulePath: string;
  readonly importedName: string;
}

const ROUTER_METHODS = new Set(["all", "get", "post", "put", "patch", "delete", "use"]);
const APP_METHODS = new Set(["all", "get", "post", "put", "patch", "delete", "use"]);

function createSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function normalizeRouteSourceLabel(sourceLabel: string): string {
  const match = sourceLabel.match(/^src\/transport\/http\/routes\/(.+)\.ts$/);
  if (!match) return sourceLabel;
  return `src/routes/${match[1]}.ts`;
}

function asStringLiteral(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function normalizePath(input: string): string {
  const collapsed = input.replace(/\/+/g, "/").replace(/\/\/{2,}/g, "/");
  if (collapsed === "") return "/";
  if (!collapsed.startsWith("/")) return `/${collapsed}`;
  return collapsed;
}

function joinPaths(basePath: string, childPath: string): string {
  const base = normalizePath(basePath);
  const child = normalizePath(childPath);
  if (child === "/") return base;
  return normalizePath(`${base.replace(/\/$/, "")}/${child.replace(/^\//, "")}`);
}

function importBindingsFromSource(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const modulePath = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      bindings.set(clause.name.text, { modulePath, importedName: "default" });
    }

    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;

    for (const element of clause.namedBindings.elements) {
      const localName = element.name.text;
      const importedName = element.propertyName?.text ?? element.name.text;
      bindings.set(localName, { modulePath, importedName });
    }
  }

  return bindings;
}

function routeEntriesFromRouterFile(
  repoRoot: string,
  filePath: string,
  mountPath: string,
  sourceLabel: string,
  visited = new Set<string>()
): HttpRouteContractEntry[] {
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  const sourceFile = createSourceFile(filePath);
  const entries: HttpRouteContractEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;

      if (ts.isIdentifier(receiver) && receiver.text === "router" && ROUTER_METHODS.has(method)) {
        const routePath = asStringLiteral(node.arguments[0]);
        if (routePath) {
          entries.push({
            method: method.toUpperCase(),
            path: joinPaths(mountPath, routePath),
            source: sourceLabel,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (entries.length > 0) return entries;

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const targetPath = path.resolve(path.dirname(filePath), moduleSpecifier.text.replace(/\.js$/, ".ts"));
    const targetLabel = toPosixPath(path.relative(repoRoot, targetPath));
    const forwarded = routeEntriesFromRouterFile(repoRoot, targetPath, mountPath, targetLabel, visited);
    if (forwarded.length > 0) return forwarded;
  }

  return entries;
}

function countTopLevelAppRouteCalls(sourceFile: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      APP_METHODS.has(node.expression.name.text) &&
      asStringLiteral(node.arguments[0])
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function countRegisterToolCalls(sourceFile: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerTool"
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

export function extractHttpRouteContract(repoRoot: string): HttpRouteContractEntry[] {
  const entryCandidates = [
    path.join(repoRoot, "src/index.ts"),
    path.join(repoRoot, "src/bootstrap/server.ts"),
    path.join(repoRoot, "src/transport/http/app.ts"),
  ];
  const entryFilePath = entryCandidates.find((candidate) => {
    try {
      return countTopLevelAppRouteCalls(createSourceFile(candidate)) > 0;
    } catch {
      return false;
    }
  }) ?? entryCandidates[0];
  const sourceFile = createSourceFile(entryFilePath);
  const sourceDir = path.dirname(entryFilePath);
  const appSourceLabel = "src/index.ts";
  const importBindings = importBindingsFromSource(sourceFile);
  const entries: HttpRouteContractEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "app") {
        ts.forEachChild(node, visit);
        return;
      }

      const method = node.expression.name.text;
      if (!APP_METHODS.has(method)) {
        ts.forEachChild(node, visit);
        return;
      }

      const pathArg = asStringLiteral(node.arguments[0]);
      if (!pathArg) {
        ts.forEachChild(node, visit);
        return;
      }

      if (method !== "use") {
        entries.push({
          method: method.toUpperCase(),
          path: normalizePath(pathArg),
          source: appSourceLabel,
        });
        ts.forEachChild(node, visit);
        return;
      }

      const target = node.arguments[node.arguments.length - 1];
      if (!target) {
        entries.push({
          method: "USE",
          path: normalizePath(pathArg),
          source: appSourceLabel,
        });
        ts.forEachChild(node, visit);
        return;
      }

      let bindingName: string | null = null;
      if (ts.isIdentifier(target)) {
        bindingName = target.text;
      } else if (ts.isCallExpression(target) && ts.isIdentifier(target.expression)) {
        bindingName = target.expression.text;
      }

      if (!bindingName) {
        entries.push({
          method: "USE",
          path: normalizePath(pathArg),
          source: "src/index.ts",
        });
        ts.forEachChild(node, visit);
        return;
      }

      const binding = importBindings.get(bindingName);
      const isRouteModule = binding
        ? binding.modulePath.startsWith("./routes/") || binding.modulePath.startsWith("../routes/")
        : false;
      if (!binding || !isRouteModule) {
        entries.push({
          method: "USE",
          path: normalizePath(pathArg),
          source: appSourceLabel,
        });
        ts.forEachChild(node, visit);
        return;
      }

      const routeFilePath = path.resolve(sourceDir, binding.modulePath.replace(/\.js$/, ".ts"));
      const routeSourceLabel = toPosixPath(path.relative(repoRoot, routeFilePath));
      const routeEntries = routeEntriesFromRouterFile(repoRoot, routeFilePath, pathArg, routeSourceLabel);
      for (const routeEntry of routeEntries) {
        entries.push({
          ...routeEntry,
          source: normalizeRouteSourceLabel(routeEntry.source),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const deduped = new Map<string, HttpRouteContractEntry>();
  for (const entry of entries) {
    deduped.set(`${entry.method} ${entry.path} ${entry.source}`, entry);
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.path === b.path) {
      if (a.method === b.method) return a.source.localeCompare(b.source);
      return a.method.localeCompare(b.method);
    }
    return a.path.localeCompare(b.path);
  });
}

export function extractMcpToolContract(repoRoot: string): McpToolContractEntry[] {
  const candidates = [
    path.join(repoRoot, "src/transport/mcp/tools/index.ts"),
    path.join(repoRoot, "src/transport/mcp/server.ts"),
    path.join(repoRoot, "src/mcp/server.ts"),
  ];
  const serverPath = candidates.find((candidate) => {
    try {
      return countRegisterToolCalls(createSourceFile(candidate)) > 0;
    } catch {
      return false;
    }
  }) ?? candidates[0];
  const sourceFile = createSourceFile(serverPath);
  const entries: McpToolContractEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text !== "registerTool") {
        ts.forEachChild(node, visit);
        return;
      }

      const name = asStringLiteral(node.arguments[0]);
      const options = node.arguments[1];
      if (!name || !options || !ts.isObjectLiteralExpression(options)) {
        ts.forEachChild(node, visit);
        return;
      }

      let schemaText = "{}";
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) continue;

        const propName = ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : null;

        if (propName === "inputSchema") {
          schemaText = property.initializer.getText(sourceFile);
          break;
        }
      }

      entries.push({ name, inputSchema: schemaText });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

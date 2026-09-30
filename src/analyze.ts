import { readFile, readdir, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-api";
import { atomicJson, hash } from "./files.js";

export type ImportEdge = {
  specifier: string;
  kind: "internal" | "external" | "unresolved" | "computed";
  target?: string;
  typeOnly: boolean;
  line: number;
};
export type SourceFile = {
  path: string;
  sha256: string;
  lines: number;
  test: boolean;
  exports: string[];
  imports: ImportEdge[];
};
export type Analysis = {
  version: 1;
  source: string;
  files: SourceFile[];
  cycles: string[][];
  warnings: string[];
  configs: { path: string; sha256: string }[];
};

// Strongly connected components, dependencies first. A cycle stays in one batch.
export function components(nodes: string[], edges: Map<string, string[]>) {
  let next = 0;
  const indexes = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    groups: string[][] = [];
  function visit(n: string) {
    indexes.set(n, next);
    low.set(n, next++);
    stack.push(n);
    active.add(n);
    for (const d of edges.get(n) ?? []) {
      if (!indexes.has(d)) {
        visit(d);
        low.set(n, Math.min(low.get(n)!, low.get(d)!));
      } else if (active.has(d))
        low.set(n, Math.min(low.get(n)!, indexes.get(d)!));
    }
    if (low.get(n) === indexes.get(n)) {
      const group = [];
      let d;
      do {
        d = stack.pop()!;
        active.delete(d);
        group.push(d);
      } while (d !== n);
      groups.push(group.sort());
    }
  }
  for (const n of [...nodes].sort()) if (!indexes.has(n)) visit(n);
  return groups;
}

export async function analyze(sourceInput: string): Promise<Analysis> {
  const source = await realpath(sourceInput);
  const names: string[] = [],
    configs: Analysis["configs"] = [],
    warnings: string[] = [];
  const packages = new Map<string, string>();
  async function walk(dir: string) {
    for (const e of await readdir(path.join(source, dir), {
      withFileTypes: true,
    })) {
      if (
        ["node_modules", "dist", "build", "coverage", "vendor"].includes(
          e.name,
        ) ||
        e.name.startsWith(".")
      )
        continue;
      const relative = path.posix.join(dir, e.name),
        absolute = path.join(source, relative);
      if (e.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link: ${relative}`);
        continue;
      }
      if (e.isDirectory()) await walk(relative);
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) names.push(relative);
      else if (e.name === "package.json" || /^tsconfig.*\.json$/.test(e.name)) {
        const text = await readFile(absolute, "utf8");
        configs.push({ path: relative, sha256: hash(text) });
        if (e.name === "package.json") {
          try {
            const pkg = JSON.parse(text);
            if (typeof pkg.name === "string") packages.set(pkg.name, dir);
          } catch {
            warnings.push(`Unable to parse: ${relative}`);
          }
        }
      }
    }
  }
  await walk("");
  names.sort();
  const known = new Set(names.map((n) => path.join(source, n)));
  const configCache = new Map<string, ts.CompilerOptions>();
  const relative = (name: string) =>
    path.relative(source, name).split(path.sep).join("/");
  function optionsFor(file: string) {
    let dir = path.dirname(file),
      config: string | undefined;
    while (dir === source || dir.startsWith(source + path.sep)) {
      if (ts.sys.fileExists(path.join(dir, "tsconfig.json"))) {
        config = path.join(dir, "tsconfig.json");
        break;
      }
      dir = path.dirname(dir);
    }
    const key = config ?? "default";
    if (!configCache.has(key)) {
      let options: ts.CompilerOptions = {
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        module: ts.ModuleKind.NodeNext,
        allowJs: true,
      };
      if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error)
          warnings.push(`Configuration parse failed: ${relative(config)}`);
        else {
          const parsed = ts.parseJsonConfigFileContent(
            read.config,
            ts.sys,
            path.dirname(config),
          );
          options = { ...options, ...parsed.options };
          for (const e of parsed.errors)
            if (e.code !== 18003)
              warnings.push(
                `${relative(config)}: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`,
              );
        }
      }
      configCache.set(key, options);
    }
    return configCache.get(key)!;
  }
  const files: SourceFile[] = [];
  for (const name of names) {
    const file = path.join(source, name),
      text = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const options = optionsFor(file);
    const imports: ImportEdge[] = [];
    const exports: string[] = [];
    for (const statement of ast.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      )
        exports.push(
          ...statement.exportClause.elements.map((e) => e.name.text),
        );
      else if (ts.isExportAssignment(statement)) exports.push("default");
      else if (
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (ts.isVariableStatement(statement))
          exports.push(
            ...statement.declarationList.declarations.map((d) =>
              d.name.getText(ast),
            ),
          );
        else if ("name" in statement && statement.name)
          exports.push((statement.name as ts.Node).getText(ast));
      }
    }
    function record(expr: ts.Node, typeOnly = false) {
      const line =
        ast.getLineAndCharacterOfPosition(expr.getStart(ast)).line + 1;
      if (!ts.isStringLiteralLike(expr)) {
        imports.push({
          specifier: expr.getText(ast),
          kind: "computed",
          typeOnly,
          line,
        });
        return;
      }
      const specifier = expr.text;
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        options,
        ts.sys,
      ).resolvedModule;
      const target = resolved && path.resolve(resolved.resolvedFileName);
      if (target && known.has(target))
        imports.push({
          specifier,
          kind: "internal",
          target: relative(target),
          typeOnly,
          line,
        });
      else {
        const own = [...packages.keys()].some(
          (p) => specifier === p || specifier.startsWith(p + "/"),
        );
        // A catch-all fallback is also tried for npm packages and Node builtins.
        // Its mere presence does not make every unresolved bare import internal.
        // Explicit mappings into node_modules likewise describe external packages.
        const alias = Object.entries(options.paths ?? {}).some(
          ([p, targets]) =>
            p !== "*" &&
            targets.some(
              (target) => !target.split(/[\\/]/).includes("node_modules"),
            ) &&
            (p.includes("*")
              ? specifier.startsWith(p.split("*")[0]) &&
                specifier.endsWith(p.split("*")[1])
              : p === specifier),
        );
        const unresolved =
          specifier.startsWith(".") ||
          path.isAbsolute(specifier) ||
          own ||
          alias;
        imports.push({
          specifier,
          kind: unresolved ? "unresolved" : "external",
          typeOnly,
          line,
        });
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node))
        record(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false);
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        record(node.moduleSpecifier, node.isTypeOnly);
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      )
        record(node.moduleReference.expression, node.isTypeOnly);
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        node.arguments[0]
      )
        record(node.arguments[0]);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        record(node.argument.literal, true);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    files.push({
      path: name,
      sha256: hash(text),
      lines: text ? text.split("\n").length - Number(text.endsWith("\n")) : 0,
      test: /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\./.test(name),
      exports: [...new Set(exports)],
      imports,
    });
  }
  const graph = new Map(
    files.map((f) => [
      f.path,
      f.imports.flatMap((e) => (e.target ? [e.target] : [])),
    ]),
  );
  return {
    version: 1,
    source,
    files,
    cycles: components(names, graph).filter(
      (g) => g.length > 1 || graph.get(g[0])?.includes(g[0]),
    ),
    warnings: [...new Set(warnings)],
    configs: configs.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export async function saveAnalysis(report: Analysis, out: string) {
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await atomicJson(out, report);
}

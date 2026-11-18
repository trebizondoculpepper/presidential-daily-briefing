/**
 * Architecture boundary guard for the application Git/GH facade (#953,
 * doc/design/git-gh-module-migrations.md).
 *
 * Uses `vite-plus`'s ESTree AST parser (`parseSync` / `Visitor`) to enforce two invariants
 * across non-test modules under `src/`:
 * 1. Direct `"git"` / `"gh"` child-process execution (including `promisify(...)` wrappers and
 *    shell command strings on `exec`/`execSync`) is confined to the private adapter allowlist.
 * 2. Private raw transport modules (`src/github/service/transport.ts`) are not imported or
 *    re-exported by application consumers outside the documented service/adapter allowlist.
 *
 * Unrelated node subprocesses (e.g. `nodeProbe`), `scripts/`, `src/testing/` and `*.test.ts`
 * remain allowed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSync, Visitor } from "vite-plus";

export interface FacadeViolation {
  file: string;
  line: number;
  rule: "direct-git-gh-exec" | "private-transport-import";
  detail: string;
}

/** Modules permitted to invoke `git` or `gh` directly via `node:child_process`. */
export const DIRECT_EXEC_ALLOWLIST = new Set<string>([
  "git/service.ts",
  "git/probe.ts",
  "git/remotes.ts",
  "github/service/transport.ts",
]);

/** Modules permitted to import `src/github/service/transport.ts`. */
export const PRIVATE_TRANSPORT_ALLOWLIST = new Set<string>([
  "github/service/service.ts",
  "github/service/transport.ts",
  "github/github.ts",
  "github/dependencies.ts",
]);

const EXEC_ARGS_FUNCTIONS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
const SHELL_EXEC_FUNCTIONS = new Set(["exec", "execSync"]);

function subprocessKind(fnName: string): "args" | "shell" | null {
  if (EXEC_ARGS_FUNCTIONS.has(fnName)) return "args";
  if (SHELL_EXEC_FUNCTIONS.has(fnName)) return "shell";
  return null;
}

function normalizeModulePath(srcDir: string, filePath: string): string {
  return relative(srcDir, filePath).split(sep).join("/");
}

function collectNonTestModules(dir: string, srcDir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === join(srcDir, "testing")) continue;
      results.push(...collectNonTestModules(full, srcDir));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractStringLiteral(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as {
    type?: string;
    value?: unknown;
    expressions?: unknown[];
    quasis?: Array<{ value?: { cooked?: string | null } }>;
  };
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (
    n.type === "TemplateLiteral" &&
    Array.isArray(n.expressions) &&
    n.expressions.length === 0 &&
    Array.isArray(n.quasis) &&
    n.quasis.length === 1
  ) {
    return n.quasis[0]?.value?.cooked ?? null;
  }
  return null;
}

function isGitOrGhCommand(node: unknown, kind: "args" | "shell"): "git" | "gh" | null {
  const raw = extractStringLiteral(node);
  if (raw === null) return null;
  const trimmed = raw.trim();
  const executable = kind === "shell" ? (trimmed.split(/\s+/)[0] ?? "") : trimmed;
  if (executable === "git" || executable.endsWith("/git") || executable.endsWith("\\git"))
    return "git";
  if (executable === "gh" || executable.endsWith("/gh") || executable.endsWith("\\gh")) return "gh";
  return null;
}

function resolvesToPrivateTransport(srcDir: string, fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(fromFile), specifier).replace(/\.(?:js|mjs|ts|tsx)$/, ".ts");
  return normalizeModulePath(srcDir, target) === "github/service/transport.ts";
}

/** Check one TypeScript source module against the Git/GH facade boundary rules. */
export function checkFacadeSource(
  srcDir: string,
  filePath: string,
  content: string,
): FacadeViolation[] {
  const rel = normalizeModulePath(srcDir, filePath);
  if (rel.startsWith("..") || rel.startsWith("testing/") || rel.endsWith(".test.ts")) {
    return [];
  }

  const violations: FacadeViolation[] = [];
  const parsed = parseSync(filePath, content);
  const childProcessAliases = new Map<string, "args" | "shell">();
  const childProcessNamespaces = new Set<string>();
  const promisifyAliases = new Set<string>();
  const utilNamespaces = new Set<string>();

  const checkPrivateTransport = (spec: unknown, startOffset: number): boolean => {
    if (typeof spec !== "string") return false;
    if (
      !PRIVATE_TRANSPORT_ALLOWLIST.has(rel) &&
      !rel.startsWith("github/service/") &&
      resolvesToPrivateTransport(srcDir, filePath, spec)
    ) {
      violations.push({
        file: rel,
        line: lineNumberAt(content, startOffset),
        rule: "private-transport-import",
        detail: `Imports private GH transport (${spec}) outside adapter allowlist.`,
      });
      return true;
    }
    return false;
  };

  const resolveSubprocessKind = (expr: unknown): "args" | "shell" | null => {
    if (!expr || typeof expr !== "object") return null;
    const e = expr as {
      type?: string;
      name?: string;
      object?: { type?: string; name?: string };
      property?: { type?: string; name?: string };
    };
    if (e.type === "Identifier" && e.name) {
      return childProcessAliases.get(e.name) ?? null;
    }
    if (
      e.type === "MemberExpression" &&
      e.object?.type === "Identifier" &&
      e.object.name &&
      childProcessNamespaces.has(e.object.name) &&
      e.property?.type === "Identifier" &&
      e.property.name
    ) {
      return subprocessKind(e.property.name);
    }
    return null;
  };

  const visitor = new Visitor({
    ImportDeclaration(node) {
      const spec = node.source?.value;
      if (typeof spec !== "string") return;
      if (checkPrivateTransport(spec, node.start)) return;
      if (spec === "node:util" || spec === "util") {
        for (const s of node.specifiers ?? []) {
          if (s.type === "ImportSpecifier") {
            const imported =
              s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value);
            if (imported === "promisify") promisifyAliases.add(s.local.name);
          } else if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier") {
            utilNamespaces.add(s.local.name);
          }
        }
        return;
      }
      if (spec !== "node:child_process" && spec !== "child_process") return;
      for (const s of node.specifiers ?? []) {
        if (s.type === "ImportSpecifier") {
          const imported =
            s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value);
          const kind = subprocessKind(imported);
          if (kind) childProcessAliases.set(s.local.name, kind);
        } else if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier") {
          childProcessNamespaces.add(s.local.name);
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.source) checkPrivateTransport(node.source.value, node.start);
    },
    ExportAllDeclaration(node) {
      checkPrivateTransport(node.source?.value, node.start);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init || node.init.type !== "CallExpression") {
        return;
      }
      const callee = node.init.callee;
      const isPromisify =
        (callee.type === "Identifier" && promisifyAliases.has(callee.name)) ||
        (callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          utilNamespaces.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          callee.property.name === "promisify");
      if (!isPromisify || node.init.arguments.length === 0) return;
      const kind = resolveSubprocessKind(node.init.arguments[0]);
      if (kind) childProcessAliases.set(node.id.name, kind);
    },
    CallExpression(node) {
      if (DIRECT_EXEC_ALLOWLIST.has(rel)) return;
      const kind = resolveSubprocessKind(node.callee);
      if (!kind || node.arguments.length === 0) return;
      const cmd = isGitOrGhCommand(node.arguments[0], kind);
      if (cmd) {
        violations.push({
          file: rel,
          line: lineNumberAt(content, node.start),
          rule: "direct-git-gh-exec",
          detail: `Direct ${cmd} execution outside adapter allowlist.`,
        });
      }
    },
  });
  visitor.visit(parsed.program);

  return violations;
}

/** Audit every non-test TypeScript module under `srcDir`. */
export function auditFacadeBoundary(srcDir: string): FacadeViolation[] {
  const files = collectNonTestModules(srcDir, srcDir);
  const all: FacadeViolation[] = [];
  for (const file of files) {
    all.push(...checkFacadeSource(srcDir, file, readFileSync(file, "utf8")));
  }
  return all;
}

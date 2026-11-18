import { readdir, readFile } from "node:fs/promises";

// Database schema has one source of truth: packages/shared/src/db-schema.
// API and worker import it directly. This guard answers the question the old
// "mirror" check never asked: does every declared table actually get created
// by some migration? A table added to the schema without DDL is a runtime
// "relation does not exist", not a type error.
const schemaDirectory = new URL("../../packages/shared/src/db-schema/", import.meta.url);
const migrationsDirectory = new URL("../../apps/api/src/db/migrations/", import.meta.url);

const schemaFiles = (await readdir(schemaDirectory)).filter((entry) => entry.endsWith(".ts")).sort();
if (schemaFiles.length === 0) {
  throw new Error(`canonical database schema directory is empty: ${schemaDirectory.pathname}`);
}

const schemaTables = new Map();
for (const file of schemaFiles) {
  const source = await readFile(new URL(file, schemaDirectory), "utf8");
  for (const match of source.matchAll(/pgTable\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g)) {
    const name = match[1];
    const existing = schemaTables.get(name);
    if (existing) {
      throw new Error(`table ${name} is declared twice: ${existing} and ${file}`);
    }
    schemaTables.set(name, file);
  }
}
if (schemaTables.size === 0) {
  throw new Error("no pgTable declarations found in packages/shared/src/db-schema");
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

const migrationTables = new Set();
for (const file of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
  const source = stripSqlComments(await readFile(new URL(file, migrationsDirectory), "utf8"));
  for (const match of source.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-zA-Z0-9_]+)["']?/gi,
  )) {
    migrationTables.add(match[1]);
  }
  // Renames are how several live tables were introduced (e.g. note_learning_artifacts).
  for (const match of source.matchAll(
    /ALTER\s+TABLE\s+(?:public\.)?["']?[a-zA-Z0-9_]+["']?\s+RENAME\s+TO\s+["']?([a-zA-Z0-9_]+)["']?/gi,
  )) {
    migrationTables.add(match[1]);
  }
}

const missing = [...schemaTables.keys()].filter((name) => !migrationTables.has(name)).sort();
if (missing.length > 0) {
  const detail = missing.map((name) => `  - ${name} (${schemaTables.get(name)})`).join("\n");
  throw new Error(
    `schema tables without CREATE TABLE / RENAME TO in migrations:\n${detail}\n` +
    "Add the forward migration (or a RENAME TO) instead of only editing the TypeScript schema.",
  );
}

const legacyOnly = [...migrationTables].filter((name) => !schemaTables.has(name)).length;
console.log(
  `canonical database schema OK (${schemaFiles.length} files; ` +
  `${schemaTables.size} tables, all created by migrations; ${legacyOnly} migration-only tables remain)`,
);
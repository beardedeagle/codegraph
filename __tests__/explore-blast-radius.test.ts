/**
 * codegraph_explore blast-radius section.
 *
 * explore now appends a compact, always-on "Blast radius" for the entry
 * symbols: who depends on each (locations only — no source) and which test
 * files cover it, so the agent knows what to update/verify before editing
 * without a separate impact call. Symbols with no dependents are skipped, and
 * the section is omitted entirely when nothing qualifies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { buildNode } from '../src/ui-server/api/node';
import { toNodeRef } from '../src/ui-server/api/wire';

describe('codegraph_explore — blast radius', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-blast-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // `target` is depended on by a sibling (caller) and a test file.
    fs.writeFileSync(
      path.join(src, 'feature.ts'),
      `export function target() { return 1; }\n` +
      `export function caller() { return target(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'feature.test.ts'),
      `import { target } from './feature';\n` +
      `export function checkTarget() { return target(); }\n`,
    );
    // A leaf with no dependents — must NOT show up in the blast radius.
    fs.writeFileSync(
      path.join(src, 'leaf.ts'),
      `export function lonelyLeaf() { return 42; }\n`,
    );
    // `deepHelper` is only called by production code (`midCaller`), but the
    // test file exercises it transitively — 2 caller hops up (#1475).
    fs.writeFileSync(
      path.join(src, 'util.ts'),
      `export function deepHelper() { return 1; }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.ts'),
      `import { deepHelper } from './util';\n` +
      `export function midCaller() { return deepHelper(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.test.ts'),
      `import { midCaller } from './mid';\n` +
      `export function checkMid() { return midCaller(); }\n`,
    );
    // `untestedHelper` has a caller but no test anywhere up its caller chain.
    fs.writeFileSync(
      path.join(src, 'untested.ts'),
      `export function untestedHelper() { return 3; }\n` +
      `export function untestedCaller() { return untestedHelper(); }\n`,
    );

    fs.writeFileSync(path.join(src, 'cli.rs'), `
pub fn parse_args_from() {}
pub fn untested_rust() {}
#[cfg(test)]
mod tests {
    use super::*;
    fn parse() { parse_args_from(); }
    #[/* built-in */ test /* marker */]
    #[ignore]
    // Comments between attributes and the item do not detach them.
    fn parse_exec() { parse(); }
    fn test_named_helper() { untested_rust(); }
    #[cfg(test)]
    fn cfg_only_helper() { untested_rust(); }
}
`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts', '**/*.rs'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists dependents (locations only) and covering tests for an entry symbol', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'target' });
    const text = res.content[0].text;

    expect(text).toContain('**Blast radius');
    expect(text).toContain('`target`');
    expect(text).toMatch(/caller/); // a caller count is reported
    // It names WHERE (the caller file) — not the caller's source body.
    expect(text).toContain('feature.ts');
    // The direct covering test file is surfaced.
    expect(text).toMatch(/tests:.*feature\.test\.ts/);
  });

  it('surfaces tests that cover a symbol transitively through its callers (#1475)', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'deepHelper' });
    const text = res.content[0].text;

    // deepHelper's only direct caller is production code, but mid.test.ts sits
    // one more hop up — that must NOT read as "no tests".
    expect(text).toMatch(/`deepHelper`[^\n]*tested via callers:[^\n]*mid\.test\.ts/);
    const line = text.split('\n').find((l: string) => l.startsWith('- `deepHelper`'));
    expect(line).not.toMatch(/no tests found|no covering tests/);
  });

  it('states only what was measured when no test exists up the caller chain', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'untestedHelper' });
    const text = res.content[0].text;

    // Bounded claim, no warning glyph — the tool verified nothing beyond 3 hops.
    expect(text).toMatch(/`untestedHelper`[^\n]*no tests found within 3 caller hops/);
    expect(text).not.toContain('⚠️ no covering tests found');
  });

  it('omits symbols that have no dependents from the blast radius', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'lonelyLeaf' });
    const text = res.content[0].text;
    // lonelyLeaf has zero callers — it must never appear under a blast-radius bullet.
    expect(text).not.toMatch(/Blast radius[\s\S]*`lonelyLeaf`/);
  });

  it.each([
    ['parse', 1, 'tests:'],
    ['parse_args_from', 2, 'tested via callers:'],
  ])('finds inline Rust tests reaching %s in MCP and the viewer', async (name, hops, label) => {
    const res = await handler.execute('codegraph_explore', { query: name });
    const line = res.content[0].text.split('\n').find((l: string) => l.startsWith(`- \`${name}\``));
    expect(line).toContain(`${label} \`src/cli.rs\``);
    const node = cg.searchNodes(name).find((n) => n.node.name === name)!.node;
    const view = await buildNode(cg, testDir, node.id) as { tests: unknown };
    expect(view.tests).toMatchObject({ reached: true, hops, files: ['src/cli.rs'] });
    const test = cg.searchNodes('parse_exec').find((n) => n.node.name === 'parse_exec')!.node;
    expect(toNodeRef(test).test).toBe(true);
    expect(toNodeRef(node).test).toBe(false);
  });

  it('does not treat every caller in a Rust file with inline tests as a test', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'untested_rust' });
    expect(res.content[0].text).toMatch(/`untested_rust`[^\n]*no tests found within 3 caller hops/);
    const node = cg.searchNodes('untested_rust').find((n) => n.node.name === 'untested_rust')!.node;
    const view = await buildNode(cg, testDir, node.id) as { tests: unknown };
    expect(view.tests).toMatchObject({ reached: false, files: [] });
  });
});

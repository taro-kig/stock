import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isMap, parseDocument } from "yaml";
import { parseWorkflow, type WorkflowSpec } from "./spec.ts";

/**
 * Sets one node parameter in a workflow YAML file, keeping every comment and the layout of the
 * rest of the file. The result must still parse as a workflow; the previous file stays as .bak
 * and the new one is written atomically.
 */
export function setWorkflowParam(file: string, nodeId: string, key: string, value: unknown): { spec: WorkflowSpec; previous: unknown } {
  const text = readFileSync(file, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`cannot parse ${file}: ${doc.errors[0]!.message}`);
  const node = doc.getIn(["nodes", nodeId], true);
  if (!isMap(node)) throw new Error(`no node "${nodeId}" in ${file}`);
  const previous = (doc.getIn(["nodes", nodeId, "params", key]) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? doc.getIn(["nodes", nodeId, "params", key]);
  const v = doc.createNode(value);
  if (isMap(v)) v.flow = true;
  doc.setIn(["nodes", nodeId, "params", key], v);
  const params = doc.getIn(["nodes", nodeId, "params"], true);
  if (isMap(params) && node.flow) params.flow = true;
  const out = doc.toString({ lineWidth: 0 });
  const spec = parseWorkflow(out); // throws on an invalid result: nothing is written
  copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, file);
  return { spec, previous: previous ?? null };
}

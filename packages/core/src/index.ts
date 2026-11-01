/** Public API of @stockai/core (used by the CLI today and by the web UI later). */
export { AppConfig, loadConfig } from "./config.ts";
export { Services } from "./services.ts";
export { builtinRegistry } from "./nodes/index.ts";
export { Engine, type RunResult } from "./workflow/engine.ts";
export { NodeRegistry, defineNode, type NodeDescription } from "./workflow/registry.ts";
export { RunStore, type NodeRunRow, type RunEvent, type RunRow } from "./workflow/runStore.ts";
export { loadWorkflow, parseWorkflow, toGraph, validateWorkflow, WorkflowError, WorkflowSpec, type WorkflowGraph } from "./workflow/spec.ts";
export { PORT_TYPES, type PortTypes, type PortType } from "./workflow/ports.ts";

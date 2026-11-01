import { z } from "zod";
import { WaitingForInput } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

export const approvalGate = defineNode({
  type: "gate.approval",
  title: "Approval gate",
  category: "gate",
  description:
    "Human-in-the-loop. manual: the run pauses until someone approves or rejects (timeout => onTimeout). auto: passes through — switching modes is how authority is handed to the AI step by step.",
  version: 1,
  cache: "none",
  params: z.object({
    mode: z.enum(["manual", "auto"]).default("manual"),
    timeoutHours: z.number().positive().default(12),
    onTimeout: z.enum(["reject", "approve"]).default("reject"),
  }),
  inputs: { proposals: { type: "Proposals" } },
  outputs: { proposals: { type: "Proposals" } },
  async run(ctx, p, i) {
    if (p.mode === "auto" || i.proposals.length === 0) return { proposals: i.proposals };
    const a = ctx.approval();
    if (a) return { proposals: a.decision === "approve" ? i.proposals : [] };
    if (Date.now() - ctx.runCreatedAt.getTime() > p.timeoutHours * 3_600_000) {
      ctx.log(`approval timed out -> ${p.onTimeout}`);
      return { proposals: p.onTimeout === "approve" ? i.proposals : [] };
    }
    throw new WaitingForInput(`${i.proposals.length} order(s) awaiting approval`, i.proposals);
  },
});

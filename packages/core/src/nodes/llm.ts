import { z } from "zod";
import { BudgetExceeded } from "../harness/budget.ts";
import { EventExtractor } from "../signals/extractor.ts";
import { docHash, type EventRecord } from "../signals/models.ts";
import { EVENT_PROMPT_VERSION } from "../signals/prompts.ts";
import { defineNode } from "../workflow/registry.ts";

export const extractEvents = defineNode({
  type: "llm.extractEvents",
  title: "Extract events (ensemble)",
  category: "llm",
  description:
    "Turns each document into a structured event with the harness: schema validation, grounded quotes, cross-vendor voting, escalation, cache and budget cap.",
  version: 1,
  cache: "inputs",
  params: z.object({ quorum: z.number().int().min(1).optional() }),
  inputs: { matches: { type: "Matches" } },
  outputs: { events: { type: "Events" } },
  fallback: () => ({ events: [] }),
  async run(ctx, p, i) {
    const s = ctx.services;
    const extractor = new EventExtractor(s.caller, s.tier1(), { quorum: p.quorum ?? s.config.harness.quorum, escalation: s.tier2() });
    const events: EventRecord[] = [];
    for (const { doc, candidates } of i.matches) {
      s.docStore.saveDocument(doc);
      let res = s.docStore.getExtraction(doc, EVENT_PROMPT_VERSION);
      if (res) ctx.metric("alreadyExtracted", 1);
      else {
        try {
          const r = await extractor.extract({ doc, candidates, priority: new Set() });
          s.docStore.saveExtraction(doc, EVENT_PROMPT_VERSION, r);
          ctx.metric(`status_${r.status}`, 1);
          ctx.metric("rejectedVotes", r.votes.filter((v) => v.rejected).length);
          res = { status: r.status, agreement: r.agreement, value: r.value };
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) throw e;
          ctx.log(`${e.message} -> stopping (fail-safe: remaining documents produce no signal)`);
          ctx.metric("budgetStopped", 1);
          break;
        }
      }
      if (res.value?.relevant && (res.status === "consensus" || res.status === "escalated")) {
        events.push({
          docHash: docHash(doc), title: doc.title, url: doc.url, source: doc.source, learnedAt: doc.fetchedAt,
          agreement: res.agreement, sourceWeight: doc.sourceWeight, nSources: 1 + doc.alsoSeenIn.length, event: res.value,
        });
      }
    }
    ctx.metric("events", events.length);
    return { events };
  },
});

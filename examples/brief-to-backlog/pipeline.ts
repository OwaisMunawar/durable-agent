import { Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { awaitApproval, definePipeline, stage } from '../../src/index.js';
import { demoModel } from './demo-model.js';

// brief -> requirements -> user stories -> (human approval) -> estimated backlog
//
// Every stage is one model call. If the process dies after "draft", a new
// worker picks up at the approval gate; nothing already paid for is re-run.

const requirementsSchema = z.object({
  requirements: z.array(z.object({ id: z.string(), text: z.string() })),
});

const storiesSchema = z.object({
  stories: z.array(z.object({ id: z.string(), requirement: z.string(), story: z.string() })),
});

const planSchema = z.object({
  estimates: z.record(z.string(), z.number()),
  priority: z.array(z.string()),
});

export type Stories = z.infer<typeof storiesSchema>;

export interface BacklogItem {
  rank: number;
  id: string;
  story: string;
  points: number;
}

/** A real model through the AI SDK gateway when a key is set, otherwise the offline demo model. */
export function resolveModel(): LanguageModel {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.MODEL ?? 'openai/gpt-5-mini';
  return demoModel(Number(process.env.DEMO_LATENCY_MS ?? 400));
}

const model = resolveModel();

export const briefToBacklog = definePipeline<{ brief: string }>({
  name: 'brief-to-backlog',
  // Illustrative prices; set these to your provider's rates.
  pricing: { inputPerMTok: 0.25, outputPerMTok: 2 },
  stages: [
    stage('extract', async (ctx) => {
      const { output } = await ctx.generateText({
        model,
        system: '[extract] List the distinct product requirements in this brief. One sentence each.',
        prompt: ctx.input.brief,
        output: Output.object({ schema: requirementsSchema }),
      });
      return output;
    }),

    stage(
      'draft',
      async (ctx) => {
        const { requirements } = ctx.outputs.extract as z.infer<typeof requirementsSchema>;
        const { output } = await ctx.generateText({
          model,
          system: '[stories] Write one or more user stories per requirement, "As a <role> I can ...".',
          prompt: JSON.stringify(requirements),
          output: Output.object({ schema: storiesSchema }),
        });
        // A product owner signs off on the stories before anything is estimated.
        return awaitApproval(output);
      },
      { retries: 1 },
    ),

    stage('finalize', async (ctx) => {
      const { stories } = ctx.outputs.draft as Stories;
      const { output } = await ctx.generateText({
        model,
        system: '[finalize] Estimate each story in points (1,2,3,5,8) and order them by priority.',
        prompt: JSON.stringify(stories),
        output: Output.object({ schema: planSchema }),
      });
      const byId = new Map(stories.map((s) => [s.id, s]));
      return output.priority.flatMap((id, i): BacklogItem[] => {
        const s = byId.get(id);
        return s ? [{ rank: i + 1, id, story: s.story, points: output.estimates[id] ?? 0 }] : [];
      });
    }),
  ],
});

export default [briefToBacklog];

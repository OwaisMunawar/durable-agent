import { definePipeline, stage } from '../../src/index.js';

export const slowPipeline = definePipeline({
  name: 'slow-steps',
  stages: ['a', 'b', 'c'].map((name) =>
    stage(name, async (ctx) => {
      ctx.reportUsage({ costUsd: 0.25, inputTokens: 1000, outputTokens: 100 });
      await new Promise((r) => setTimeout(r, 300));
      return `${name}:${ctx.workerId}`;
    }),
  ),
});

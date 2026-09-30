import { MockLanguageModelV4 } from 'ai/test';

// Deterministic stand-in for a real model so the example runs offline and
// without an API key. It recognises which stage is calling from the system
// prompt, waits a little like a real API would, and reports token usage
// estimated from prompt and reply length so cost metering has real numbers.

const REPLIES: Record<string, unknown> = {
  extract: {
    requirements: [
      { id: 'R1', text: 'Patients book, reschedule and cancel appointments on mobile' },
      { id: 'R2', text: 'Reception sees a daily schedule and can block out time' },
      { id: 'R3', text: 'SMS reminder 24 hours before each appointment' },
      { id: 'R4', text: 'Phone-number login for patients' },
      { id: 'R5', text: 'Monthly no-show report for the clinic' },
    ],
  },
  stories: {
    stories: [
      { id: 'S1', requirement: 'R4', story: 'As a patient I can sign in with my phone number and a one-time code' },
      { id: 'S2', requirement: 'R1', story: 'As a patient I can book an open slot from my phone' },
      { id: 'S3', requirement: 'R1', story: 'As a patient I can move or cancel an upcoming appointment' },
      { id: 'S4', requirement: 'R2', story: 'As a receptionist I can see today’s schedule at a glance' },
      { id: 'S5', requirement: 'R2', story: 'As a receptionist I can block out time so it cannot be booked' },
      { id: 'S6', requirement: 'R3', story: 'As a patient I get an SMS reminder a day before my appointment' },
      { id: 'S7', requirement: 'R5', story: 'As a clinic manager I can download last month’s no-shows' },
    ],
  },
  finalize: {
    estimates: { S1: 3, S2: 5, S3: 3, S4: 3, S5: 2, S6: 3, S7: 2 },
    priority: ['S1', 'S2', 'S4', 'S3', 'S6', 'S5', 'S7'],
  },
};

const approxTokens = (s: string) => Math.ceil(s.length / 4);

export function demoModel(latencyMs = 400): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'demo',
    modelId: 'demo-model',
    doGenerate: async ({ prompt, abortSignal }) => {
      const system = prompt.find((m) => m.role === 'system');
      const task = system && typeof system.content === 'string' ? /\[(\w+)\]/.exec(system.content)?.[1] : undefined;
      const reply = JSON.stringify(REPLIES[task ?? ''] ?? {});
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, latencyMs);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: approxTokens(JSON.stringify(prompt)),
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: approxTokens(reply), text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

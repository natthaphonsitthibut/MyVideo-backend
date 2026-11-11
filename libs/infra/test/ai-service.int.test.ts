import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { AiServiceClient } from '../src/ai/ai-service.client.js';

let ai: Awaited<ReturnType<typeof startAiService>>;
beforeAll(async () => {
  ai = await startAiService(18_765);
}, 60_000);
afterAll(() => ai?.stop());

describe('AI service (real Python process)', () => {
  it('answers /health through the typed client', async () => {
    const h = await new AiServiceClient({ baseUrl: ai.url }).health();
    expect(h).toMatchObject({ status: 'ok', service: 'myvideo-ai' });
    expect(h.python).toMatch(/^3\.12\./);
  });
});

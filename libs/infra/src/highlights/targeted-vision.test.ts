import { expect, it } from 'vitest';
import { openRouterBody } from '../llm/api-openrouter.js';
import { llmCacheKey } from '../llm/structured-llm.js';
import { planVisionWindows } from './targeted-vision.js';

it('bounds image work to top moments, ≤5% of the 2-fps video budget including 10- and 30-minute inputs', () => {
  for (const durationMs of [600000, 1800000]) {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      startMs: i * 30000,
      endMs: i * 30000 + 20000,
      score: i,
    }));
    const windows = planVisionWindows(candidates, durationMs);
    expect(windows.map((w) => w.id)).toEqual(['c11', 'c10', 'c9']);
    expect(windows.flatMap((w) => w.timesMs).length).toBeLessThanOrEqual((durationMs / 1000) * 2 * 0.05);
    expect(windows.flatMap((w) => w.timesMs).every((t) => t >= 0 && t < durationMs)).toBe(true);
  }
});
it('includes image content in the cache and sends image bytes to the documented multimodal endpoint shape', () => {
  const schema = {
    name: 'tags',
    jsonSchema: { type: 'object' },
    parse: () => ({ ok: true as const, value: {} }),
  };
  const req = {
    schema,
    prompt: 'inspect',
    promptVersion: 'v1',
    images: [{ mediaType: 'image/jpeg' as const, data: 'YQ==' }],
  };
  expect(llmCacheKey('api', 'model', req)).not.toBe(
    llmCacheKey('api', 'model', { ...req, images: [{ ...req.images[0]!, data: 'Yg==' }] }),
  );
  const body = openRouterBody({
    ...req,
    jsonSchema: schema.jsonSchema,
    model: 'model',
    maxOutputTokens: 100,
  });
  expect(body.input).toEqual([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'inspect' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,YQ==', detail: 'auto' },
      ],
    },
  ]);
  expect(body.max_output_tokens).toBe(100);
});

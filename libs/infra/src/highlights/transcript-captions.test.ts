import type { LlmPort } from '@myvideo/domain';
import { expect, it } from 'vitest';
import { clipCaptionWords } from './caption-fix.js';

it('does not call the model again after a transcript pass and retains undo metadata', async () => {
  let calls = 0;
  const llm: LlmPort = {
    mode: 'local-agent',
    generateStructured: async () => {
      calls++;
      throw new Error('unexpected');
    },
  };
  const words = [{ text: 'พิมพ์', startMs: 0, endMs: 100, origin: 'ai' as const, asrText: 'พิม' }];
  expect(await clipCaptionWords(llm, [{ id: '0', words }], [], { merchantId: 'm' }, true)).toEqual(words);
  expect(calls).toBe(0);
  await clipCaptionWords(llm, [{ id: '0', words }], [], { merchantId: 'm' }, false);
  expect(calls).toBe(1);
});

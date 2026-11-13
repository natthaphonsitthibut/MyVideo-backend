import { stylePack, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { addPhotoCutaways, buildVisualMontage } from './photo-project.js';

const photos = [0, 1, 2, 3].map((i) => ({
  sourceId: `00000000-0000-4000-8000-00000000000${i}`,
  kind: 'image' as const,
  width: i % 2 ? 1920 : 1080,
  height: i % 2 ? 1080 : 1920,
  durationFrames: 150,
}));
const base = {
  projectId: '00000000-0000-4000-8000-000000000010',
  merchantId: '00000000-0000-4000-8000-000000000011',
  seed: 'photos',
  ratio: '9:16' as const,
};
describe('selected photos as editable footage (project JSON only)', () => {
  it('selected photo styles change hold duration and drift rather than creating identical copies', () => {
    const calm = buildVisualMontage({ ...base, sources: photos, style: stylePack('premium') });
    const fast = buildVisualMontage({ ...base, sources: photos, style: stylePack('sale-fast') });
    expect(calm.durationFrames).toBeGreaterThan(fast.durationFrames);
    expect(Object.values(calm.elements)[0]?.keyframes).not.toEqual(
      Object.values(fast.elements)[0]?.keyframes,
    );
    expect(fast.meta.styleId).toBe('sale-fast');
  });
  it('builds a deterministic montage with four photos and a silent video without stretching', () => {
    const input = {
      ...base,
      sources: [
        ...photos,
        {
          sourceId: '00000000-0000-4000-8000-000000000012',
          kind: 'video' as const,
          width: 1920,
          height: 1080,
          durationFrames: 300,
        },
      ],
      seconds: 30,
    };
    const doc = buildVisualMontage(input);
    expect(validateProject(doc).ok).toBe(true);
    expect(Object.values(doc.elements).filter((e) => e.type === 'image')).toHaveLength(4);
    expect(Object.values(doc.elements).filter((e) => e.type === 'video')).toHaveLength(1);
    expect(
      Object.values(doc.elements)
        .filter((e) => e.type === 'image')
        .every((e) => e.fit === 'contain' && e.presentation === 'showcase'),
    ).toBe(true);
    expect(doc.durationFrames).toBe(900);
    expect(buildVisualMontage(input)).toEqual(doc);
  });
  it('photo cutaways preserve the underlying video/audio and consume at most one quarter of the clip', () => {
    const doc = buildVisualMontage({
      ...base,
      sources: [{ ...photos[0]!, kind: 'video', durationFrames: 900 }],
      seconds: 30,
    });
    const output = addPhotoCutaways(doc, photos, 'photos');
    const images = Object.values(output.elements).filter((e) => e.type === 'image');
    expect(images.reduce((n, e) => n + e.durationFrames, 0)).toBeLessThanOrEqual(225);
    expect(output.durationFrames).toBe(doc.durationFrames);
    for (const [id, el] of Object.entries(doc.elements)) expect(output.elements[id]).toEqual(el);
    expect(validateProject(output).ok).toBe(true);
    expect(Object.values(output.assets).filter((a) => a.kind === 'image')).toHaveLength(images.length);
  });
});

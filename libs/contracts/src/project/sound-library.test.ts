import { describe, expect, it } from 'vitest';
import { librarySound, SOUND_LIBRARY } from './sound-library.js';
import { STYLE_PACKS } from './style-packs.js';

describe('sound library', () => {
  it('has unique ids, a sync point inside each sound and a checksum', () => {
    expect(new Set(SOUND_LIBRARY.map((s) => s.id)).size).toBe(SOUND_LIBRARY.length);
    for (const s of SOUND_LIBRARY) {
      expect(s.syncAtSec).toBeGreaterThanOrEqual(0);
      expect(s.syncAtSec).toBeLessThan(s.durationSec);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.underVoiceoverDb).toBeLessThanOrEqual(0);
    }
  });

  it('every sound a style pack names is in the library', () => {
    for (const pack of STYLE_PACKS) {
      if (!pack.sfx) continue;
      const { cut, price, cta, hook, endCard } = pack.sfx;
      for (const id of [...cut, price, cta, hook, endCard].filter((x): x is string => x !== null))
        expect(librarySound(id), `${pack.id}: ${id}`).toBeDefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { type FolderFacts, type FolderSourceFacts, folderPlan } from './folder-plan.js';

const video = (over: Partial<FolderSourceFacts> = {}): FolderSourceFacts => ({
  id: 'v',
  ingest: 'ready',
  kind: 'video',
  hasAudio: true,
  transcript: 'none',
  analysis: 'none',
  build: 'none',
  ...over,
});
const facts = (sources: FolderSourceFacts[], over: Partial<FolderFacts> = {}): FolderFacts => ({
  started: true,
  styleId: null,
  sources,
  ...over,
});
const states = (f: FolderFacts) => folderPlan(f).steps.map((s) => `${s.id}:${s.state}`);

describe('folderPlan (ordered steps of a project edit, from real run states)', () => {
  it('lists the steps in order; before start only the footage step reflects real upload state', () => {
    const p = folderPlan(facts([video({ ingest: 'processing' })], { started: false }));
    expect(p.steps.map((s) => s.id)).toEqual(['prepare', 'transcribe', 'analyse', 'style', 'edit']);
    expect(p.steps.map((s) => s.state)).toEqual(['running', 'pending', 'pending', 'pending', 'pending']);
    expect(p).toMatchObject({ done: 0, total: 5, finished: false, needs: null });
    expect(states(facts([video()], { started: false }))[0]).toBe('prepare:done');
  });

  it('shows the running step and counts footage in its Thai detail', () => {
    const p = folderPlan(
      facts([video({ id: 'a', transcript: 'running' }), video({ id: 'b', transcript: 'ready' })]),
    );
    expect(states(facts([video({ transcript: 'running' })]))).toEqual([
      'prepare:done',
      'transcribe:running',
      'analyse:pending',
      'style:pending',
      'edit:pending',
    ]);
    expect(p.steps[0]?.detail).toBe('2 ไฟล์');
    expect(p.steps[1]?.detail).toBe('เสร็จ 1/2 วิดีโอ');
    expect(p.done).toBe(1);
  });

  it('waits for the merchant at the style step, then edits with the chosen style', () => {
    const analysed = facts([video({ transcript: 'ready', analysis: 'succeeded' })]);
    const waiting = folderPlan(analysed);
    expect(waiting.steps[3]).toMatchObject({ id: 'style', state: 'waiting' });
    expect(waiting.needs).toBe('style');
    const editing = folderPlan({
      ...analysed,
      styleId: 'sale-fast',
      sources: [video({ transcript: 'ready', analysis: 'succeeded', build: 'running' })],
    });
    expect(editing.steps[3]).toMatchObject({ state: 'done', detail: 'sale-fast' });
    expect(editing.steps[4]?.state).toBe('running');
    expect(editing.needs).toBeNull();
  });

  it('finishes when every edit is done', () => {
    const p = folderPlan(
      facts([video({ transcript: 'ready', analysis: 'succeeded', build: 'succeeded' })], { styleId: 's' }),
    );
    expect(p).toMatchObject({ done: 5, total: 5, finished: true });
  });

  it('a failure stops the line with a plain Thai reason (no step after it runs)', () => {
    const p = folderPlan(facts([video({ transcript: 'failed' })]));
    expect(p.steps[1]).toMatchObject({ state: 'failed', error: 'ถอดเสียงไม่สำเร็จ 1 วิดีโอ' });
    expect(p.steps.slice(2).every((s) => s.state === 'pending')).toBe(true);
    expect(p.failed).toBe(true);
  });

  it('photos and silent videos are prepared but skip transcription; no speech at all skips the speech steps', () => {
    const photosOnly = facts([
      video({ id: 'p', kind: 'photo', hasAudio: false }),
      video({ id: 's', hasAudio: false }),
    ]);
    expect(states(photosOnly)).toEqual([
      'prepare:done',
      'transcribe:skipped',
      'analyse:skipped',
      'style:waiting',
      'edit:pending',
    ]);
    const mixed = folderPlan(
      facts([video({ id: 'p', kind: 'photo', hasAudio: false }), video({ transcript: 'running' })]),
    );
    expect(mixed.steps[1]?.detail).toBe('เสร็จ 0/1 วิดีโอ');
  });

  it('does not start on footage that is still uploading/processing', () => {
    expect(states(facts([video({ ingest: 'processing' })]))[0]).toBe('prepare:running');
    expect(folderPlan(facts([])).steps[0]).toMatchObject({ state: 'pending', detail: 'ยังไม่มีฟุตเทจ' });
  });
});

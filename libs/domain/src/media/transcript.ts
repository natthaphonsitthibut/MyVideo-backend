/** Transcript lifecycle: `running` while chunks are transcribed, `ready` once merged, `failed` if a step died. */
export const TRANSCRIPT_STATUSES = ['running', 'ready', 'failed'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const TRANSCRIPT_CHUNK_STATUSES = ['pending', 'done'] as const;
export type TranscriptChunkStatus = (typeof TRANSCRIPT_CHUNK_STATUSES)[number];

/**
 * Version of the transcribe recipe (chunk plan + merge + word layout). Part of the cache key with the audio
 * sha256 and the ASR model: bump it when the output for the same audio would change.
 */
// 2: whisper.cpp built-in VAD off (D-017)
export const TRANSCRIPT_RECIPE = 2;

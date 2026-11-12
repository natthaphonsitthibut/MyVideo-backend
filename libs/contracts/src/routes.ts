import { getMe, login, logout } from './http/auth.js';
import { getHealth } from './http/health.js';
import { cancelJob, retryJob } from './http/jobs.js';
import {
  createProject,
  getProject,
  listProjectVersions,
  restoreProjectVersion,
  saveProject,
} from './http/projects.js';
import { getRender, getRenderFile, listProjectRenders, listRenders, requestRender } from './http/renders.js';
import { createTestRun, getRun, listRuns, runEvents } from './http/runs.js';
import {
  getSource,
  getSourceAsset,
  getSourceByUpload,
  getSpriteSheet,
  getUploadConfig,
  listSources,
} from './http/sources.js';
import {
  editTranscriptWord,
  getTranscript,
  listTranscriptSegments,
  revertTranscriptWord,
  startTranscript,
} from './http/transcripts.js';
import type { RouteContract } from './route.js';

/** Every HTTP route the API serves. The API test suite fails if a controller route is missing here. */
export const routes: RouteContract[] = [
  getHealth,
  login,
  logout,
  getMe,
  retryJob,
  cancelJob,
  listRuns,
  getRun,
  runEvents,
  createTestRun,
  getSourceByUpload,
  getSource,
  getSourceAsset,
  getSpriteSheet,
  getUploadConfig,
  listSources,
  getTranscript,
  startTranscript,
  listTranscriptSegments,
  editTranscriptWord,
  revertTranscriptWord,
  createProject,
  getProject,
  saveProject,
  listProjectVersions,
  restoreProjectVersion,
  requestRender,
  listProjectRenders,
  listRenders,
  getRender,
  getRenderFile,
];

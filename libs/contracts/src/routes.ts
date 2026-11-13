import { getMe, login, logout } from './http/auth.js';
import { getBrandKit, getBrandLogo, saveBrandKit, uploadBrandLogo } from './http/brand-kit.js';
import {
  buildClips,
  discardClip,
  generateClips,
  getClips,
  listStylePacks,
  restyleProject,
} from './http/clips.js';
import { folderRoutes } from './http/folders.js';
import { getHealth } from './http/health.js';
import { cancelJob, retryJob } from './http/jobs.js';
import { getLibrarySound } from './http/library.js';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectVersion,
  listProjects,
  listProjectVersions,
  restoreProjectVersion,
  saveProject,
} from './http/projects.js';
import { getRender, getRenderFile, listProjectRenders, listRenders, requestRender } from './http/renders.js';
import { createReviewVideo, getReviewVideo, listTemplates, swapTemplate } from './http/review-videos.js';
import { createTestRun, getRun, listRuns, runEvents } from './http/runs.js';
import {
  deleteSource,
  getSource,
  getSourceAsset,
  getSourceByUpload,
  getSourceDependents,
  getSpriteSheet,
  getUploadConfig,
  listSources,
} from './http/sources.js';
import { listTimings } from './http/timings.js';
import {
  editTranscriptWord,
  getTranscript,
  listTranscriptSegments,
  revertTranscriptWord,
  reviewTranscriptWord,
  selectedClipsRoutes,
  startTranscript,
} from './http/transcripts.js';
import type { RouteContract } from './route.js';

/** Every HTTP route the API serves. The API test suite fails if a controller route is missing here. */
export const routes: RouteContract[] = [
  ...folderRoutes,
  getHealth,
  getBrandKit,
  saveBrandKit,
  uploadBrandLogo,
  getBrandLogo,
  login,
  logout,
  getMe,
  retryJob,
  cancelJob,
  listRuns,
  getRun,
  runEvents,
  createTestRun,
  listTimings,
  getSourceByUpload,
  getSource,
  getSourceDependents,
  deleteSource,
  getSourceAsset,
  getSpriteSheet,
  getUploadConfig,
  listSources,
  getTranscript,
  startTranscript,
  ...selectedClipsRoutes,
  listTranscriptSegments,
  editTranscriptWord,
  revertTranscriptWord,
  reviewTranscriptWord,
  createProject,
  deleteProject,
  listProjects,
  getProject,
  saveProject,
  listProjectVersions,
  restoreProjectVersion,
  getProjectVersion,
  requestRender,
  listProjectRenders,
  listRenders,
  getRender,
  getRenderFile,
  getClips,
  generateClips,
  buildClips,
  discardClip,
  listStylePacks,
  restyleProject,
  getLibrarySound,
  listTemplates,
  createReviewVideo,
  getReviewVideo,
  swapTemplate,
];

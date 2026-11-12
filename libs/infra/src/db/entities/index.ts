import { JobEntity } from './job.entity.js';
import { JobAttemptEntity } from './job-attempt.entity.js';
import { JobEventEntity } from './job-event.entity.js';
import { MediaAssetEntity } from './media-asset.entity.js';
import { MerchantEntity } from './merchant.entity.js';
import { ProjectEntity, ProjectVersionEntity } from './project.entity.js';
import { SessionEntity } from './session.entity.js';
import {
  TranscriptChunkEntity,
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from './transcript.entity.js';
import { UserEntity } from './user.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';
import { WorkflowRunEntity } from './workflow-run.entity.js';

export { ATTEMPT_STATUSES, type AttemptStatus } from './job-attempt.entity.js';
export {
  JobAttemptEntity,
  JobEntity,
  JobEventEntity,
  MediaAssetEntity,
  MerchantEntity,
  ProjectEntity,
  ProjectVersionEntity,
  SessionEntity,
  TranscriptChunkEntity,
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
  UserEntity,
  VideoSourceEntity,
  WorkflowRunEntity,
};
/** Every entity, listed explicitly (no globs: ESM + bundling safe). */
export const entities = [
  MerchantEntity,
  UserEntity,
  SessionEntity,
  WorkflowRunEntity,
  JobEntity,
  JobAttemptEntity,
  JobEventEntity,
  VideoSourceEntity,
  MediaAssetEntity,
  TranscriptEntity,
  TranscriptChunkEntity,
  TranscriptSegmentEntity,
  TranscriptEditEntity,
  ProjectEntity,
  ProjectVersionEntity,
];

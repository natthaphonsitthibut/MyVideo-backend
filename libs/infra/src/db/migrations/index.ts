import { Baseline1794412150604 } from './1794412150604-Baseline.js';
import { Sessions1794412817379 } from './1794412817379-Sessions.js';
import { JobsBackbone1794437290673 } from './1794437290673-JobsBackbone.js';
import { JobQueuedAt1794437366586 } from './1794437366586-JobQueuedAt.js';
import { JobEvents1794437958981 } from './1794437958981-JobEvents.js';
import { MediaSources1794439961977 } from './1794439961977-MediaSources.js';
import { Transcripts1794448632344 } from './1794448632344-Transcripts.js';
import { TranscriptEdits1794452328318 } from './1794452328318-TranscriptEdits.js';
import { Projects1794455702974 } from './1794455702974-Projects.js';
import { Renders1794460818268 } from './1794460818268-Renders.js';
import { LlmCalls1794465998262 } from './1794465998262-LlmCalls.js';
import { ShotAnalyses1794467847630 } from './1794467847630-ShotAnalyses.js';
import { ClipSuggestions1794468684239 } from './1794468684239-ClipSuggestions.js';
import { ClipRestyle1794480000000 } from './1794480000000-ClipRestyle.js';
import { BuildClipsRun1794490000000 } from './1794490000000-BuildClipsRun.js';
import { TranscriptAiEdits1794491000000 } from './1794491000000-TranscriptAiEdits.js';
import { TranscriptContext1794492000000 } from './1794492000000-TranscriptContext.js';
import { TranscriptEditReview1794493000000 } from './1794493000000-TranscriptEditReview.js';
import { BrandKits1794494000000 } from './1794494000000-BrandKits.js';
import { TemplateVersionReason1794495000000 } from './1794495000000-TemplateVersionReason.js';
import { PurgeRun1794496000000 } from './1794496000000-PurgeRun.js';
import { ProjectFolders1794497000000 } from './1794497000000-ProjectFolders.js';
import { FolderSettings1794498000000 } from './1794498000000-FolderSettings.js';
import { FolderEditRun1794499000000 } from './1794499000000-FolderEditRun.js';

/** Every migration in order. A new migration file must be added here (no globs). */
// biome-ignore lint/complexity/noBannedTypes: TypeORM takes migration classes
export const migrations: Function[] = [
  Baseline1794412150604,
  Sessions1794412817379,
  JobsBackbone1794437290673,
  JobQueuedAt1794437366586,
  JobEvents1794437958981,
  MediaSources1794439961977,
  Transcripts1794448632344,
  TranscriptEdits1794452328318,
  Projects1794455702974,
  Renders1794460818268,
  LlmCalls1794465998262,
  ShotAnalyses1794467847630,
  ClipSuggestions1794468684239,
  ClipRestyle1794480000000,
  BuildClipsRun1794490000000,
  TranscriptAiEdits1794491000000,
  TranscriptContext1794492000000,
  TranscriptEditReview1794493000000,
  BrandKits1794494000000,
  TemplateVersionReason1794495000000,
  PurgeRun1794496000000,
  ProjectFolders1794497000000,
  FolderSettings1794498000000,
  FolderEditRun1794499000000,
];

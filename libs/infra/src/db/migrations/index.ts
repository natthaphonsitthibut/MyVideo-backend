import { Baseline1794412150604 } from './1794412150604-Baseline.js';
import { Sessions1794412817379 } from './1794412817379-Sessions.js';
import { JobsBackbone1794437290673 } from './1794437290673-JobsBackbone.js';
import { JobQueuedAt1794437366586 } from './1794437366586-JobQueuedAt.js';
import { JobEvents1794437958981 } from './1794437958981-JobEvents.js';
import { MediaSources1794439961977 } from './1794439961977-MediaSources.js';

/** Every migration in order. A new migration file must be added here (no globs). */
// biome-ignore lint/complexity/noBannedTypes: TypeORM takes migration classes
export const migrations: Function[] = [
  Baseline1794412150604,
  Sessions1794412817379,
  JobsBackbone1794437290673,
  JobQueuedAt1794437366586,
  JobEvents1794437958981,
  MediaSources1794439961977,
];

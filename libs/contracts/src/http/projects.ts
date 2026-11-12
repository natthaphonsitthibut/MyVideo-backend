import { z } from 'zod';
import { Project } from '../project/schema.js';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const ProjectIdParams = z.object({ id: z.uuid() });

/** A project document as sent by the client: the server owns `id` and `merchantId`. */
export const ProjectDraft = named(
  'ProjectDraft',
  Project.omit({ id: true, merchantId: true }),
  'Project JSON without the server-owned id and merchantId',
);
export type ProjectDraft = z.infer<typeof ProjectDraft>;

export const ProjectRecord = named(
  'ProjectRecord',
  z.object({
    id: z.uuid(),
    title: z.string(),
    /** Current version number (1-based). Send it back as `baseVersion` when saving. */
    version: z.number().int().min(1),
    doc: Project,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
);
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const CreateProjectBody = named(
  'CreateProjectBody',
  z.object({ title: z.string().trim().min(1).max(200), doc: ProjectDraft }),
);

export const SaveProjectBody = named(
  'SaveProjectBody',
  z.object({
    /** The version this edit was made on; another save in between → 409. */
    baseVersion: z.number().int().min(1),
    doc: ProjectDraft,
  }),
);

export const ProjectVersionSummary = named(
  'ProjectVersionSummary',
  z.object({
    version: z.number().int().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    /** `user` save, `restore` of an older version, `restyle` (AI clip rebuilt with another style), or creation. */
    reason: z.enum(['create', 'save', 'restore', 'restyle', 'template']),
    restoredFrom: z.number().int().nullable(),
  }),
);
export const ProjectVersionList = named(
  'ProjectVersionList',
  z.object({ items: z.array(ProjectVersionSummary) }),
);

export const RestoreParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });
export const RestoreBody = named('RestoreBody', z.object({ baseVersion: z.number().int().min(1) }));

const invalid = { description: 'Project JSON failed validation (issues listed)', schema: ApiErrorBody };

export const createProject = defineRoute({
  operationId: 'createProject',
  method: 'post',
  path: '/projects',
  summary: 'Create a project (version 1) from a validated Project JSON',
  tags: ['projects'],
  auth: true,
  request: { body: CreateProjectBody },
  responses: { 201: { description: 'Created', schema: ProjectRecord }, 400: invalid },
});

export const getProject = defineRoute({
  operationId: 'getProject',
  method: 'get',
  path: '/projects/{id}',
  summary: 'The current version of a project',
  tags: ['projects'],
  auth: true,
  request: { params: ProjectIdParams },
  responses: {
    200: { description: 'The project', schema: ProjectRecord },
    404: { description: 'No such project for this merchant', schema: ApiErrorBody },
  },
});

export const saveProject = defineRoute({
  operationId: 'saveProject',
  method: 'put',
  path: '/projects/{id}',
  summary: 'Save a new version (optimistic locking: `baseVersion` must be the current version)',
  tags: ['projects'],
  auth: true,
  request: { params: ProjectIdParams, body: SaveProjectBody },
  responses: {
    200: { description: 'Saved as a new version', schema: ProjectRecord },
    400: invalid,
    404: { description: 'No such project for this merchant', schema: ApiErrorBody },
    409: { description: 'Version conflict: someone saved after `baseVersion`', schema: ApiErrorBody },
  },
});

export const listProjectVersions = defineRoute({
  operationId: 'listProjectVersions',
  method: 'get',
  path: '/projects/{id}/versions',
  summary: 'All versions of a project, newest first',
  tags: ['projects'],
  auth: true,
  request: { params: ProjectIdParams },
  responses: {
    200: { description: 'Versions', schema: ProjectVersionList },
    404: { description: 'No such project for this merchant', schema: ApiErrorBody },
  },
});

export const restoreProjectVersion = defineRoute({
  operationId: 'restoreProjectVersion',
  method: 'post',
  path: '/projects/{id}/versions/{version}/restore',
  summary: 'Restore an older version as a NEW version (history is never rewritten)',
  tags: ['projects'],
  auth: true,
  request: { params: RestoreParams, body: RestoreBody },
  responses: {
    200: { description: 'Restored as a new version', schema: ProjectRecord },
    404: { description: 'No such project or version', schema: ApiErrorBody },
    409: { description: 'Version conflict', schema: ApiErrorBody },
  },
});

export const ProjectSummary = named(
  'ProjectSummary',
  z.object({
    id: z.uuid(),
    title: z.string(),
    version: z.number().int().min(1),
    /** Who made version 1: `ai` (generated clip) or `user`. */
    createdBy: z.enum(['ai', 'user']),
    durationFrames: z.number().int(),
    fps: z.object({ num: z.number().int(), den: z.number().int() }),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
);
export const ProjectList = named('ProjectList', z.object({ items: z.array(ProjectSummary) }));

export const listProjects = defineRoute({
  operationId: 'listProjects',
  method: 'get',
  path: '/projects',
  summary: 'Projects of the merchant, newest change first (at most 200)',
  tags: ['projects'],
  auth: true,
  responses: { 200: { description: 'Projects', schema: ProjectList } },
});

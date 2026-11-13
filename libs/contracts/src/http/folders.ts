import { z } from 'zod';
import { CAPTION_STYLE_IDS } from '../project/schema.js';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const FolderParams = z.object({ id: z.uuid() });

/** Output frame: `auto` follows the majority orientation of the folder's footage. */
export const FOLDER_RATIOS = ['auto', '9:16', '16:9', '1:1', '4:5'] as const;
/** What the edit is for: a selling video, a product review, or several clips from a live. */
export const FOLDER_GOALS = ['sell', 'review', 'live'] as const;
/** Target clip length in seconds, or `auto` (the editor decides from the footage). */
export const FOLDER_LENGTHS = ['auto', '15', '30', '60'] as const;

export const FolderSettings = named(
  'FolderSettings',
  z.object({
    ratio: z.enum(FOLDER_RATIOS).default('auto'),
    goal: z.enum(FOLDER_GOALS).default('sell'),
    length: z.enum(FOLDER_LENGTHS).default('auto'),
    /** Exactly as the merchant typed it; never generated. */
    productName: z.string().trim().max(120).nullable().default(null),
    /** Exactly as the merchant typed it (e.g. "199 บาท"); never generated or reformatted. */
    productPrice: z.string().trim().max(40).nullable().default(null),
    musicId: z.uuid().nullable().default(null),
  }),
);
export type FolderSettings = z.infer<typeof FolderSettings>;

export const CreateFolderBody = named(
  'CreateFolderBody',
  z.object({ title: z.string().trim().min(1).max(200), settings: FolderSettings.optional() }),
);
export const UpdateFolderBody = named(
  'UpdateFolderBody',
  z
    .object({ title: z.string().trim().min(1).max(200).optional(), settings: FolderSettings.optional() })
    .refine((b) => b.title !== undefined || b.settings !== undefined, 'nothing to update'),
);
export const FolderSourcesBody = named(
  'FolderSourcesBody',
  z.object({ sourceIds: z.array(z.uuid()).min(1).max(100) }),
);
export const FolderRecord = named(
  'FolderRecord',
  z.object({
    id: z.uuid(),
    title: z.string(),
    settings: FolderSettings,
    sourceIds: z.array(z.uuid()),
    clipIds: z.array(z.uuid()),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
);
export type FolderRecord = z.infer<typeof FolderRecord>;
export const FolderList = named('FolderList', z.object({ items: z.array(FolderRecord) }));

export const FolderPlanStep = named(
  'FolderPlanStep',
  z.object({
    id: z.enum(['prepare', 'transcribe', 'analyse', 'style', 'edit']),
    label: z.string(),
    state: z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'skipped']),
    detail: z.string().nullable(),
    /** Plain Thai reason when failed. */
    error: z.string().nullable(),
  }),
);
export const FolderPlanResponse = named(
  'FolderPlanResponse',
  z.object({
    /** The newest folder edit (null = never started). */
    runId: z.uuid().nullable(),
    styleId: z.string().nullable(),
    styleIds: z.array(z.string()).optional(),
    lockedStyle: z.object({ styleId: z.string(), name: z.string() }).nullable(),
    steps: z.array(FolderPlanStep),
    done: z.number().int(),
    total: z.number().int(),
    finished: z.boolean(),
    failed: z.boolean(),
    /** What the merchant must do for the plan to continue. */
    needs: z.enum(['style']).nullable(),
    /** Styles ranked for this footage (best first, Thai reason); empty until the analysis is in. */
    proposals: z.array(
      z.object({
        styleId: z.string(),
        name: z.string(),
        description: z.string(),
        reason: z.string().nullable(),
        origin: z.enum(['ai', 'rules', 'catalogue']),
        preview: z
          .object({
            sourceId: z.uuid(),
            timeMs: z.number().int(),
            words: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })),
            productName: z.string().nullable(),
            captionStyle: z.enum(CAPTION_STYLE_IDS),
            captionY: z.number(),
            maxWords: z.number().nullable(),
            maxLines: z.number(),
            hookY: z.number(),
            hookWeight: z.number(),
            hookColor: z.string(),
            hookBackground: z.string().nullable(),
          })
          .optional(),
      }),
    ),
  }),
);
export type FolderPlanResponse = z.infer<typeof FolderPlanResponse>;
export const StartFolderEditBody = named(
  'StartFolderEditBody',
  z.object({
    styleId: z.string().min(1).max(64).optional(),
    sourceIds: z.array(z.uuid()).min(1).max(100).optional(),
  }),
);
export const ChooseFolderStyleBody = named(
  'ChooseFolderStyleBody',
  z
    .object({
      styleId: z.string().min(1).max(64),
      styleIds: z.array(z.string().min(1).max(64)).min(1).max(3).optional(),
      lockStyle: z.boolean().optional(),
    })
    .refine((b) => !b.styleIds || b.styleIds.includes(b.styleId), 'The primary style must be selected'),
);
const missing = { description: 'No such folder or source for this merchant', schema: ApiErrorBody };
export const folderRoutes = [
  defineRoute({
    operationId: 'unlockEditingStyle',
    method: 'delete',
    path: '/folders/style-lock',
    summary: 'Stop automatically applying the merchant locked style to new edits',
    tags: ['folders'],
    auth: true,
    responses: { 204: { description: 'Style unlocked' } },
  }),
  defineRoute({
    operationId: 'createFolder',
    method: 'post',
    path: '/folders',
    summary: 'Create a project folder',
    tags: ['folders'],
    auth: true,
    request: { body: CreateFolderBody },
    responses: { 201: { description: 'Created', schema: FolderRecord } },
  }),
  defineRoute({
    operationId: 'listFolders',
    method: 'get',
    path: '/folders',
    summary: 'Project folders, newest change first',
    tags: ['folders'],
    auth: true,
    responses: { 200: { description: 'Folders', schema: FolderList } },
  }),
  defineRoute({
    operationId: 'getFolder',
    method: 'get',
    path: '/folders/{id}',
    summary: 'Footage and edited clips in a project folder',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams },
    responses: { 200: { description: 'Folder', schema: FolderRecord }, 404: missing },
  }),
  defineRoute({
    operationId: 'updateFolder',
    method: 'patch',
    path: '/folders/{id}',
    summary: 'Rename a folder or change its edit settings',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams, body: UpdateFolderBody },
    responses: { 200: { description: 'Updated folder', schema: FolderRecord }, 404: missing },
  }),
  defineRoute({
    operationId: 'addFolderSources',
    method: 'post',
    path: '/folders/{id}/sources',
    summary: 'Add existing Library sources to a folder, atomically and idempotently',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams, body: FolderSourcesBody },
    responses: { 200: { description: 'Updated folder', schema: FolderRecord }, 404: missing },
  }),
  defineRoute({
    operationId: 'getFolderPlan',
    method: 'get',
    path: '/folders/{id}/plan',
    summary: 'Plan panel: ordered edit steps of the folder from the real run states, plus style proposals',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams },
    responses: { 200: { description: 'Plan', schema: FolderPlanResponse }, 404: missing },
  }),
  defineRoute({
    operationId: 'startFolderEdit',
    method: 'post',
    path: '/folders/{id}/edit',
    summary: 'Start editing the folder footage (an unfinished edit is reused)',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams, body: StartFolderEditBody },
    responses: {
      200: { description: 'Plan', schema: FolderPlanResponse },
      404: missing,
      409: { description: 'The folder has no footage yet', schema: ApiErrorBody },
    },
  }),
  defineRoute({
    operationId: 'chooseFolderStyle',
    method: 'post',
    path: '/folders/{id}/style',
    summary: 'Pick the edit style for the running folder edit; the edit continues',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams, body: ChooseFolderStyleBody },
    responses: {
      200: { description: 'Plan', schema: FolderPlanResponse },
      400: { description: 'Unknown style', schema: ApiErrorBody },
      404: missing,
      409: { description: 'No running edit to choose a style for', schema: ApiErrorBody },
    },
  }),
  defineRoute({
    operationId: 'deleteFolder',
    method: 'delete',
    path: '/folders/{id}',
    summary: 'Delete a folder; keep Library footage and editable clips',
    tags: ['folders'],
    auth: true,
    request: { params: FolderParams },
    responses: { 204: { description: 'Deleted or already absent' } },
  }),
];

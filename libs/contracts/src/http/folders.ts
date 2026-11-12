import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const FolderParams = z.object({ id: z.uuid() });
export const CreateFolderBody = named(
  'CreateFolderBody',
  z.object({ title: z.string().trim().min(1).max(200) }),
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
    sourceIds: z.array(z.uuid()),
    clipIds: z.array(z.uuid()),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
);
export type FolderRecord = z.infer<typeof FolderRecord>;
export const FolderList = named('FolderList', z.object({ items: z.array(FolderRecord) }));
const missing = { description: 'No such folder or source for this merchant', schema: ApiErrorBody };
export const folderRoutes = [
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

import { mkdirSync } from 'node:fs';
import { SESSION_COOKIE } from '@myvideo/contracts';
import { extensionOf, UPLOAD_EXTENSIONS, uuidv7 } from '@myvideo/domain';
import type { Env } from '@myvideo/infra';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import type { NextFunction, Request, Response } from 'express';
import { readCookie } from '../auth/cookies.js';
import type { SessionService } from '../auth/session.service.js';
import type { SourcesService } from './sources.service.js';

const MERCHANT_HEADER = 'x-myvideo-merchant';
const PREFIX_RE = /^\/[a-z0-9-]{0,32}$/;

export function createTusStore(env: Env): FileStore {
  mkdirSync(env.UPLOAD_TMP_DIR, { recursive: true });
  return new FileStore({ directory: env.UPLOAD_TMP_DIR });
}

const fail = (status_code: number, message: string) => ({
  status_code,
  body: JSON.stringify({ statusCode: status_code, error: 'upload_rejected', message }),
});

/**
 * Resumable uploads (tus 1.0) at /uploads. The session is checked here (this is Express middleware, outside
 * Nest's guard); the merchant id travels to the tus hooks in a header we set ourselves after stripping any
 * client-sent copy. Each upload remembers its merchant, and every later request is checked against it.
 */
export function createTusMiddleware(
  env: Env,
  store: FileStore,
  sessions: SessionService,
  sources: SourcesService,
) {
  const server = new Server({
    path: '/uploads',
    datastore: store,
    maxSize: env.UPLOAD_MAX_BYTES,
    // Location must work behind the /api proxy: a path-absolute URL with the forwarded prefix.
    generateUrl: (req, { path, id }) => {
      const prefix = req.headers.get('x-forwarded-prefix') ?? '';
      return `${PREFIX_RE.test(prefix) ? prefix : ''}${path}/${id}`;
    },
    onUploadCreate: async (req, upload) => {
      const merchantId = req.headers.get(MERCHANT_HEADER);
      if (!merchantId) throw fail(401, 'Sign in required');
      const filename = String(upload.metadata?.filename ?? '');
      const ext = extensionOf(filename);
      if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
        throw fail(415, `ไฟล์นี้ไม่ใช่วิดีโอที่รองรับ (รองรับ: ${UPLOAD_EXTENSIONS.join(', ')})`);
      }
      return { metadata: { ...upload.metadata, merchantId, sourceId: uuidv7() } };
    },
    onIncomingRequest: async (req, uploadId) => {
      if (req.method === 'POST' || req.method === 'OPTIONS' || !uploadId) return;
      const merchantId = req.headers.get(MERCHANT_HEADER);
      const upload = await store.getUpload(uploadId).catch(() => undefined);
      if (!upload || upload.metadata?.merchantId !== merchantId) throw fail(404, 'Upload not found');
    },
    onUploadFinish: async (req, upload) => {
      const merchantId = req.headers.get(MERCHANT_HEADER) ?? '';
      await sources.finalizeUpload(merchantId, upload.id);
      return {};
    },
  });

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/uploads')) return next();
    // never trust a client-sent merchant header (remove it from both views of the headers)
    delete req.headers[MERCHANT_HEADER];
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i]?.toLowerCase() === MERCHANT_HEADER) req.rawHeaders.splice(i, 2);
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await sessions.resolve(token) : null;
    if (!auth) {
      res.status(401).json({ statusCode: 401, error: 'unauthorized', message: 'Sign in required' });
      return;
    }
    req.headers[MERCHANT_HEADER] = auth.merchantId;
    req.rawHeaders.push(MERCHANT_HEADER, auth.merchantId); // the tus server builds its Request from rawHeaders
    await server.handle(req, res);
  };
}

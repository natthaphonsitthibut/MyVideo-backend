import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

export type StaticServer = { url: string; close(): Promise<void> };

/**
 * Loopback-only file server for the render page: serves exactly the files in `files` (url path → absolute
 * path), with byte ranges so `<video>` can seek. Nothing else on disk is reachable.
 */
export async function serveFiles(files: Map<string, string>): Promise<StaticServer> {
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = files.get(path);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    stat(file).then(
      (st) => {
        const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0;
        let end = st.size - 1;
        if (m) {
          if (m[1] === '' && m[2] !== '') start = Math.max(0, st.size - Number(m[2]));
          else {
            start = Number(m[1]);
            if (m[2] !== '') end = Math.min(end, Number(m[2]));
          }
          if (start > end || start >= st.size) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
            return;
          }
        }
        res.writeHead(m ? 206 : 200, {
          'content-type': type,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          ...(m ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file, { start, end }).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

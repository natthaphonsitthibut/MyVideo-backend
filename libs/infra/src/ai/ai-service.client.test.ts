import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiServiceClient, AiServiceError, AiServiceUnavailableError } from './ai-service.client.js';

// Plumbing test of error mapping with a tiny local HTTP server (not the AI service; that one is tested
// for real in test/ai-service.int.test.ts).
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') return res.end(JSON.stringify({ n: 1 }));
    if (req.url === '/bad-shape') return res.end(JSON.stringify({ n: 'x' }));
    if (req.url === '/not-json') return res.end('<html>');
    if (req.url === '/500') return res.writeHead(500).end('boom');
    if (req.url === '/422') return res.writeHead(422).end('{"detail":"bad"}');
    if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 2000);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const N = z.object({ n: z.number() });

describe('AiServiceClient', () => {
  it('parses a valid JSON response', async () => {
    expect(await new AiServiceClient({ baseUrl: base }).request('/ok', N)).toEqual({ n: 1 });
  });
  it('maps 5xx to a retryable AiServiceError and 4xx to non-retryable', async () => {
    const c = new AiServiceClient({ baseUrl: base });
    await expect(c.request('/500', N)).rejects.toMatchObject({
      name: 'AiServiceError',
      status: 500,
      retryable: true,
    });
    await expect(c.request('/422', N)).rejects.toMatchObject({ status: 422, retryable: false });
  });
  it('rejects bodies that are not JSON or do not match the schema', async () => {
    const c = new AiServiceClient({ baseUrl: base });
    await expect(c.request('/not-json', N)).rejects.toBeInstanceOf(AiServiceError);
    await expect(c.request('/bad-shape', N)).rejects.toThrow(/failed validation/);
  });
  it('times out as AiServiceUnavailableError', async () => {
    const c = new AiServiceClient({ baseUrl: base, timeoutMs: 100 });
    await expect(c.request('/slow', N)).rejects.toThrow(AiServiceUnavailableError);
    await expect(c.request('/slow', N)).rejects.toThrow(/timed out after 100 ms/);
  });
  it('maps a refused connection to AiServiceUnavailableError and probe() to down', async () => {
    const c = new AiServiceClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(c.health()).rejects.toThrow(/unreachable/);
    expect((await c.probe()).status).toBe('down');
  });
  it('passes caller cancellation through unchanged', async () => {
    const ac = new AbortController();
    const p = new AiServiceClient({ baseUrl: base }).request('/slow', N, { signal: ac.signal });
    ac.abort(new Error('cancelled by job'));
    await expect(p).rejects.toThrow('cancelled by job');
  });
});

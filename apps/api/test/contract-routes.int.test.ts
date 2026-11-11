import { expressPath, routes } from '@myvideo/contracts';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';

/** Every controller route must exist in libs/contracts (and so in openapi.json), and vice versa. */
describe('API routes match the contracts', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp(testEnv());
    await app.init();
  });
  afterAll(async () => app.close());

  it('has the same method+path set', () => {
    const discovery = app.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const served: string[] = [];
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || !wrapper.metatype) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, wrapper.metatype) ?? '');
      for (const name of scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const handler = (instance as Record<string, unknown>)[name] as object;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const method = (
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?'
        ).toLowerCase();
        const path = `/${[base, String(sub)]
          .map((p) => p.replace(/^\/|\/$/g, ''))
          .filter(Boolean)
          .join('/')}`;
        served.push(`${method} ${path}`);
      }
    }
    const contracted = routes.map((r) => `${r.method} ${expressPath(r.path)}`);
    expect(served.sort()).toEqual(contracted.sort());
  });
});

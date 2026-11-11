import { getMe, login, logout } from './http/auth.js';
import { getHealth } from './http/health.js';
import type { RouteContract } from './route.js';

/** Every HTTP route the API serves. The API test suite fails if a controller route is missing here. */
export const routes: RouteContract[] = [getHealth, login, logout, getMe];

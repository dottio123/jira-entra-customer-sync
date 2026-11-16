import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebConfig } from '../config';
import type { RunTracker } from '../run-tracker';
import type { Principal, SessionRecord, WebStore } from '../store';
import type { WebServices } from '../wiring';
import type { Notice } from '../view-helpers';
import type { OriginPolicy } from './security';

export type Form = Record<string, string | undefined>;
export type Query = Record<string, string | undefined>;

export function form(request: FastifyRequest): Form {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as Form;
}

export function query(request: FastifyRequest): Query {
  return (request.query && typeof request.query === 'object' ? request.query : {}) as Query;
}

export interface CookieSettings {
  session: string;
  loginCsrf: string;
  options: { path: string; httpOnly: boolean; secure: boolean; sameSite: 'lax' };
}

/** Everything a route module needs, created once per app instance. */
export interface WebContext {
  config: WebConfig;
  store: WebStore;
  services: WebServices;
  runs: RunTracker;
  origin: OriginPolicy;
  cookies: CookieSettings;
  contentSecurityPolicy(allowAtlassianAuthorization?: boolean): string;
  /** Renders a page inside the layout; a `?notice=<code>` query adds a standard notice. */
  render(
    request: FastifyRequest,
    reply: FastifyReply,
    page: string,
    title: string,
    principal: Principal | null,
    locals?: Record<string, unknown>,
  ): Promise<void>;
  /** Renders the friendly error page with the given HTTP status. */
  renderError(
    request: FastifyRequest,
    reply: FastifyReply,
    statusCode: number,
    notice: Notice,
  ): Promise<void>;
  session(request: FastifyRequest): SessionRecord | undefined;
  /** Redirects to sign-in or password change as needed; undefined means the reply is handled. */
  requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
    adminOnly?: boolean,
  ): Promise<SessionRecord | undefined>;
  /** requireSession plus origin and CSRF-token checks for form submissions. */
  requireFormSession(
    request: FastifyRequest,
    reply: FastifyReply,
    adminOnly?: boolean,
  ): Promise<SessionRecord | undefined>;
}

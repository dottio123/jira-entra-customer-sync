import { timingSafeEqual } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { isLoopbackHost, WebConfig } from '../config';

export function constantEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export interface OriginPolicy {
  /** True when the request's Host (or trusted forwarded host) is the public host or loopback. */
  isAllowedHost(request: FastifyRequest): boolean;
  /** True when a browser Origin header is absent, the public origin, or loopback. */
  isAllowedOrigin(origin: string | undefined): boolean;
  /** A same-site path from a Referer header, or undefined when it is not safe to redirect to. */
  safeRedirectPath(referer: string | undefined): string | undefined;
}

export function createOriginPolicy(config: WebConfig): OriginPolicy {
  const configured = new URL(config.publicBaseUrl);

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true;
    try {
      const originUrl = new URL(origin);
      if (originUrl.origin.toLowerCase() === configured.origin.toLowerCase()) return true;
      // Loopback origins on any port support local administration and port-mapped access.
      return isLoopbackHost(originUrl.hostname);
    } catch {
      return false;
    }
  };

  return {
    isAllowedHost(request) {
      // Fastify's request.host honors X-Forwarded-Host only from proxies trusted by WEB_TRUST_PROXY.
      const effectiveHost = (request.host || '').split(',')[0]!.trim().toLowerCase();
      if (effectiveHost === configured.host.toLowerCase()) return true;
      return isLoopbackHost(effectiveHost.replace(/:\d+$/, ''));
    },
    isAllowedOrigin,
    safeRedirectPath(referer) {
      if (!referer) return undefined;
      try {
        const parsed = new URL(referer);
        if (!isAllowedOrigin(parsed.origin)) return undefined;
        const target = parsed.pathname + parsed.search;
        // "//host" and "/\host" would be treated by browsers as another site.
        if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
          return undefined;
        }
        return target;
      } catch {
        return undefined;
      }
    },
  };
}

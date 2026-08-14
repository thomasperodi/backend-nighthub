import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { resolveCorsOrigins } from '../common/cors-origins';

/**
 * Defense-in-depth CSRF check for the cookie-authenticated auth endpoints
 * (/auth/refresh, /auth/logout, /auth/sessions*). These endpoints act purely on the
 * ambient HttpOnly refresh-token cookie, so SameSite is the primary defense - but if the
 * cookie ever needs `SameSite=None` (a genuinely cross-site frontend/backend split),
 * SameSite alone does not stop a forged cross-site request. Browsers always attach an
 * `Origin` header to cross-site fetch/XHR requests, so validating it against the same
 * allow-list CORS already trusts (CORS_ORIGINS) blocks requests forged from a page the
 * browser considers a different site.
 *
 * Requests with no Origin/Referer header (native/mobile clients, curl, server-to-server)
 * are allowed through: they are not driven by a browser's ambient cookie jar, so they are
 * not a CSRF vector, and non-browser refresh callers legitimately have no Origin to send.
 */
@Injectable()
export class CsrfOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;

    const candidate =
      typeof origin === 'string' && origin
        ? origin
        : this.originFromReferer(req.headers.referer);

    if (!candidate) return true;

    const allowed = resolveCorsOrigins();
    if (allowed.includes(candidate)) return true;

    throw new ForbiddenException('Origin not allowed');
  }

  private originFromReferer(referer?: string): string | undefined {
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
}

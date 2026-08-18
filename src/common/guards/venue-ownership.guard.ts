import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RequestUser } from '../../auth/types';

const VENUE_PARAM_KEY = 'venueOwnershipParam';

type RequestWithUser = Request & { user?: RequestUser };

/**
 * The reusable version of the `if (role === 'venue' && venue_id !== id) throw Forbidden`
 * pattern repeated ~20+ times across venues/events/reservations/staff controllers (see the
 * NightHub Organizations audit, §D.2, which flagged this as a structural IDOR risk - a new
 * endpoint that forgets the check is wide open). New venue-scoped endpoints should use
 * `@RequireVenueOwnership()` instead of re-copying the inline check; existing call sites are
 * left as-is (retrofitting all of them is a larger, separate pass - not bundled in here).
 */
@Injectable()
export class VenueOwnershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName =
      this.reflector.get<string>(VENUE_PARAM_KEY, context.getHandler()) ?? 'id';
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    const venueId = request.params?.[paramName];

    if (!user?.id) throw new ForbiddenException('Forbidden');
    const role = String(user.role || '').toLowerCase();
    if (role === 'admin') return true;
    if (role === 'venue' && user.venue_id && user.venue_id === venueId) {
      return true;
    }
    throw new ForbiddenException('Forbidden');
  }
}

/** Restricts a route to admins or the `venue`-role account that owns the resource named by
 * `paramName` (defaults to the route's `:id`). Combine with `@Roles('venue', 'admin')`. */
export function RequireVenueOwnership(paramName = 'id') {
  return applyDecorators(
    SetMetadata(VENUE_PARAM_KEY, paramName),
    UseGuards(VenueOwnershipGuard),
  );
}

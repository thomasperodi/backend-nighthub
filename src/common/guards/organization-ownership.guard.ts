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

const ORGANIZATION_PARAM_KEY = 'organizationOwnershipParam';

type RequestWithUser = Request & { user?: RequestUser };

/**
 * Same pattern as VenueOwnershipGuard, for organization-scoped routes: admins pass always,
 * an `organization`-role account only passes for its own organization_id (one owner account
 * per organization for now - see the confirmed business rules in the Organizations audit).
 * This replaced OrganizationsService's private `assertOrgAccess` helper for the routes it's
 * applied to, so the check lives in one guard instead of being re-invoked per service method.
 */
@Injectable()
export class OrganizationOwnershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName =
      this.reflector.get<string>(
        ORGANIZATION_PARAM_KEY,
        context.getHandler(),
      ) ?? 'id';
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    const organizationId = request.params?.[paramName];

    if (!user?.id) throw new ForbiddenException('Forbidden');
    const role = String(user.role || '').toLowerCase();
    if (role === 'admin') return true;
    if (
      role === 'organization' &&
      user.organization_id &&
      user.organization_id === organizationId
    ) {
      return true;
    }
    throw new ForbiddenException('Forbidden');
  }
}

/** Restricts a route to admins or the `organization`-role account that owns the resource
 * named by `paramName` (defaults to the route's `:id`). Combine with
 * `@Roles('organization', 'admin')`. */
export function RequireOrganizationOwnership(paramName = 'id') {
  return applyDecorators(
    SetMetadata(ORGANIZATION_PARAM_KEY, paramName),
    UseGuards(OrganizationOwnershipGuard),
  );
}

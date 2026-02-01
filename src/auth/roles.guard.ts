import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, AppRole } from './roles.decorator';
import type { RequestUser } from './types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No roles required -> allow (still requires auth unless @Public).
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req?.user as RequestUser | undefined;
    const role = String(user?.role || '').toLowerCase();

    if (!role) throw new ForbiddenException('Forbidden');

    if (requiredRoles.includes(role as AppRole)) return true;

    throw new ForbiddenException('Forbidden');
  }
}

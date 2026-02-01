import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { RequestUser } from './types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const authorization: string | undefined = req?.headers?.authorization;
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization token');

    if (this.authService.isTokenRevoked(token)) {
      throw new UnauthorizedException('Token revoked');
    }

    let payload: unknown;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    if (!payload || typeof payload !== 'object' || !("sub" in payload)) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const p = payload as {
      sub?: string;
      role?: string;
      venue_id?: string | null;
      venueId?: string | null;
    };

    const id = String(p.sub || '');
    const role = String(p.role || '').toLowerCase();
    const venue_id = (p.venue_id ?? p.venueId ?? null) as string | null;

    if (!id || !role) throw new UnauthorizedException('Invalid token payload');

    // For backward compatibility with older tokens that didn't include venue_id.
    let resolvedVenueId: string | null = venue_id;
    if (resolvedVenueId === null || resolvedVenueId === undefined) {
      const u = await this.prisma.users.findUnique({
        where: { id },
        select: { venue_id: true },
      });
      resolvedVenueId = u?.venue_id ?? null;
    }

    const user: RequestUser = { id, role, venue_id: resolvedVenueId };
    req.user = user;

    return true;
  }
}

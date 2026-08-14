import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  // Kept async (despite no internal await) so it keeps returning a Promise<boolean>, matching
  // the interface every other guard/caller in the app expects from canActivate().
  // eslint-disable-next-line @typescript-eslint/require-await
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const authorization: string | undefined = req?.headers?.authorization;
    // The access token only ever travels in the Authorization header now - it is never
    // read from a cookie. (The refresh token is the cookie-only one; see AuthController.)
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization token');

    // Access tokens are short-lived (15 min, see jwt.config.ts) and stateless: unlike the
    // refresh token, there is no DB-backed revocation check here on purpose - a revoked
    // session simply stops being able to mint new access tokens via /auth/refresh, and the
    // short TTL bounds how long an already-issued access token can outlive that revocation.
    const user = this.authService.verifyAccessToken(token);
    req.user = user;

    // Best-effort, throttled activity tracking. Fire-and-forget so it never adds a DB
    // round-trip to the latency of every authenticated request.
    void this.authService.touchUserActivity(user.id).catch((error) => {
      this.logger.warn(
        `Failed to record activity for user ${user.id}: ${String(error)}`,
      );
    });

    return true;
  }
}

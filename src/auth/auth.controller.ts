import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AuthService,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_MS,
} from './auth.service';
import {
  RegisterDto,
  LoginDto,
  PushTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ResetPasswordSupabaseDto,
} from './dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import { CsrfOriginGuard } from './csrf-origin.guard';
import type { RequestUser } from './types';
import { assertCronSecret } from '../common/cron-auth.util';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  private sessionMeta(req: Request) {
    return {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    };
  }

  // Defaults to Lax: the PWA frontend and this API are expected to share a registrable
  // domain (e.g. app.nighthub.it / api.nighthub.it), which SameSite=Lax already covers for
  // same-site fetch/XHR - Strict would additionally block the cookie being set on a
  // top-level redirect back from an external identity/payment provider, which Lax allows.
  // Only override to 'none' via COOKIE_SAMESITE if the frontend is genuinely deployed on a
  // different site (e.g. separate *.vercel.app project domains); 'none' always implies
  // Secure regardless of NODE_ENV, and CsrfOriginGuard's Origin allow-list check on
  // refresh/logout/sessions is the CSRF defense that SameSite=None gives up.
  private resolveSameSite(): 'lax' | 'strict' | 'none' {
    const configured = String(process.env.COOKIE_SAMESITE || '')
      .trim()
      .toLowerCase();
    if (configured === 'strict' || configured === 'none') return configured;
    return 'lax';
  }

  // The refresh token cookie is the sole carrier of the refresh token: HttpOnly (no JS
  // access), Secure in production (always Secure if SameSite=None), and scoped to
  // /api/auth so it is never sent on unrelated API calls. It never appears in a JSON
  // response body. The access token, by contrast, is only ever returned in the body - the
  // frontend is expected to keep it in memory only (see AUTH AUDIT target architecture).
  private setRefreshCookie(res: Response, token: string) {
    const sameSite = this.resolveSameSite();
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
      sameSite,
      maxAge: REFRESH_TOKEN_TTL_MS,
      path: REFRESH_COOKIE_PATH,
    });
  }

  private clearRefreshCookie(res: Response) {
    const sameSite = this.resolveSameSite();
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
      sameSite,
      path: REFRESH_COOKIE_PATH,
    });
  }

  private readRefreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
  }

  // Same session shape as /auth/login (access token in the body, refresh token in the
  // cookie) - registering logs the new user in immediately, matching what the frontend
  // expects from every other session-issuing endpoint.
  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto, this.sessionMeta(req));
    if (!result) return null;

    this.setRefreshCookie(res, result.refreshToken);
    return { access_token: result.accessToken, user: result.user };
  }

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, this.sessionMeta(req));
    if (!result) return null;

    this.setRefreshCookie(res, result.refreshToken);
    return { access_token: result.accessToken, user: result.user };
  }

  // Called by the frontend whenever it has no access token in memory (PWA cold start) or
  // whenever an API call comes back 401 for an expired access token. The refresh token is
  // read exclusively from the HttpOnly cookie - never accepted from the body or a header -
  // so a script running on the page (XSS) cannot exfiltrate or forge it.
  @Post('refresh')
  @Public()
  @UseGuards(CsrfOriginGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = this.readRefreshCookie(req);
    const result = await this.authService.refreshSession(
      rawToken,
      this.sessionMeta(req),
    );

    this.setRefreshCookie(res, result.refreshToken);
    return { access_token: result.accessToken, user: result.user };
  }

  @Post('forgot-password')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    const identifier = dto.identifier || dto.email || dto.username;
    return this.authService.requestPasswordReset(identifier, dto.redirect_to);
  }

  @Post('reset-password')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.new_password);
  }

  @Post('reset-password-supabase')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPasswordSupabase(@Body() dto: ResetPasswordSupabaseDto) {
    return this.authService.resetPasswordFromSupabaseRecovery(
      dto.access_token,
      dto.new_password,
    );
  }

  // Public (not gated behind JwtAuthGuard): logout must still work even if the access
  // token already expired while the refresh token cookie is still valid - it only ever
  // acts on the cookie, never on the Authorization header.
  @Post('logout')
  @Public()
  @UseGuards(CsrfOriginGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = this.readRefreshCookie(req);
    const result = await this.authService.logout(rawToken);
    this.clearRefreshCookie(res);
    return result;
  }

  // Session management - requires a valid access token (JwtAuthGuard applies, these are
  // not @Public()) since they act on `CurrentUser().id`, not on the refresh cookie alone.
  @Get('sessions')
  listSessions(@CurrentUser() user: RequestUser) {
    return this.authService.listSessions(user.id);
  }

  @Delete('sessions/:id')
  @UseGuards(CsrfOriginGuard)
  revokeSession(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.authService.revokeSessionById(user.id, id);
  }

  // "Logout everywhere". Keeps the caller's own current session alive by excluding the
  // refresh token cookie presented on this very request, if any.
  @Delete('sessions')
  @UseGuards(CsrfOriginGuard)
  revokeAllSessions(@Req() req: Request, @CurrentUser() user: RequestUser) {
    return this.authService.revokeAllSessions(
      user.id,
      this.readRefreshCookie(req),
    );
  }

  @Post('change-password')
  async changePassword(
    @Body() body: { current_password?: string; new_password?: string },
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.changePassword(
      user.id,
      String(body?.current_password || ''),
      String(body?.new_password || ''),
    );
    // Every refresh session (including this one) was just revoked server-side - clear the
    // cookie too so the client doesn't keep trying to use a dead one.
    this.clearRefreshCookie(res);
    return result;
  }

  @Post('push-token')
  async setPushToken(
    @Body() dto: PushTokenDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.authService.setPushToken(user.id, dto.push_token);
    return { success: true };
  }

  @Post('activity')
  async touchActivity(@CurrentUser() user: RequestUser) {
    await this.authService.touchUserActivity(user.id);
    return { success: true };
  }

  @Delete('me')
  async deleteMe(
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.deleteUser(user.id);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  // Called by an external scheduler (Vercel Cron) with a shared secret, same pattern as
  // GET /events/sync-status. Purges expired refresh tokens and used password-reset tokens
  // so those tables don't grow unbounded.
  @Get('cleanup-tokens')
  @Public()
  async cleanupTokens(
    @Query('token') token?: string,
    @Headers('x-cron-secret') headerSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    assertCronSecret({ token, headerSecret, authorization });
    return this.authService.cleanupExpiredTokens();
  }
}

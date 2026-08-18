import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { hash, compare } from 'bcrypt';
import { Prisma, UserRole, users } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { REFRESH_TOKEN_TTL_MS } from './jwt.config';
import type { AccessTokenPayload, RequestUser } from './types';

export type PublicUser = {
  id: string;
  email: string;
  username?: string | null;
  name?: string | null;
  avatar?: string | null;
  role: string;
  venue_id?: string | null;
  pr_venue_id?: string | null;
  /** True while the user has at least one active venue_pr_memberships row - always
   * server-derived, never client-settable, so it doubles as an anti-impersonation "verified
   * PR" signal shown on their profile (see BadgesModule-adjacent PR verification badge). */
  is_verified_pr: boolean;
  onboarding_completed: boolean;
  created_at?: Date | null;
};

export type LoginResult = {
  accessToken: string;
  user: PublicUser;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
} | null;

export type RefreshResult = {
  accessToken: string;
  user: PublicUser;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

export type SessionMeta = { userAgent?: string; ip?: string };

export type SessionSummary = {
  id: string;
  created_at: Date;
  expires_at: Date;
  user_agent: string | null;
  ip: string | null;
};

// The refresh token is an opaque, high-entropy random value (NOT a JWT), sent to the
// browser exclusively via an HttpOnly cookie scoped to the auth routes - JavaScript can
// never read it, and it is never included in any JSON response body. Only its SHA-256
// hash is ever persisted (see `refresh_tokens` in prisma/schema.prisma), so a database
// leak alone does not hand out usable refresh tokens.
export const REFRESH_COOKIE_NAME = 'nighthub_refresh_token';
export const REFRESH_COOKIE_PATH = '/api/auth';
export { REFRESH_TOKEN_TTL_MS };

@Injectable()
export class AuthService {
  private readonly activityThrottleMs = 60 * 1000;
  private readonly passwordResetTokenTtlSeconds = 15 * 60;
  private readonly logger = new Logger(AuthService.name);
  private supabaseAdminClient?: ReturnType<typeof createClient>;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private isTransientPrismaConnectivityError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return (
        error.code === 'P1001' ||
        error.code === 'P1002' ||
        error.code === 'P1017'
      );
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return true;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = String(error.message || '').toLowerCase();
      return (
        msg.includes('server has closed the connection') ||
        msg.includes('connection reset') ||
        msg.includes('connection closed') ||
        msg.includes("can't reach database server")
      );
    }

    return false;
  }

  private async resolvePrDisplayContext(
    userId: string,
    baseRole: string,
  ): Promise<{ role: string; pr_venue_id: string | null }> {
    const activeMembership = await this.prisma.venue_pr_memberships.findFirst({
      where: { user_id: userId, is_active: true },
      select: { venue_id: true },
    });

    if (!activeMembership) {
      return { role: baseRole, pr_venue_id: null };
    }

    return { role: 'pr', pr_venue_id: activeMembership.venue_id };
  }

  private normalizeIdentifier(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  private getSupabaseAdminClient() {
    if (this.supabaseAdminClient) return this.supabaseAdminClient;

    const url = String(
      process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '',
    ).trim();
    const serviceRoleKey = String(
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
        '',
    ).trim();

    if (!url || !serviceRoleKey) {
      throw new BadRequestException(
        'Supabase Auth non configurato: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY',
      );
    }

    this.supabaseAdminClient = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    return this.supabaseAdminClient;
  }

  private async getEmailFromSupabaseRecoveryAccessToken(
    accessToken: string,
  ): Promise<string> {
    const supabase = this.getSupabaseAdminClient();
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data?.user?.email) {
      throw new BadRequestException(
        'Token recovery Supabase non valido o scaduto',
      );
    }

    return data.user.email.trim().toLowerCase();
  }

  private isSupabaseForgotPasswordEnabled(): boolean {
    const provider = String(process.env.FORGOT_PASSWORD_PROVIDER || '').trim();
    return provider.toLowerCase() === 'supabase';
  }

  private getSupabaseResetRedirectUrl(overrideRedirectTo?: string): string {
    const override = String(overrideRedirectTo || '').trim();
    if (override) {
      try {
        const parsed = new URL(override);
        const allowedProtocols = new Set([
          'https:',
          'http:',
          'nighthub:',
          'exp:',
        ]);

        if (allowedProtocols.has(parsed.protocol)) {
          return override;
        }

        this.logger.warn(
          `Ignored unsupported reset redirect protocol: ${parsed.protocol}`,
        );
      } catch {
        this.logger.warn(
          `Ignored invalid redirect_to for forgot-password: ${override}`,
        );
      }
    }

    return String(
      process.env.SUPABASE_RESET_REDIRECT_URL ||
        process.env.APP_RESET_PASSWORD_URL ||
        process.env.FRONTEND_RESET_PASSWORD_URL ||
        'nighthub://reset-password',
    ).trim();
  }

  private isSupabaseUserAlreadyExistsError(error: unknown): boolean {
    const maybeError = error as {
      message?: string;
      code?: string;
      status?: number;
      name?: string;
    } | null;

    const message = String(maybeError?.message || '').toLowerCase();
    const code = String(maybeError?.code || '').toLowerCase();
    const name = String(maybeError?.name || '').toLowerCase();
    const status = Number(maybeError?.status || 0);

    return (
      message.includes('already registered') ||
      message.includes('already been registered') ||
      message.includes('has already been registered') ||
      message.includes('user already exists') ||
      message.includes('duplicate key') ||
      code.includes('user_already') ||
      code.includes('email_exists') ||
      (name.includes('authapierror') && status === 422)
    );
  }

  private async ensureSupabaseAuthUser(email: string) {
    const supabase = this.getSupabaseAdminClient();
    const temporaryPassword = randomBytes(24).toString('base64url');

    const { error } = await supabase.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        source: 'backend-password-reset',
      },
    });

    if (error && !this.isSupabaseUserAlreadyExistsError(error)) {
      throw error;
    }
  }

  private async sendSupabasePasswordResetEmail(
    email: string,
    redirectTo: string,
  ): Promise<boolean> {
    const supabase = this.getSupabaseAdminClient();

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      this.logger.warn(
        `Supabase reset email failed for ${email}: ${error.message}`,
      );
      return false;
    }

    return true;
  }

  private buildResetPasswordUrl(token: string): string | null {
    const base = String(
      process.env.APP_RESET_PASSWORD_URL ||
        process.env.FRONTEND_RESET_PASSWORD_URL ||
        '',
    ).trim();

    if (!base) return null;

    try {
      const url = new URL(base);
      url.searchParams.set('token', token);
      return url.toString();
    } catch {
      return null;
    }
  }

  private async sendPasswordResetEmail(params: {
    email: string;
    name?: string | null;
    token: string;
  }) {
    const apiKey = String(process.env.BREVO_API_KEY || '').trim();
    const fromEmail = String(process.env.BREVO_FROM_EMAIL || '').trim();
    const fromName = String(process.env.BREVO_FROM_NAME || 'NightHub').trim();
    const resetUrl = this.buildResetPasswordUrl(params.token);

    if (!apiKey || !fromEmail || !resetUrl) {
      return false;
    }

    const displayName = String(params.name || '').trim() || 'utente';
    const subject = 'Reset password Night App';
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
        <p>Ciao ${displayName},</p>
        <p>abbiamo ricevuto una richiesta di reset della password.</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">
            Reimposta password
          </a>
        </p>
        <p>Se il pulsante non funziona, copia questo codice token nell'app:</p>
        <p style="font-family:monospace;background:#f4f4f4;padding:8px;border-radius:6px;word-break:break-all;">${params.token}</p>
        <p>Il link scade tra 15 minuti.</p>
        <p>Se non hai richiesto tu questa operazione, ignora questa email.</p>
      </div>
    `;

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: {
            email: fromEmail,
            name: fromName,
          },
          to: [{ email: params.email, name: displayName }],
          subject,
          htmlContent: html,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.warn(
          `Password reset email failed for ${params.email}: ${response.status} ${errorBody}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(
        `Password reset email request error for ${params.email}: ${String(error)}`,
      );
      return false;
    }
  }

  private async findUserByIdentifier(
    identifier: string,
  ): Promise<users | null> {
    const normalized = this.normalizeIdentifier(identifier);
    if (!normalized) return null;

    return this.prisma.users.findFirst({
      where: {
        OR: [
          { email: { equals: normalized, mode: 'insensitive' } },
          { username: { equals: normalized, mode: 'insensitive' } },
        ],
      },
    });
  }

  async touchUserActivity(userId: string, observedAt: Date = new Date()) {
    if (!userId) {
      throw new BadRequestException('userId required');
    }

    if (Number.isNaN(observedAt.getTime())) {
      throw new BadRequestException('observedAt invalid');
    }

    const throttleBefore = new Date(
      observedAt.getTime() - this.activityThrottleMs,
    );

    try {
      await this.prisma.users.updateMany({
        where: {
          id: userId,
          OR: [
            { last_active_at: null },
            { last_active_at: { lt: throttleBefore } },
          ],
        },
        data: {
          last_active_at: observedAt,
        },
      });
    } catch (error) {
      // Activity tracking should be best-effort and must not break authenticated requests.
      if (this.isTransientPrismaConnectivityError(error)) {
        this.logger.warn(
          `Skipping activity update for user ${userId}: temporary database connectivity issue.`,
        );
      } else {
        throw error;
      }
    }

    return {
      user_id: userId,
      last_active_at: observedAt,
    };
  }

  async register(dto: RegisterDto, meta: SessionMeta = {}): Promise<LoginResult> {
    // Public self-registration always creates a `client` account. Promoting a user to
    // staff/venue/admin is an admin-only operation (AdminService.updateUserAssignment) -
    // never trust a role/venue_id supplied by an unauthenticated caller here.
    const role = UserRole.client;

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(dto.password, 10);
    const username = String(dto.username || '')
      .trim()
      .toLowerCase();
    if (!username) {
      throw new BadRequestException('username required');
    }

    const name = String(dto.name || '').trim();
    if (!name) {
      throw new BadRequestException('name required');
    }

    const birthDate = dto.birth_date ? new Date(dto.birth_date) : undefined;
    if (birthDate && Number.isNaN(birthDate.getTime())) {
      throw new BadRequestException('birth_date must be ISO8601');
    }

    let user: users;
    try {
      user = await this.prisma.users.create({
        data: {
          email: dto.email,
          username,
          password_hash: hashedPassword,
          role,
          name: name || undefined,
          phone: dto.phone ?? undefined,
          avatar: dto.avatar ?? undefined,
          sesso: dto.sesso ?? undefined,
          birth_date: birthDate ?? undefined,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = Array.isArray(err.meta?.target)
          ? err.meta?.target.join(', ')
          : 'unique field';
        throw new ConflictException(`User already exists (${target})`);
      }
      throw err;
    }

    // Auto-login after registration: the frontend expects the same session shape as
    // POST /auth/login (access token in the body, refresh token in the cookie) so a new
    // user is immediately authenticated instead of having to submit their password again
    // right after typing it.
    const accessToken = this.signAccessToken(user);
    const refreshSession = await this.issueRefreshSession(user.id, meta);
    const publicUser = await this.buildPublicUser(user);

    return {
      accessToken,
      user: publicUser,
      refreshToken: refreshSession.raw,
      refreshTokenExpiresAt: refreshSession.expiresAt,
    };
  }

  private signAccessToken(
    user: Pick<users, 'id' | 'role' | 'venue_id'>,
  ): string {
    // Payload stays minimal on purpose (sub, role, venue_id only) - no email, no password,
    // nothing that would be sensitive if the token were ever intercepted. Expiry comes from
    // JwtModule's default signOptions (ACCESS_TOKEN_TTL_SECONDS, see jwt.config.ts).
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      venue_id: user.venue_id,
    };
    return this.jwtService.sign(payload);
  }

  /**
   * The single place that verifies an access token JWT. Used by JwtAuthGuard for every
   * normal authenticated request, and reused (instead of re-implemented) anywhere else in
   * the app that needs to accept an access token outside the guard - see
   * EventsController's cron endpoint, which also allows a shared-secret fallback.
   */
  verifyAccessToken(token: string): RequestUser {
    let payload: unknown;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    if (!payload || typeof payload !== 'object' || !('sub' in payload)) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const p = payload as Partial<AccessTokenPayload>;
    const id = String(p.sub || '');
    const role = String(p.role || '').toLowerCase();
    if (!id || !role) throw new UnauthorizedException('Invalid token payload');

    return { id, role, venue_id: p.venue_id ?? null };
  }

  private hashRefreshToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private async issueRefreshSession(
    userId: string,
    meta: SessionMeta,
    familyId?: string,
  ): Promise<{ raw: string; expiresAt: Date; id: string }> {
    const raw = randomBytes(64).toString('base64url');
    const tokenHash = this.hashRefreshToken(raw);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    const row = await this.prisma.refresh_tokens.create({
      data: {
        user_id: userId,
        token_hash: tokenHash,
        family_id: familyId ?? randomUUID(),
        expires_at: expiresAt,
        user_agent: meta.userAgent?.slice(0, 512),
        ip: meta.ip?.slice(0, 64),
      },
      select: { id: true },
    });

    return { raw, expiresAt, id: row.id };
  }

  private async buildPublicUser(user: users): Promise<PublicUser> {
    const prContext = await this.resolvePrDisplayContext(user.id, user.role);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      role: prContext.role,
      venue_id: user.venue_id,
      pr_venue_id: prContext.pr_venue_id,
      is_verified_pr: Boolean(prContext.pr_venue_id),
      onboarding_completed: Boolean(user.onboarding_completed_at),
      created_at: user.created_at,
    };
  }

  /** POST /auth/onboarding/complete. Idempotent: only ever sets the timestamp once. The
   * onboarding flow otherwise has no backend state, which meant it silently replayed on
   * every new device/browser (localStorage-only flag) and could be skipped entirely when a
   * session was restored via refresh token instead of an explicit login submit. */
  async completeOnboarding(userId: string): Promise<{ onboarding_completed: true }> {
    await this.prisma.users.updateMany({
      where: { id: userId, onboarding_completed_at: null },
      data: { onboarding_completed_at: new Date() },
    });
    return { onboarding_completed: true };
  }

  async login(dto: LoginDto, meta: SessionMeta = {}): Promise<LoginResult> {
    const input = dto as unknown as {
      identifier?: unknown;
      email?: unknown;
      password?: unknown;
    };

    const rawIdentifier =
      typeof input.identifier === 'string'
        ? input.identifier
        : typeof input.email === 'string'
          ? input.email
          : '';
    const identifier = this.normalizeIdentifier(rawIdentifier);
    if (!identifier || typeof input.password !== 'string' || !input.password) {
      return null;
    }

    const user: users | null = await this.findUserByIdentifier(identifier);
    if (!user) return null;

    const bcryptCompare = compare as (a: string, b: string) => Promise<boolean>;
    const valid = await bcryptCompare(input.password, user.password_hash);
    if (!valid) return null;

    // Deliberately thrown (not `return null`) so a suspended account gets a distinct,
    // explicit error instead of blending into the generic "invalid credentials" response.
    await this.assertUsableAccount(user);

    await this.touchUserActivity(user.id, new Date());

    const accessToken = this.signAccessToken(user);
    const refreshSession = await this.issueRefreshSession(user.id, meta);
    const publicUser = await this.buildPublicUser(user);

    return {
      accessToken,
      user: publicUser,
      refreshToken: refreshSession.raw,
      refreshTokenExpiresAt: refreshSession.expiresAt,
    };
  }

  /**
   * POST /auth/refresh core logic. Verifies the opaque refresh token read from the
   * HttpOnly cookie, then rotates it: the presented token is revoked and a brand-new one
   * is issued in the same "family" (family_id), which is what lets reuse detection revoke
   * the whole session below if the old, already-rotated token is ever presented again.
   */
  async refreshSession(
    rawToken: string | undefined,
    meta: SessionMeta = {},
  ): Promise<RefreshResult> {
    if (!rawToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokenHash = this.hashRefreshToken(rawToken);
    const existing = await this.prisma.refresh_tokens.findUnique({
      where: { token_hash: tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revoked_at) {
      // This exact token was already rotated away (or explicitly revoked) once before.
      // Being presented again means either a replay of an old cookie, or a genuine token
      // theft where the legitimate rotation already happened. Either way, treat the whole
      // session as compromised rather than just rejecting this one request.
      await this.revokeFamily(existing.family_id);
      this.logger.warn(
        `Refresh token reuse detected for user ${existing.user_id}, family ${existing.family_id} - session revoked.`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (existing.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: existing.user_id },
    });
    if (!user) {
      await this.revokeFamily(existing.family_id);
      throw new UnauthorizedException('User no longer exists');
    }
    try {
      await this.assertUsableAccount(user);
    } catch (error) {
      // A suspension applied mid-session revokes the whole refresh family immediately -
      // this is what bounds a suspension to at most one access-token TTL (15 min, see
      // jwt-auth.guard.ts) instead of the account staying usable until the refresh token's
      // own multi-day expiry.
      await this.revokeFamily(existing.family_id);
      throw error;
    }

    const next = await this.issueRefreshSession(
      user.id,
      meta,
      existing.family_id,
    );

    await this.prisma.refresh_tokens.update({
      where: { id: existing.id },
      data: { revoked_at: new Date(), replaced_by: next.id },
    });

    const accessToken = this.signAccessToken(user);
    const publicUser = await this.buildPublicUser(user);

    return {
      accessToken,
      user: publicUser,
      refreshToken: next.raw,
      refreshTokenExpiresAt: next.expiresAt,
    };
  }

  // Checked at login and at refresh (never per-request - see the comment on
  // JwtAuthGuard.canActivate for why access tokens are deliberately stateless). Covers two
  // independent suspension levers an admin can pull: the user's own `is_active`, and - for
  // venue/staff accounts - their venue's `contract_status` (set via
  // AdminService.setAccountActive).
  private async assertUsableAccount(user: users): Promise<void> {
    if (!user.is_active) {
      throw new ForbiddenException('Account sospeso. Contatta il supporto.');
    }
    if ((user.role === 'venue' || user.role === 'staff') && user.venue_id) {
      const venue = await this.prisma.venues.findUnique({
        where: { id: user.venue_id },
        select: { contract_status: true },
      });
      if (venue?.contract_status === 'suspended') {
        throw new ForbiddenException(
          'Il locale associato a questo account è sospeso. Contatta il supporto.',
        );
      }
    }
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /** POST /auth/logout: revokes only the current session's refresh token. Idempotent and
   * DB-backed, so (unlike the old in-memory blacklist) it actually works across the
   * multiple concurrent instances a serverless deployment (Vercel) can run. */
  async logout(rawToken?: string): Promise<{ success: boolean }> {
    if (!rawToken) return { success: true };

    const tokenHash = this.hashRefreshToken(rawToken);
    await this.prisma.refresh_tokens.updateMany({
      where: { token_hash: tokenHash, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    return { success: true };
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    return this.prisma.refresh_tokens.findMany({
      where: {
        user_id: userId,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        created_at: true,
        expires_at: true,
        user_agent: true,
        ip: true,
      },
    });
  }

  async revokeSessionById(
    userId: string,
    sessionId: string,
  ): Promise<{ success: boolean }> {
    const row = await this.prisma.refresh_tokens.findUnique({
      where: { id: sessionId },
      select: { id: true, user_id: true, revoked_at: true },
    });

    // Ownership check: a session belongs to exactly one user. Report "not found" rather
    // than "forbidden" either way, so this endpoint can't be used to probe which session
    // ids exist for other users.
    if (!row || row.user_id !== userId) {
      throw new NotFoundException('Session not found');
    }

    if (!row.revoked_at) {
      await this.prisma.refresh_tokens.update({
        where: { id: sessionId },
        data: { revoked_at: new Date() },
      });
    }

    return { success: true };
  }

  /** "Logout everywhere". `exceptRawToken`, when passed, keeps the caller's own current
   * session alive (e.g. a "log out other devices" action from a settings screen). */
  async revokeAllSessions(
    userId: string,
    exceptRawToken?: string,
  ): Promise<{ success: boolean }> {
    const exceptTokenHash = exceptRawToken
      ? this.hashRefreshToken(exceptRawToken)
      : undefined;

    await this.prisma.refresh_tokens.updateMany({
      where: {
        user_id: userId,
        revoked_at: null,
        ...(exceptTokenHash ? { token_hash: { not: exceptTokenHash } } : {}),
      },
      data: { revoked_at: new Date() },
    });

    return { success: true };
  }

  async requestPasswordReset(identifier?: string, redirectTo?: string) {
    const normalizedIdentifier = this.normalizeIdentifier(identifier || '');
    if (!normalizedIdentifier) {
      throw new BadRequestException('identifier required');
    }

    const user = await this.findUserByIdentifier(normalizedIdentifier);

    // Always return a generic success message to avoid user enumeration.
    const genericResponse = {
      success: true,
      message:
        'Se l account esiste, riceverai istruzioni per il reset della password.',
    };

    if (!user) {
      return genericResponse;
    }

    if (this.isSupabaseForgotPasswordEnabled()) {
      const resolvedRedirectTo = this.getSupabaseResetRedirectUrl(redirectTo);
      let emailSent = false;

      try {
        await this.ensureSupabaseAuthUser(user.email);
        emailSent = await this.sendSupabasePasswordResetEmail(
          user.email,
          resolvedRedirectTo,
        );
      } catch (error) {
        this.logger.warn(
          `Supabase forgot-password setup failed for ${user.email}: ${String(error)}`,
        );
      }

      if (emailSent) {
        if (process.env.NODE_ENV !== 'production') {
          return {
            ...genericResponse,
            provider: 'supabase',
            email_sent: emailSent,
            redirect_to: resolvedRedirectTo,
          };
        }

        return genericResponse;
      }

      if (process.env.NODE_ENV === 'production') {
        return genericResponse;
      }

      this.logger.warn(
        `Supabase reset email non disponibile per ${user.email}: fallback locale attivo (dev only).`,
      );
    }

    const resetToken = this.jwtService.sign(
      {
        sub: user.id,
        type: 'password_reset',
        // Unique per issued token so resetPassword() can mark this exact token as consumed
        // and reject a second use, instead of the token staying valid for its whole TTL.
        jti: randomUUID(),
      },
      {
        expiresIn: `${this.passwordResetTokenTtlSeconds}s`,
      },
    );

    const emailSent = await this.sendPasswordResetEmail({
      email: user.email,
      name: user.name,
      token: resetToken,
    });

    if (process.env.NODE_ENV !== 'production') {
      return {
        ...genericResponse,
        provider: 'legacy',
        reset_token: resetToken,
        expires_in_seconds: this.passwordResetTokenTtlSeconds,
        email_sent: emailSent,
      };
    }

    if (!emailSent) {
      this.logger.warn(
        `Password reset requested for user ${user.id} but email could not be sent. Configure BREVO_API_KEY, BREVO_FROM_EMAIL and APP_RESET_PASSWORD_URL.`,
      );
    }

    return genericResponse;
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token) {
      throw new BadRequestException('token required');
    }

    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException(
        'La nuova password deve contenere almeno 6 caratteri',
      );
    }

    let payload: { sub?: string; type?: string; jti?: string; exp?: number };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new BadRequestException('Token reset non valido o scaduto');
    }

    if (!payload?.sub || payload?.type !== 'password_reset' || !payload?.jti) {
      throw new BadRequestException('Token reset non valido o scaduto');
    }

    // Atomically claim this token's jti. The `jti` primary key means a concurrent or
    // repeated attempt with the same token hits a unique-constraint violation here instead
    // of both succeeding - single-use is enforced by the database, not by a check-then-act
    // race in application code.
    try {
      await this.prisma.used_password_reset_tokens.create({
        data: {
          jti: payload.jti,
          expires_at: payload.exp
            ? new Date(payload.exp * 1000)
            : new Date(Date.now() + this.passwordResetTokenTtlSeconds * 1000),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(
          'Token reset già utilizzato: richiedine uno nuovo',
        );
      }
      throw error;
    }

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(newPassword, 10);

    // Same reasoning as changePassword: a password reset shouldn't leave a session from
    // before the reset (e.g. an attacker's, or a stolen device) still valid.
    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: payload.sub },
        data: { password_hash: hashedPassword },
      }),
      this.prisma.refresh_tokens.updateMany({
        where: { user_id: payload.sub, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    await this.touchUserActivity(payload.sub, new Date());

    return { success: true };
  }

  async resetPasswordFromSupabaseRecovery(
    accessToken: string,
    newPassword: string,
  ) {
    if (!accessToken) {
      throw new BadRequestException('access_token required');
    }

    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException(
        'La nuova password deve contenere almeno 6 caratteri',
      );
    }

    const email =
      await this.getEmailFromSupabaseRecoveryAccessToken(accessToken);

    const user = await this.prisma.users.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      throw new BadRequestException(
        'Nessun account NightHub associato alla recovery Supabase',
      );
    }

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(newPassword, 10);

    // Same reasoning as changePassword: a password reset shouldn't leave a session from
    // before the reset (e.g. an attacker's, or a stolen device) still valid.
    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: user.id },
        data: { password_hash: hashedPassword },
      }),
      this.prisma.refresh_tokens.updateMany({
        where: { user_id: user.id, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    await this.touchUserActivity(user.id, new Date());

    return { success: true };
  }

  // Authenticated change-password (distinct from the forgot/reset-password flow above,
  // which doesn't require knowing the current password). Revokes every other refresh
  // session on success - the same reasoning as a suspension: a password change should not
  // leave old sessions (e.g. a stolen device) still valid.
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword) {
      throw new BadRequestException('current_password required');
    }
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException(
        'La nuova password deve contenere almeno 6 caratteri',
      );
    }

    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const bcryptCompare = compare as (a: string, b: string) => Promise<boolean>;
    const valid = await bcryptCompare(currentPassword, user.password_hash);
    if (!valid) {
      throw new BadRequestException('Password attuale non corretta');
    }

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: { password_hash: hashedPassword },
      }),
      this.prisma.refresh_tokens.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    return { success: true };
  }

  // A hard `users.delete` throws a foreign-key violation the moment the account has any
  // reservation/entry/friendship/etc. (most of those relations have no onDelete: Cascade -
  // same class of bug as the one fixed on deleteEvent). Anonymizing + deactivating instead
  // of deleting sidesteps that entirely, and is also the more correct behavior here: a
  // venue's historical entry/revenue counts shouldn't disappear because one attendee later
  // deleted their account. Sessions are revoked so the account can't be used again.
  async deleteUser(userId: string) {
    const anonymizedSuffix = randomUUID();

    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: {
          is_active: false,
          email: `deleted-${anonymizedSuffix}@nighthub.deleted`,
          username: `deleted-${anonymizedSuffix}`,
          name: null,
          phone: null,
          avatar: null,
          push_token: null,
          location_sharing_enabled: false,
          last_latitude: null,
          last_longitude: null,
        },
      }),
      this.prisma.refresh_tokens.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);
  }

  // Called by the cleanup-tokens cron endpoint - purges rows that are inert but would
  // otherwise accumulate forever (nothing else deletes them).
  async cleanupExpiredTokens() {
    const now = new Date();
    const [refreshTokens, resetTokens] = await Promise.all([
      this.prisma.refresh_tokens.deleteMany({
        where: { expires_at: { lt: now } },
      }),
      this.prisma.used_password_reset_tokens.deleteMany({
        where: { expires_at: { lt: now } },
      }),
    ]);

    return {
      success: true,
      deleted_refresh_tokens: refreshTokens.count,
      deleted_reset_tokens: resetTokens.count,
    };
  }

  async setPushToken(userId: string, pushToken: string) {
    if (!pushToken) throw new BadRequestException('push_token required');

    await this.prisma.users.update({
      where: { id: userId },
      data: {
        push_token: pushToken,
        push_token_updated_at: new Date(),
      },
    });
  }

  /** POST /auth/push-subscription - registers/refreshes a Web Push subscription for this
   * device/browser. Unlike push_token (single column, Expo/mobile), a user can have any
   * number of these; `endpoint` is globally unique per browser+device, so re-subscribing
   * (e.g. after a permission re-grant) just updates the existing row via upsert. */
  async subscribeToPush(
    userId: string,
    subscription: {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      userAgent?: string;
    },
  ) {
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const authKey = String(subscription?.keys?.auth || '').trim();
    if (!endpoint || !p256dh || !authKey) {
      throw new BadRequestException(
        'endpoint, keys.p256dh and keys.auth are required',
      );
    }

    await this.prisma.push_subscriptions.upsert({
      where: { endpoint },
      update: {
        user_id: userId,
        p256dh,
        auth_key: authKey,
        user_agent: subscription.userAgent?.slice(0, 512),
        last_seen_at: new Date(),
      },
      create: {
        user_id: userId,
        endpoint,
        p256dh,
        auth_key: authKey,
        user_agent: subscription.userAgent?.slice(0, 512),
      },
    });

    return { success: true };
  }

  /** DELETE /auth/push-subscription - called on logout so a shared/borrowed device stops
   * receiving this account's notifications once signed out (see push_token's equivalent gap:
   * that single-column field is never cleared on logout at all). Scoped to the caller's own
   * userId so one user can't unsubscribe another's device by guessing an endpoint. */
  async unsubscribeFromPush(userId: string, endpoint: string) {
    if (!endpoint) return { success: true };

    await this.prisma.push_subscriptions.deleteMany({
      where: { endpoint, user_id: userId },
    });

    return { success: true };
  }
}

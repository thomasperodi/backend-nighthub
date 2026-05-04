import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { hash, compare } from 'bcrypt';
import { Prisma, UserRole, users } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

export type PublicUser = {
  id: string;
  email: string;
  username?: string | null;
  name?: string | null;
  avatar?: string | null;
  role: string;
  venue_id?: string | null;
  created_at?: Date | null;
};

export type LoginResponse = { access_token: string; user: PublicUser } | null;

// Simple in-memory revoked tokens store (for demo). For production use Redis or DB-backed store.
const revokedTokens = new Set<string>();

@Injectable()
export class AuthService {
  private readonly activityThrottleMs = 60 * 1000;
  private readonly passwordResetTokenTtlSeconds = 15 * 60;
  private readonly logger = new Logger(AuthService.name);

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

  private normalizeIdentifier(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase();
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

  async register(dto: RegisterDto): Promise<PublicUser> {
    const allowedRoles = new Set<string>(Object.values(UserRole));
    const desiredRole = (dto.role ?? UserRole.client)
      .toString()
      .trim()
      .toLowerCase();
    if (!allowedRoles.has(desiredRole)) {
      throw new BadRequestException('role invalid');
    }
    const role = desiredRole as UserRole;

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

    if ((role === UserRole.staff || role === UserRole.venue) && !dto.venue_id) {
      throw new BadRequestException('venue_id required for staff/venue');
    }
    if (role === UserRole.client && dto.venue_id) {
      throw new BadRequestException('venue_id not allowed for client');
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
          venue_id: dto.venue_id ?? undefined,
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

    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      venue_id: user.venue_id,
      created_at: user.created_at,
    };

    return publicUser;
  }

  async login(dto: LoginDto): Promise<LoginResponse> {
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

    await this.touchUserActivity(user.id, new Date());

    // Include venue_id in the token payload to enable efficient venue-scoped authorization.
    // Fallback DB lookup is still possible for older tokens.
    const payload = { sub: user.id, role: user.role, venue_id: user.venue_id };
    const access_token = this.jwtService.sign(payload, { expiresIn: '7d' });

    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      venue_id: user.venue_id,
      created_at: user.created_at,
    };

    return { access_token, user: publicUser };
  }

  async requestPasswordReset(identifier?: string) {
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

    const resetToken = this.jwtService.sign(
      {
        sub: user.id,
        type: 'password_reset',
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

    let payload: { sub?: string; type?: string };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new BadRequestException('Token reset non valido o scaduto');
    }

    if (!payload?.sub || payload?.type !== 'password_reset') {
      throw new BadRequestException('Token reset non valido o scaduto');
    }

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(newPassword, 10);

    await this.prisma.users.update({
      where: { id: payload.sub },
      data: { password_hash: hashedPassword },
    });

    await this.touchUserActivity(payload.sub, new Date());

    return { success: true };
  }

  // Revoke token (logout)
  logout(token?: string) {
    if (!token) return false;
    revokedTokens.add(token);
    return true;
  }

  isTokenRevoked(token?: string) {
    if (!token) return false;
    return revokedTokens.has(token);
  }

  async deleteUser(userId: string) {
    // remove related data first if needed, then delete user
    await this.prisma.users.delete({ where: { id: userId } });
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
}

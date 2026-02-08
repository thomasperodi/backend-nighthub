import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { hash, compare } from 'bcrypt';
import { UserRole, users } from '@prisma/client';
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
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<PublicUser> {
    const allowedRoles = new Set<string>(Object.values(UserRole));
    const desiredRole = (dto.role ?? UserRole.client).toString();
    const role = (
      allowedRoles.has(desiredRole) ? desiredRole : UserRole.client
    ) as UserRole;

    const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;
    const hashedPassword = await bcryptHash(dto.password, 10);
    const username = String(dto.username || '')
      .trim()
      .toLowerCase();
    if (!username) {
      throw new BadRequestException('username required');
    }

    const user = await this.prisma.users.create({
      data: {
        email: dto.email,
        username,
        password_hash: hashedPassword,
        role,
      },
    });

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
    const user: users | null = await this.prisma.users.findUnique({
      where: { email: dto.email },
    });
    if (!user) return null;

    const bcryptCompare = compare as (a: string, b: string) => Promise<boolean>;
    const valid = await bcryptCompare(dto.password, user.password_hash);
    if (!valid) return null;

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
}

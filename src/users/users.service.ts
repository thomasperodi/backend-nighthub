import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { UpdateMeDto } from './dto/update-me.dto';

export interface UploadedAvatarFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

type CurrentUserRecord = {
  id: string;
  email: string;
  username: string | null;
  role: string;
  name: string | null;
  phone: string | null;
  avatar: string | null;
  venue_id: string | null;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  private async findActivePrMembership(userId: string) {
    return this.prisma.venue_pr_memberships.findFirst({
      where: { user_id: userId, is_active: true },
      select: { venue_id: true },
    });
  }

  private resolvePrDisplayContext(
    baseRole: string,
    activeMembership: { venue_id: string } | null,
  ): { role: string; pr_venue_id: string | null } {
    if (!activeMembership) {
      return { role: baseRole, pr_venue_id: null };
    }

    return { role: 'pr', pr_venue_id: activeMembership.venue_id };
  }

  private formatCurrentUser(
    user: CurrentUserRecord,
    activeMembership: { venue_id: string } | null,
  ) {
    const prContext = this.resolvePrDisplayContext(user.role, activeMembership);

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: prContext.role,
      name: user.name,
      phone: user.phone,
      avatar: user.avatar,
      venue_id: user.venue_id,
      pr_venue_id: prContext.pr_venue_id,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private async getCurrentUserRecord(
    userId: string,
  ): Promise<CurrentUserRecord> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        name: true,
        phone: true,
        avatar: true,
        venue_id: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private normalizeManagedImagePath(
    value: string | null | undefined,
    prefix: 'users' | 'venues',
  ): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const input = String(value).trim();
    if (!input) return null;

    if (/^data:image\//i.test(input)) {
      throw new BadRequestException(
        'image must be uploaded before updating the profile',
      );
    }

    const sanitizedInput = input.replace(/[?#].*$/, '');
    const match = new RegExp(
      `(^|/)(${prefix}/[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp))$`,
      'i',
    ).exec(sanitizedInput);

    if (!match?.[2]) {
      throw new BadRequestException(
        `image must be a valid ${prefix} storage path`,
      );
    }

    return match[2];
  }

  private isManagedImagePath(
    value: string | null | undefined,
    prefix: 'users' | 'venues',
  ): boolean {
    if (!value) return false;
    return new RegExp(
      `(^|/)${prefix}/[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp)$`,
      'i',
    ).test(value.replace(/[?#].*$/, ''));
  }

  async getMe(userId: string) {
    const [user, activeMembership] = await Promise.all([
      this.getCurrentUserRecord(userId),
      this.findActivePrMembership(userId),
    ]);
    return this.formatCurrentUser(user, activeMembership);
  }

  async updateMe(userId: string, updates: UpdateMeDto) {
    const currentUser = await this.getCurrentUserRecord(userId);
    const data: Prisma.usersUpdateInput = {};

    if (updates.name !== undefined) {
      const name = String(updates.name || '').trim();
      data.name = name || null;
    }

    if (updates.phone !== undefined) {
      const phone = String(updates.phone || '').trim();
      if (phone && !/^\+?[0-9\-\s()]{6,}$/.test(phone)) {
        throw new BadRequestException('phone format is not valid');
      }
      data.phone = phone || null;
    }

    const normalizedAvatar = this.normalizeManagedImagePath(
      updates.avatar,
      'users',
    );
    if (normalizedAvatar !== undefined) {
      data.avatar = normalizedAvatar;
    }

    const [updatedUser, activeMembership] = await Promise.all([
      this.prisma.users.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          name: true,
          phone: true,
          avatar: true,
          venue_id: true,
          created_at: true,
          updated_at: true,
        },
      }),
      this.findActivePrMembership(userId),
    ]);

    if (
      normalizedAvatar !== undefined &&
      currentUser.avatar &&
      currentUser.avatar !== updatedUser.avatar &&
      this.isManagedImagePath(currentUser.avatar, 'users')
    ) {
      void this.storage
        .deletePublicImage(currentUser.avatar)
        .catch(() => undefined);
    }

    return this.formatCurrentUser(updatedUser, activeMembership);
  }

  async uploadAvatar(file?: UploadedAvatarFile) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('file must be an image');
    }

    const ext = (() => {
      const match = /\.(png|jpe?g|webp)$/i.exec(file.originalname || '');
      if (match) return match[1].toLowerCase();
      if (file.mimetype === 'image/png') return 'png';
      if (file.mimetype === 'image/webp') return 'webp';
      return 'jpg';
    })();

    const { pathPromise } = this.storage.uploadPublicImageFromBuffer({
      prefix: 'users',
      buffer: file.buffer,
      contentType: file.mimetype,
      ext,
    });

    const path = await pathPromise;
    return { path };
  }

  async createAvatarSignedUpload(params?: {
    ext?: string;
    contentType?: string;
  }) {
    return this.storage.createSignedUploadForPublicImage({
      prefix: 'users',
      ext: params?.ext,
      contentType: params?.contentType,
    });
  }
}

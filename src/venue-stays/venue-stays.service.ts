import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VenueStaysService {
  constructor(private readonly prisma: PrismaService) {}

  async checkpoint(params: {
    user_id: string;
    venue_id: string;
    event_type: 'enter' | 'exit';
    timestamp?: string;
  }) {
    const { user_id, venue_id, event_type, timestamp } = params;

    if (!user_id) throw new BadRequestException('user_id required');
    if (!venue_id) throw new BadRequestException('venue_id required');

    const enteredAt = timestamp ? new Date(timestamp) : new Date();
    if (Number.isNaN(enteredAt.getTime())) {
      throw new BadRequestException('timestamp must be ISO8601');
    }

    if (event_type === 'enter') {
      const openStay = await this.prisma.venue_stays.findFirst({
        where: { user_id, venue_id, exited_at: null },
        orderBy: { entered_at: 'desc' },
      });

      if (openStay) return openStay;

      return this.prisma.venue_stays.create({
        data: {
          user_id,
          venue_id,
          entered_at: enteredAt,
        },
      });
    }

    const openStay = await this.prisma.venue_stays.findFirst({
      where: { user_id, venue_id, exited_at: null },
      orderBy: { entered_at: 'desc' },
    });

    if (!openStay) {
      throw new NotFoundException('No open stay for this venue');
    }

    const exitedAt = enteredAt;
    const duration = Math.max(0, exitedAt.getTime() - openStay.entered_at.getTime());

    return this.prisma.venue_stays.update({
      where: { id: openStay.id },
      data: {
        exited_at: exitedAt,
        duration_ms: duration,
      },
    });
  }

  async list(params: {
    user_id?: string;
    venue_id?: string;
    limit?: number;
  }) {
    const take = Math.min(Math.max(params.limit ?? 100, 1), 500);

    return this.prisma.venue_stays.findMany({
      where: {
        user_id: params.user_id,
        venue_id: params.venue_id,
      },
      orderBy: { entered_at: 'desc' },
      take,
    });
  }
}

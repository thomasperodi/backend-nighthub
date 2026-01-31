import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PromoStatus } from '@prisma/client';

@Injectable()
export class PromosService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveByEvent(eventId: string) {
    return this.prisma.promos.findMany({
      where: { event_id: eventId, status: PromoStatus.active },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        title: true,
        description: true,
        discount_type: true,
        discount_value: true,
        status: true,
        created_at: true,
      },
    });
  }

  async listActiveByVenue(venueId: string) {
    return this.prisma.promos.findMany({
      where: { venue_id: venueId, status: PromoStatus.active },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        title: true,
        description: true,
        discount_type: true,
        discount_value: true,
        status: true,
        created_at: true,
      },
    });
  }

  async listPromos() {
    return this.prisma.promos.findMany({ orderBy: { created_at: 'desc' } });
  }

  async getPromo(id: string) {
    const p = await this.prisma.promos.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Promo not found');
    return p;
  }

  async listByEvent(eventId: string) {
    return this.prisma.promos.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listByVenue(venueId: string) {
    return this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async createPromo(input: Partial<Prisma.promosCreateInput>) {
    const p = await this.prisma.promos.create({ data: input as any });
    return p;
  }

  async updatePromo(id: string, updates: Partial<Prisma.promosUpdateInput>) {
    await this.getPromo(id);
    return this.prisma.promos.update({ where: { id }, data: updates as any });
  }

  async deletePromo(id: string) {
    await this.getPromo(id);
    return this.prisma.promos.delete({ where: { id } });
  }
}

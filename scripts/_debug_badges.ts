import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { BadgesService } from '../src/badges/badges.service';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.users.findFirst({ where: { role: 'client' } });
  if (!user) {
    console.log('No client user found');
    return;
  }
  console.log('Testing with user', user.id, user.email);

  const badgesService = new BadgesService(prisma as any);
  try {
    const result = await badgesService.evaluateForUser(user.id);
    console.log('evaluateForUser OK, unlocked:', result.length);
  } catch (error) {
    console.error('evaluateForUser FAILED');
    console.error(error);
  }
}

main().finally(() => prisma.$disconnect());

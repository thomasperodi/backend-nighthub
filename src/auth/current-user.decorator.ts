import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from './types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req?.user as RequestUser | undefined;
  },
);

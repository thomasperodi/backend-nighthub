import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ACCESS_TOKEN_TTL_SECONDS, getJwtSecret } from './jwt.config';

@Module({
  imports: [
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  // JwtModule is re-exported so other modules that need to verify the access token (e.g.
  // EventsModule) import AuthModule instead of registering their own JwtModule with a
  // separately-sourced secret/expiry.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}

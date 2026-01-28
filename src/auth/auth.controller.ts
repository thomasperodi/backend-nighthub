import {
  Controller,
  Post,
  Body,
  Headers,
  Delete,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto';
import { JwtService } from '@nestjs/jwt';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private jwtService: JwtService,
  ) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('logout')
  logout(@Headers('authorization') authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    const ok = this.authService.logout(token);
    return { success: ok };
  }

  @Delete('me')
  async deleteMe(@Headers('authorization') authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    let payload: unknown;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    if (!payload || typeof payload !== 'object' || !('sub' in payload)) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { sub } = payload as { sub?: string };
    if (!sub) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    await this.authService.deleteUser(sub);
    // revoke token
    this.authService.logout(token);

    return { success: true };
  }
}

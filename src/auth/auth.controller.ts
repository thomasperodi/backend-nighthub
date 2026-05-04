import { Controller, Post, Body, Headers, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  PushTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ResetPasswordSupabaseDto,
} from './dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './types';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @Public()
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('forgot-password')
  @Public()
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    const identifier = dto.identifier || dto.email || dto.username;
    return this.authService.requestPasswordReset(identifier, dto.redirect_to);
  }

  @Post('reset-password')
  @Public()
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.new_password);
  }

  @Post('reset-password-supabase')
  @Public()
  resetPasswordSupabase(@Body() dto: ResetPasswordSupabaseDto) {
    return this.authService.resetPasswordFromSupabaseRecovery(
      dto.access_token,
      dto.new_password,
    );
  }

  @Post('logout')
  logout(@Headers('authorization') authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    const ok = this.authService.logout(token);
    return { success: ok };
  }

  @Post('push-token')
  async setPushToken(
    @Body() dto: PushTokenDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.authService.setPushToken(user.id, dto.push_token);
    return { success: true };
  }

  @Post('activity')
  async touchActivity(@CurrentUser() user: RequestUser) {
    await this.authService.touchUserActivity(user.id);
    return { success: true };
  }

  @Delete('me')
  async deleteMe(
    @CurrentUser() user: RequestUser,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authService.deleteUser(user.id);

    // revoke current token too (best-effort)
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    this.authService.logout(token);

    return { success: true };
  }
}

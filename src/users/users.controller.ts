import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { RequestUser } from '../auth/types';
import { UpdateMeDto } from './dto/update-me.dto';
import { UsersService } from './users.service';
import type { UploadedAvatarFile } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @Roles('client', 'staff', 'venue', 'admin')
  getMe(@CurrentUser() user: RequestUser) {
    return this.usersService.getMe(user.id);
  }

  @Patch('me')
  @Roles('client', 'staff', 'venue', 'admin')
  updateMe(@CurrentUser() user: RequestUser, @Body() body: UpdateMeDto) {
    return this.usersService.updateMe(user.id, body);
  }

  @Post('avatar')
  @Roles('client', 'staff', 'venue', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  uploadAvatar(@UploadedFile() file?: UploadedAvatarFile) {
    return this.usersService.uploadAvatar(file);
  }

  @Post('avatar/signed')
  @Roles('client', 'staff', 'venue', 'admin')
  createAvatarSignedUpload(
    @Headers('authorization') authorization?: string,
    @Body() body?: { ext?: string; contentType?: string },
  ) {
    void authorization;
    return this.usersService.createAvatarSignedUpload(body);
  }
}

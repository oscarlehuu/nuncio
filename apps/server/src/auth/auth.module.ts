import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthTokenService } from './auth-token.service';
import { TailscaleModule } from '../tailscale/tailscale.module';

@Module({
  imports: [TailscaleModule],
  controllers: [AuthController],
  providers: [AuthTokenService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthTokenService],
})
export class AuthModule {}

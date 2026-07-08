import { Controller, Param, Post } from '@nestjs/common';
import { DispatcherService } from './dispatcher.service';

@Controller('dispatcher')
export class DispatcherController {
  constructor(private readonly dispatcher: DispatcherService) {}

  @Post('draft-now')
  draftNow() {
    return this.dispatcher.draftNow();
  }

  @Post('proposals/:id/approve')
  approve(@Param('id') id: string) {
    return this.dispatcher.approve(id);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('endpoints') createEndpoint(@Body() body: Record<string, unknown>) {
    return this.admin.createEndpoint(body);
  }
  @Get('endpoints') listEndpoints() {
    return this.admin.listEndpoints();
  }
  @Patch('endpoints/:id') updateEndpoint(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.admin.updateEndpoint(id, body);
  }
  @Post('destinations') createDestination(
    @Body() body: Record<string, unknown>,
  ) {
    return this.admin.createDestination(body);
  }
  @Get('destinations') listDestinations() {
    return this.admin.listDestinations();
  }
  @Patch('destinations/:id') updateDestination(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.admin.updateDestination(id, body);
  }
  @Patch(':resource/:id/active')
  setActive(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.admin.setActive(resource, id, body);
  }

  @Get('events')
  listEvents(@Query('limit') limit?: string) {
    return this.admin.listEvents(limit);
  }

  @Get('deliveries')
  listDeliveries(@Query('limit') limit?: string) {
    return this.admin.listDeliveries(limit);
  }

  @Post('deliveries/:id/replay')
  replay(@Param('id') id: string) {
    return this.admin.replayDelivery(id);
  }
}

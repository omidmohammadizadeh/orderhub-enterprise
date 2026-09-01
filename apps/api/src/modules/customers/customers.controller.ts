import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  CustomersService,
  CreateCustomerDto,
  UpdateCustomerDto,
  AddAddressDto,
  ValidatePromoDto,
} from './customers.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { SocketService } from '../../infrastructure/socket/socket.service';
import { extractVoipPhone } from './voip-phone.util';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Headers,
} from '@nestjs/common';

@ApiTags('customers')
@ApiBearerAuth()
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  private readonly logger = new Logger(CustomersController.name);

  constructor(
    private readonly customers: CustomersService,
    private readonly socket: SocketService,
  ) {}

  // ── Caller-ID ─────────────────────────────────────────────────────────
  // The caller-ID hub tablet (Comet USB reader) posts here when the shop's
  // landline rings. We match the number against past orders and broadcast
  // the caller card to every POS tablet in the location's room.
  @Post('caller-id/ring')
  @ApiOperation({
    summary: "Landline is ringing — look up the caller and broadcast to the location's POS tablets",
  })
  async callerIdRing(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { locationId: string; phone: string },
  ) {
    const match = await this.customers.lookupByPhone(user.tenantId, body.phone);
    const payload = {
      locationId: body.locationId,
      phone: body.phone,
      at: new Date().toISOString(),
      match,
    };
    this.socket.emitToLocation(body.locationId, 'callerid:ring', payload);
    return payload;
  }

  // VoIP variant (Phase BB-3): shops on digital lines skip the Comet — the
  // provider (Twilio / sipgate / Telnyx / generic) calls this webhook on an
  // incoming call. Public + shared-secret because providers can't do our JWT;
  // unset VOIP_WEBHOOK_KEY disables the endpoint entirely.
  @Public()
  @Post('caller-id/voip/:locationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'VoIP incoming-call webhook — same caller popup as the Comet path, no hardware',
  })
  async voipRing(
    @Param('locationId') locationId: string,
    @Body() body: Record<string, unknown>,
    @Query('key') key?: string,
    @Headers('x-voip-key') headerKey?: string,
  ) {
    const expected = process.env.VOIP_WEBHOOK_KEY;
    if (!expected) throw new ForbiddenException('VoIP caller-ID is not enabled');
    if (key !== expected && headerKey !== expected) {
      throw new ForbiddenException('Bad key');
    }

    const phone = extractVoipPhone(body);
    if (!phone) throw new BadRequestException('No caller number in payload');

    const tenantId = await this.customers.tenantForLocation(locationId);
    if (!tenantId) throw new NotFoundException('Unknown location');

    const match = await this.customers.lookupByPhone(tenantId, phone);
    const payload = { locationId, phone, at: new Date().toISOString(), match };
    this.socket.emitToLocation(locationId, 'callerid:ring', payload);
    // What number actually reached the tills, and how long it was.
    //
    // Without this the only way to check a caller-ID complaint was to read the
    // number off the till itself — the request log showed a 200 and nothing
    // else. A wrong number here is nearly always the sender mangling it before
    // it arrives (a notification carrying the caller twice, joined into one
    // over-long run), and the digit count is what makes that obvious at a
    // glance: a UK number is 11, anything at the 15 ceiling is two stuck
    // together.
    const digits = phone.replace(/\D/g, '').length;
    this.logger.log(
      `VoIP ring → location ${locationId}: ${phone} (${digits} digits` +
        (digits >= 15 ? ', SUSPICIOUS — at the length ceiling' : '') +
        `)${match ? ` matched customer ${match.id}` : ' no match'}`,
    );
    return { ok: true };
  }

  @Get()
  @ApiOperation({ summary: 'List customers with optional search' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.customers.findAll(user.tenantId, {
      search,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  // NB: declared before ":customerId" so "directory" isn't captured as an id.
  @Get('directory')
  @ApiOperation({
    summary:
      'Order-derived customer directory — every customer across channels, filterable by channel + new/returning segment',
  })
  directory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('channel') channel?: string,
    @Query('segment') segment?: string,
    @Query('search') search?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.customers.directory(user.tenantId, {
      channel,
      segment,
      search,
      locationId,
      userId: user.userId,
      role: user.role,
    });
  }

  // Same lookup the landline caller-ID popup runs, reachable on demand so the
  // POS can offer it when an operator TYPES a number — a phone order taken at
  // the counter should recognise a regular the same way a ringing one does.
  //
  // Declared above @Get(":customerId") deliberately: Nest matches in
  // declaration order, so below it "lookup" would be read as a customer id.
  @Get('lookup')
  @ApiOperation({
    summary: 'Find a returning customer by phone number (name + past addresses)',
  })
  lookup(@CurrentUser() user: AuthenticatedUser, @Query('phone') phone?: string) {
    // Tenant-scoped through CurrentUser, exactly as caller-id/ring is — the
    // number comes from the caller but the tenant never does.
    return this.customers.lookupByPhone(user.tenantId, phone ?? '');
  }

  @Get(':customerId')
  @ApiOperation({ summary: 'Get customer profile' })
  findOne(@Param('customerId') customerId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.findOne(customerId, user.tenantId);
  }

  @Post()
  @Roles('MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: 'Create a customer manually' })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.create(user.tenantId, dto);
  }

  @Patch(':customerId')
  @Roles('MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: 'Update customer profile' })
  update(
    @Param('customerId') customerId: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.update(customerId, user.tenantId, dto);
  }

  @Get(':customerId/orders')
  @ApiOperation({ summary: 'Get customer order history' })
  getOrders(
    @Param('customerId') customerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.customers.getOrderHistory(customerId, user.tenantId, {
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get(':customerId/loyalty')
  @ApiOperation({ summary: 'Get customer loyalty account' })
  getLoyalty(@Param('customerId') customerId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.getLoyalty(customerId, user.tenantId);
  }

  @Post(':customerId/loyalty/adjust')
  @Roles('MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually adjust loyalty points' })
  adjustPoints(
    @Param('customerId') customerId: string,
    @Body() body: { delta: number; reason: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.adjustLoyaltyPoints(customerId, user.tenantId, body.delta, body.reason);
  }

  @Post(':customerId/addresses')
  @ApiOperation({ summary: 'Add address to customer' })
  addAddress(
    @Param('customerId') customerId: string,
    @Body() dto: AddAddressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.addAddress(customerId, user.tenantId, dto);
  }

  @Delete(':customerId/addresses/:addressId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove customer address' })
  removeAddress(
    @Param('customerId') customerId: string,
    @Param('addressId') addressId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.removeAddress(customerId, addressId, user.tenantId);
  }
}

// ── Promo Codes controller (separate tag) ─────────────────────────────────────
@ApiTags('promo-codes')
@ApiBearerAuth()
@Controller({ path: 'promo-codes', version: '1' })
export class PromoCodesController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'List all promo codes for tenant' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.customers.listPromos(user.tenantId);
  }

  @Post()
  @Roles('MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: 'Create a promo code' })
  create(
    @Body()
    dto: {
      code: string;
      type: string;
      value: number;
      description?: string;
      minOrderValue?: number;
      maxUses?: number;
      expiresAt?: string;
      locationIds?: string[];
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.createPromo(user.tenantId, dto);
  }

  @Post('validate')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a promo code (public — used during checkout)' })
  validate(@Body() dto: ValidatePromoDto & { tenantId: string }) {
    return this.customers.validatePromo(dto.tenantId, dto);
  }

  @Patch(':promoId/toggle')
  @Roles('MANAGER', 'TENANT_OWNER', 'PLATFORM_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle promo code active state' })
  toggle(@Param('promoId') promoId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.togglePromo(promoId, user.tenantId);
  }
}

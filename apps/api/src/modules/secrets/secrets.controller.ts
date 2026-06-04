import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SecretsService } from "./secrets.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Phase AP — System Secrets vault routes.
//
// All gated to PLATFORM_ADMIN. The reveal + write routes also require a
// short-lived "unlock" JWT in X-Secrets-Unlock, issued by
// POST /v1/secrets/unlock after re-entering the admin password.

@ApiTags("secrets")
@ApiBearerAuth()
@BillingExempt()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "secrets", version: "1" })
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get("status")
  @ApiOperation({ summary: "Is the vault configured?" })
  status() {
    return { enabled: this.secrets.isEnabled() };
  }

  @Post("unlock")
  @ApiOperation({ summary: "Re-enter admin password → unlock JWT" })
  @HttpCode(HttpStatus.OK)
  unlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { password: string },
  ) {
    return this.secrets.unlock(user.userId, user.tenantId, body.password);
  }

  @Get()
  @ApiOperation({ summary: "List secret metadata (NO values)" })
  list() {
    return this.secrets.list();
  }

  @Get(":key/value")
  @ApiOperation({
    summary: "Reveal a single secret value (requires X-Secrets-Unlock header)",
  })
  async reveal(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Headers("x-secrets-unlock") unlockToken?: string,
  ) {
    await this.secrets.assertUnlocked(user.userId, unlockToken);
    return this.secrets.reveal(user.userId, user.tenantId, key);
  }

  @Put(":key")
  @ApiOperation({ summary: "Create or replace a secret value" })
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Body()
    body: {
      value: string;
      label?: string;
      description?: string;
      category?: string;
    },
    @Headers("x-secrets-unlock") unlockToken?: string,
  ) {
    await this.secrets.assertUnlocked(user.userId, unlockToken);
    return this.secrets.upsert(user.userId, user.tenantId, { key, ...body });
  }

  @Delete(":key")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a secret" })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Headers("x-secrets-unlock") unlockToken?: string,
  ) {
    await this.secrets.assertUnlocked(user.userId, unlockToken);
    return this.secrets.remove(user.userId, user.tenantId, key);
  }
}

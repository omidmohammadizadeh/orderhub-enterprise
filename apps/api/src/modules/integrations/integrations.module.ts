import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CredentialEncryptionService } from './credential-encryption.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, CredentialEncryptionService],
  exports: [IntegrationsService, CredentialEncryptionService],
})
export class IntegrationsModule {}

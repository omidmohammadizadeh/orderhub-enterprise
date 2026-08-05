import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { UploadsModule } from "../uploads/uploads.module";

@Module({
  // Phase AU — IntegrationsModule exports CredentialEncryptionService
  // which LocationsService uses to encrypt the pasted HubRise access
  // token before it hits the database.
  imports: [IntegrationsModule, UploadsModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}

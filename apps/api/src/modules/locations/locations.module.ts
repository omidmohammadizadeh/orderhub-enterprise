import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { UploadsModule } from "../uploads/uploads.module";
import { LocationHygieneService } from "../hygiene/location-hygiene.service";

@Module({
  // Phase AU — IntegrationsModule exports CredentialEncryptionService
  // which LocationsService uses to encrypt the pasted HubRise access
  // token before it hits the database.
  imports: [IntegrationsModule, UploadsModule],
  controllers: [LocationsController],
  // LocationHygieneService — the storefront's FSA badge + its nightly refresh.
  providers: [LocationsService, LocationHygieneService],
  exports: [LocationsService],
})
export class LocationsModule {}

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ContractsService } from "./contracts.service";
import { ContractPdfService } from "./contract-pdf.service";
import { ContractsController } from "./contracts.controller";
import { ContractsPublicController } from "./contracts-public.controller";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";

// SubscriptionsModule is imported for its SubscriptionsService: the Subscribe
// button on a signed contract goes through the same setPlan the dashboard's
// subscription page uses, so a contract-started subscription is the identical
// object an operator would have created by hand and shows up in the same tab.
@Module({
  imports: [ConfigModule, SubscriptionsModule],
  controllers: [ContractsController, ContractsPublicController],
  providers: [ContractsService, ContractPdfService, PrismaService],
  exports: [ContractsService],
})
export class ContractsModule {}

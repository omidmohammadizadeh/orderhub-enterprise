import { Injectable } from "@nestjs/common";
import { UberEatsAdapter } from "./adapters/uber-eats.adapter";
import { DeliverooAdapter } from "./adapters/deliveroo.adapter";
import { JustEatAdapter } from "./adapters/just-eat.adapter";
import { HubRiseAdapter } from "./adapters/hubrise.adapter";
import type { BaseWebhookAdapter } from "./adapters/base.adapter";

@Injectable()
export class WebhookAdapterFactory {
  private readonly adapters = new Map<string, BaseWebhookAdapter>();

  constructor(
    uberEats: UberEatsAdapter,
    deliveroo: DeliverooAdapter,
    justEat: JustEatAdapter,
    hubrise: HubRiseAdapter,
  ) {
    this.adapters.set("UBER_EATS", uberEats);
    this.adapters.set("DELIVEROO", deliveroo);
    this.adapters.set("JUST_EAT", justEat);
    this.adapters.set("HUBRISE", hubrise);
  }

  get(platform: string): BaseWebhookAdapter | undefined {
    return this.adapters.get(platform);
  }
}

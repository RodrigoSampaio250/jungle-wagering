import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await this.orm.em.fork().execute("SELECT 1");

      return {
        status: "ok",
        database: "up",
      };
    } catch {
      throw new ServiceUnavailableException({
        status: "unavailable",
        database: "down",
      });
    }
  }
}
import {
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: async (): Promise<MikroORM> => {
        return MikroORM.init(config);
      },
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
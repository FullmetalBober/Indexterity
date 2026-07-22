import { Controller } from "@nestjs/common";
import { contract } from "@repo/contracts";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";

// Implements the shared ts-rest contract — same types the web client consumes.
@Controller()
export class ClustersController {
  @TsRestHandler(contract.listClusters)
  listClusters() {
    return tsRestHandler(contract.listClusters, () => Promise.resolve({ status: 200, body: [] }));
  }
}

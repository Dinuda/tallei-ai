import { z } from "zod";

import {
  BUILD_PHASES,
  type ConductorBuildPhase,
} from "@tallei/shared/conductor-build-phase.js";

export { BUILD_PHASES, type ConductorBuildPhase };

export const buildPhaseSchema = z.enum(BUILD_PHASES);
